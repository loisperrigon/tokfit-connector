"""Recognize a single kernel finish in the native Responses continuation."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import json
import re
from typing import Any
import uuid

from runtime.completion import FINISH_PREFIX, finish_tag

# Exactly one invocation. No executable substitution, aliases, trailing work or parallel calls.
TOOL = r"mcp__[A-Za-z0-9_]+__agir"
# Decode only primitive string literals, never evaluate JavaScript. JSON escapes,
# Python embedded in template literals and single-quoted strings are common.
QUOTED = r"""(?:"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*'|`(?:[^`\\$]|\$(?!\{)|\\[\s\S])*`)"""
SCRIPT = re.compile(r"\s*text\s*\(\s*await\s+tools\.(" + TOOL + r")\s*\(\s*\{\s*(?:code|\"code\")\s*:\s*("
                    + QUOTED + r")\s*,?\s*\}\s*\)\s*\)\s*;?\s*")
WIRE = re.compile(r"Script completed\nWall time [0-9.]+ seconds\nOutput:\n")
ESCAPES = {"n": "\n", "t": "\t", "b": "\b", "r": "\r", "f": "\f", "v": "\v",
           "'": "'", '"': '"', "`": "`", "\\": "\\", "/": "/", "$": "$"}


def literal_value(literal: str) -> str | None:
    value = literal[1:-1].replace("\r\n", "\n").replace("\r", "\n")
    try:
        def escape(match: re.Match[str]) -> str:
            raw = match[1]
            if raw.startswith(("u", "x")) and len(raw) > 1:
                return chr(int(raw[1:], 16))
            return ESCAPES[raw]

        return re.sub(r"\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|[\s\S])", escape, value)
    except KeyError:
        return None


def source_of(item: dict[str, Any]) -> str | None:
    if item.get("type") == "function_call":
        name = item.get("name")
        if name == "agir":
            name = str(item.get("namespace", "")) + "__agir"
        if not isinstance(name, str) or not re.fullmatch(TOOL, name):
            return None
        raw = item.get("arguments")
        if not isinstance(raw, str) or len(raw) > 131072:
            return None
        try:
            args = json.loads(raw)
        except (ValueError, RecursionError):
            return None
        source = args.get("code") if isinstance(args, dict) else None
    elif (item.get("type") == "custom_tool_call" and item.get("namespace") in ("functions", None)
          and item.get("name") == "exec"):
        script = item.get("input")
        if not isinstance(script, str) or len(script) > 131072:
            return None
        match = SCRIPT.fullmatch(script)
        if not match:
            return None
        literal = match[2]
        source = literal_value(literal)
    else:
        return None
    return source if isinstance(source, str) and "finish" in source else None


def context(body: dict[str, Any]) -> bytes | None:
    items = body.get("input")
    text = body.get("text", {})
    if not isinstance(text, dict) or not isinstance(text.get("format", {}), dict):
        return None
    if (not isinstance(body.get("prompt_cache_key"), str) or not body["prompt_cache_key"]
            or body.get("previous_response_id") or body.get("stream") is not True
            or not isinstance(items, list) or text.get("format", {}).get("type", "text") != "text"
            or not all(isinstance(item, dict) for item in items)):
        return None
    messages = [item for item in items if item.get("role") in ("user", "developer", "system")]
    data = [body.get(k) for k in ("model", "prompt_cache_key", "instructions", "reasoning", "text", "tool_choice")]
    return hashlib.sha256(json.dumps([data, messages], sort_keys=True).encode()).digest()


@dataclass(frozen=True)
class Call:
    call_id: str
    kind: str
    tool: str
    source: str

    @classmethod
    def read(cls, item: dict[str, Any]) -> Call | None:
        call_id = item.get("call_id")
        source = source_of(item)
        if not source or not isinstance(call_id, str) or not 0 < len(call_id) <= 256:
            return None
        if item["type"] == "custom_tool_call":
            match = SCRIPT.fullmatch(item["input"])
            assert match is not None
            tool = match[1]
        else:
            tool = item["name"] if item["name"] != "agir" else item["namespace"] + "__agir"
        return cls(call_id, item["type"], tool, source)

    def reply(self, body: dict[str, Any], key: str) -> str | None:
        items = body.get("input")
        if not isinstance(items, list) or len(items) < 2 or not all(isinstance(x, dict) for x in items[-2:]):
            return None
        call, result = items[-2:]
        if (Call.read(call) != self or result.get("type") != self.kind + "_output"
                or result.get("call_id") != self.call_id):
            return None
        output = result.get("output")
        if not isinstance(output, list) or len(output) < 2:
            return None
        if self.kind == "custom_tool_call":
            if (len(output) != 2 or not all(isinstance(x, dict) and x.get("type") == "input_text"
                                            and isinstance(x.get("text"), str) for x in output)
                    or not WIRE.fullmatch(output[0]["text"])):
                return None
            try:
                wrapped = json.loads(output[1]["text"])
            except (ValueError, RecursionError):
                return None
            if not isinstance(wrapped, dict) or wrapped.get("isError") is not False:
                return None
            output = wrapped.get("content")
            kind = "text"
        else:
            kind = "input_text"
        if not isinstance(output, list) or len(output) < 3:
            return None
        end, proof = output[-2:]
        if not all(isinstance(x, dict) and x.get("type") == kind and isinstance(x.get("text"), str)
                   for x in (end, proof)):
            return None
        marker, sep, reply = end["text"].partition("\n")
        if not sep or marker != "[finished]" or not 0 < len(reply) <= 32768:
            return None
        item_id, thread_id = call.get("id"), body.get("prompt_cache_key")
        if not isinstance(item_id, str) or not isinstance(thread_id, str):
            return None
        expected = FINISH_PREFIX + finish_tag(key, thread_id, item_id, self.source, reply)
        return reply if proof["text"].isascii() and hmac.compare_digest(proof["text"], expected) else None


def response(reply: str) -> bytes:
    identifier = "resp_" + uuid.uuid4().hex
    item = {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant",
            "status": "completed", "content": [{"type": "output_text", "text": reply, "annotations": []}]}
    events = [{"type": "response.created", "response": {"id": identifier, "status": "in_progress", "output": []}},
              {"type": "response.output_item.done", "output_index": 0, "item": item},
              {"type": "response.completed", "response": {"id": identifier, "status": "completed", "output": [item],
               "usage": {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}}}]
    return b"".join(("data: " + json.dumps(event) + "\n\n").encode() for event in events)
