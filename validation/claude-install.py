"""Verify the public Claude plugin against local, synthetic data and no accounts."""

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
from threading import Thread
from typing import Iterator

WINDOWS = os.name == "nt"
SOURCE = "https://github.com/loisperrigon/tokfit-connector.git"
PLUGIN = "tokfit@tokfit"
POWERSHELL = (
    Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe" if WINDOWS else None
)


class FakeTokfit(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        if self.path == "/v1/content" and body == {"parts": ["kernel"]}:
            kernel = {"bootstrap": "", "modules": {}, "catalogue": [], "description": "Fixture", "finished": "Finished"}
            self.reply({"version": "fixture", "kernel": kernel})
        else:
            self.reply({})

    def reply(self, body: dict[str, object]) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        return


@contextmanager
def service() -> Iterator[int]:
    with ThreadingHTTPServer(("127.0.0.1", 0), FakeTokfit) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server.server_port
        finally:
            server.shutdown()
            thread.join()


def verify_mcp(root: Path, env: dict[str, str]) -> None:
    kernel = root / "kernel"
    if POWERSHELL is not None:
        command = [str(POWERSHELL), "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                   "-Command", "iex([IO.File]::ReadAllText($env:CLAUDE_PLUGIN_ROOT+'/kernel/launch.ps1'))"]
        env = {**env, "PATH": os.pathsep.join([str(Path(sys.executable).parent), str(POWERSHELL.parent),
                                              str(Path(os.environ["SystemRoot"]) / "System32")])}
        assert shutil.which("git", path=env["PATH"]) is None
    else:
        command = ["sh", str(kernel / "launch.sh")]
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8",
                          env={**env, "CLAUDE_PLUGIN_ROOT": str(root)}) as process:
        assert process.stdin is not None and process.stdout is not None
        answers: queue.Queue[dict[str, object]] = queue.Queue()

        def read() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                answers.put(json.loads(line))

        Thread(target=read, daemon=True).start()
        request_id = 0

        def call(method: str, params: dict[str, object]) -> dict:
            nonlocal request_id
            request_id += 1
            assert process.stdin is not None
            process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}) + "\n")
            process.stdin.flush()
            while True:
                reply = answers.get(timeout=30)
                if reply.get("id") == request_id:
                    return reply["result"]

        try:
            call("initialize", {"protocolVersion": "2024-11-05"})
            tools = {tool["name"] for tool in call("tools/list", {})["tools"]}
            assert "agir" in tools, tools
            code = "marker = 'TOKFIT-NATIVE-42'\nprint(marker)"
            if WINDOWS:
                code = ("marker = 'TOKFIT-NATIVE-42'\nimport subprocess\n"
                        "print(subprocess.check_output(['powershell.exe', '-NoProfile', '-Command', "
                        "'Write-Output TOKFIT-NATIVE-42'], text=True).strip())")
            result = call("tools/call", {"name": "agir", "arguments": {"code": code}})
            assert not result.get("isError") and "TOKFIT-NATIVE-42" in str(result["content"]), result
            interrupted = call("tools/call", {"name": "agir", "arguments": {
                "code": "import time\ntime.sleep(15)", "timeout_s": 1}})
            assert interrupted.get("isError"), interrupted
            resumed = call("tools/call", {"name": "agir", "arguments": {"code": "print(marker)"}})
            assert not resumed.get("isError") and "TOKFIT-NATIVE-42" in str(resumed["content"]), resumed
            print("MCP agir, native command and interruption with preserved state verified", flush=True)
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()


def main() -> None:
    claude = shutil.which("claude")
    assert claude
    with tempfile.TemporaryDirectory(prefix="tokfit-validation-") as temporary, service() as port:
        root = Path(temporary)
        config = root / "claude"
        config.mkdir()
        settings = config / "settings.json"
        user_env = {"FORCE_AUTOUPDATE_PLUGINS": "0"}
        permissions = {"deny": ["Bash(rm *)"]}
        settings.write_text(json.dumps({"env": user_env, "permissions": permissions}), encoding="utf-8")
        instructions = root / "CLAUDE.md"
        instructions.write_bytes(b"Original instructions.\n")
        tokfit_config = root / "tokfit.json"
        tokfit_config.write_text(json.dumps({"url": f"http://127.0.0.1:{port}", "key": "ek_" + "a" * 43}),
                                 encoding="utf-8")
        env = {**os.environ, "CLAUDE_CONFIG_DIR": str(config), "TOKFIT_CONFIG": str(tokfit_config),
               "TOKFIT_PYTHON": sys.executable, "TOKFIT_PYTHON_INSTALL": "0",
               "GIT_TERMINAL_PROMPT": "0", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}

        def run(*args: str) -> None:
            subprocess.run([claude, *args], env=env, cwd=root, timeout=90, check=True)

        run("plugin", "install", "tokfit", "--marketplace", SOURCE)
        native = json.loads(settings.read_text(encoding="utf-8"))
        assert native["env"] == user_env and native["permissions"] == permissions
        installed = json.loads((config / "plugins/installed_plugins.json").read_text(encoding="utf-8"))
        plugin = installed["plugins"][PLUGIN][0]
        assert plugin["version"] == "0.7.45", plugin["version"]
        verify_mcp(Path(plugin["installPath"]), env)
        run("plugin", "disable", PLUGIN)
        run("plugin", "uninstall", PLUGIN)
        assert instructions.read_bytes() == b"Original instructions.\n"
        print("Installation, preservation of settings, and uninstallation verified")


if __name__ == "__main__":
    main()
