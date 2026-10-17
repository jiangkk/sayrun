"""Offline CLI history/resume regression with a real terminal and DSH peer."""
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "dist/sayrun.js"

class Terminal:
    def __init__(self, args, env, cwd):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe("node", ["node", str(CLI), *args], env)
        self.data = b""
        self.offset = 0
        self.waited = False

    def send(self, value):
        os.write(self.fd, value.encode())

    def until(self, marker):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            text = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', self.data).decode(errors="replace")
            pos = text.find(marker, self.offset)
            if pos >= 0:
                self.offset = pos + len(marker)
                return
            if select.select([self.fd], [], [], 0.1)[0]:
                try:
                    self.data += os.read(self.fd, 65536)
                except OSError:
                    break
        raise AssertionError(f"missing {marker}\n{self.data.decode(errors='replace')}")

    def exited(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.data += os.read(self.fd, 65536)
                except OSError:
                    pass
            waited, status = os.waitpid(self.pid, os.WNOHANG)
            if waited:
                self.waited = True
                assert os.waitstatus_to_exitcode(status) == 0, self.data.decode(errors="replace")
                return
            time.sleep(0.05)
        raise AssertionError("did not exit\n" + self.data.decode(errors="replace"))

    def close(self):
        if not self.waited:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
        os.close(self.fd)

with tempfile.TemporaryDirectory(prefix="ta-history-", dir="/tmp") as temp:
    temp = Path(temp)
    cwd = temp / "project"
    cwd.mkdir()
    home = temp / "product"
    trace = temp / "trace.jsonl"
    env = dict(os.environ, TA_HOME=str(home), TERMINAL_AGENT_UI="plain", TERM="xterm-256color",
               TERMINAL_AGENT_DSH_BIN=str(ROOT / "test/fixture-dsh.mjs"), TERMINAL_AGENT_FIXTURE_TRACE=str(trace))
    env.pop("TERMINAL_AGENT_HOME", None)
    env.pop("TERMINAL_AGENT_FIXTURE_SCENARIO", None)

    def cli(*args):
        result = subprocess.run(["node", str(CLI), *args], cwd=cwd, env=env, text=True, capture_output=True, timeout=15)
        assert result.returncode == 0, result.stdout + result.stderr
        return result.stdout

    def task(args):
        term = Terminal(args, env, cwd)
        try:
            for _ in range(2):
                term.until("执行？[Y/n/q]")
                term.send("y\r")
            term.until("FINAL_ANSWER_END")
            term.exited()
        finally:
            term.close()

    task(["ask", "首次任务"])
    rows = json.loads(cli("sessions", "list", "--json"))
    assert len(rows) == 1
    original = rows[0]["sessionId"]
    trace_before = trace.read_text()
    term = Terminal(["resume", original], env, cwd)
    try:
        term.until("继续请求（Enter 返回 shell）：")
        assert trace.read_text() == trace_before, "viewing resume must not initialize or prompt a backend"
        term.send("\r")
        term.exited()
    finally:
        term.close()
    assert len(json.loads(cli("sessions", "list", "--json"))) == 1
    print("PASS: resume view is offline and Enter returns without creating a run", flush=True)

    cli("config", "set", "agent.backend", "unregistered-default")
    task(["resume", "--last", "--prompt", "显式继续检查"])
    rows = json.loads(cli("sessions", "list", "--json"))
    assert len(rows) == 2
    fork = next(m for m in rows if m["sessionId"] != original)
    assert fork["parentSessionId"] == original and fork["backend"] == "dsh"
    events = json.loads(cli("sessions", "show", fork["sessionId"], "--json"))["events"]
    assert sum(e["type"] == "execution.started" for e in events) == 2
    assert any(e["type"] == "context.imported" and "VERIFIED_RESULT" in e["text"] for e in events)
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    assert sum(m["method"] == "session/prompt" for m in calls) == 2
    assert not any(m["method"] == "session/resume" for m in calls)
    print("PASS: explicit resume creates a context branch, pins backend, executes only new approved commands", flush=True)
