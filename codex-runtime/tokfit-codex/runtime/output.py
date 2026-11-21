"""Local output mechanism; thresholds and command lists come from the service.

Only successful, complete terminal output with a known native envelope is
eligible. Unknown formats, running jobs, images, errors and explicit filters
always pass through. No content is sent to the optimization service.
"""
from __future__ import annotations
import copy
import json
import re

RAW = "TOKFIT_RAW=1"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")


class OutputPolicy:
    def __init__(self, rules: dict[str, object]) -> None:
        self.numbers: dict[str, int] = {}
        self.words: dict[str, frozenset[str]] = {}
        for name in ("long", "head", "tail", "kept", "repeat"):
            value = rules.get(name)
            if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= 10000:
                raise ValueError("Invalid output policy")
            self.numbers[name] = value
        for name in ("noisy", "modules", "readers", "important"):
            words = rules.get(name)
            if not isinstance(words, list) or len(words) > 100 or any(not isinstance(w, str) or len(w) > 64 for w in words):
                raise ValueError("Invalid output policy")
            self.words[name] = frozenset(words)

    def command(self, command: str) -> bool:
        if RAW in command or any(s in command for s in ("<<", "$(", "`")):
            return False

        def words(segment: str) -> list[str]:
            items = segment.strip().split()
            while items and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", items[0]) or items[0] in ("time", "env")):
                items.pop(0)
            return items

        pipeline = re.split(r"(?<!\|)\|(?!\|)", command)
        last = words(pipeline[-1])
        if len(pipeline) > 1 and last and last[0].rsplit("/", 1)[-1] in self.words["readers"]:
            return False
        for segment in re.split(r"&&|\|\|?|;", command):
            parts = words(segment)
            if not parts:
                continue
            first = parts[0].rsplit("/", 1)[-1]
            if re.fullmatch(r"python(?:3(?:\.\d+)?)?", first):
                if len(parts) > 2 and parts[1] == "-m" and parts[2] in self.words["modules"]:
                    return True
            elif first in self.words["noisy"]:
                return True
        return False

    def trim(self, text: str) -> str:
        lines = [ANSI.sub("", line).rstrip("\r").rsplit("\r", 1)[-1] for line in text.split("\n")]
        collapsed: list[str] = []
        start = 0
        while start < len(lines):
            end = start + 1
            while end < len(lines) and lines[end] == lines[start]:
                end += 1
            if end - start >= self.numbers["repeat"]:
                collapsed += [lines[start], "[… ligne répétée %d fois de plus]" % (end - start - 1)]
            else:
                collapsed += lines[start:end]
            start = end
        if len(collapsed) <= self.numbers["long"]:
            return "\n".join(collapsed)
        head, tail = self.numbers["head"], self.numbers["tail"]
        middle = collapsed[head:-tail]
        kept = [(i + head + 1, line) for i, line in enumerate(middle)
                if any(word in line.lower() for word in self.words["important"])][:self.numbers["kept"]]
        hidden = len(middle) - len(kept)
        shown = collapsed[:head] + ["[… %d lignes masquées%s]" % (hidden, " ; lignes d'erreur gardées :" if kept else "")]
        shown += ["%d: %s" % item for item in kept]
        shown += ["[… fin des lignes gardées]"] if kept else []
        shown += collapsed[-tail:]
        shown += ["tokfit : %d lignes masquées. Pour la sortie entière, relance avec %s." % (hidden, RAW)]
        return "\n".join(shown)


def shorten_request(original: dict[str, object], policy: OutputPolicy) -> dict[str, object]:
    items = original.get("input")
    if not isinstance(items, list):
        return original
    commands: dict[str, str] = {}
    replacements: dict[int, str] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if item.get("type") == "function_call" and isinstance(name, str) and name.rsplit(".", 1)[-1] in ("exec_command", "shell_command"):
            try:
                args = json.loads(item.get("arguments", "{}"))
            except (TypeError, ValueError):
                continue
            command = args.get("cmd", args.get("command")) if isinstance(args, dict) else None
            call_id = item.get("call_id")
            if isinstance(command, str) and isinstance(call_id, str):
                commands[call_id] = command
        if item.get("type") != "function_call_output":
            continue
        output, call_id = item.get("output"), item.get("call_id")
        if not isinstance(output, str) or not isinstance(call_id, str) or not policy.command(commands.get(call_id, "")):
            continue
        # Restrict to an unambiguous completed-success envelope. A running
        # session id, failed command or unfamiliar output must stay untouched.
        header, separator, text = output.partition("Output:\n")
        statuses = re.findall(r"(?m)^(?:Process exited with code|Exit code:) (.*)$", header)
        if not separator or "Session ID:" in header or statuses != ["0"] or RAW in text or "tokfit :" in text:
            continue
        trimmed = policy.trim(text)
        if trimmed != text:
            replacements[index] = header + separator + trimmed
    if not replacements:
        return original
    changed = copy.deepcopy(original)
    changed_items = changed["input"]
    assert isinstance(changed_items, list)
    for index, output in replacements.items():
        changed_items[index]["output"] = output
    return changed
