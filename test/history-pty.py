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
    env.pop("TERMINAL_AGENT_SHELL_ID", None)

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
    assert len(rows) == 1 and rows[0]["sessionId"] == original
    events = json.loads(cli("sessions", "show", original, "--json"))["events"]
    assert sum(e["type"] == "run.started" for e in events) == 2
    assert sum(e["type"] == "execution.started" for e in events) == 4
    assert not any(e["type"] == "context.imported" for e in events)
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    resumes = [m for m in calls if m["method"] == "session/resume"]
    prompts = [m for m in calls if m["method"] == "session/prompt"]
    assert len(resumes) == 1 and resumes[0]["params"]["sessionId"] == prompts[0]["params"]["sessionId"]
    assert prompts[0]["params"]["sessionId"] == prompts[1]["params"]["sessionId"]
    assert sum(m["method"] == "shutdown" for m in calls) == 2
    print("PASS: explicit native resume keeps session identity and appends only new approved commands", flush=True)

    task(["resume", original, "--context-only", "--prompt", "显式上下文分支"])
    rows = json.loads(cli("sessions", "list", "--json"))
    assert len(rows) == 2
    fork = next(m for m in rows if m["sessionId"] != original)
    assert fork["parentSessionId"] == original and fork["backend"] == "dsh"
    events = json.loads(cli("sessions", "show", fork["sessionId"], "--json"))["events"]
    assert sum(e["type"] == "execution.started" for e in events) == 2
    assert any(e["type"] == "context.imported" and "VERIFIED_RESULT" in e["text"] for e in events)
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    assert sum(m["method"] == "session/prompt" for m in calls) == 3
    assert sum(m["method"] == "session/resume" for m in calls) == 1
    print("PASS: explicit context-only resume creates a visible-history branch", flush=True)

    cli("config", "set", "agent.backend", "dsh")
    env["TERMINAL_AGENT_SHELL_ID"] = "shell-conversation-one"
    task(["ask", "同一 shell 第一问"])
    active = json.loads(cli("sessions", "list", "--json"))[0]["sessionId"]
    task(["ask", "刚才那个继续检查"])
    events = json.loads(cli("sessions", "show", active, "--json"))["events"]
    assert sum(e["type"] == "run.started" for e in events) == 2
    assert any("NATIVE_TURN_2" in e.get("text", "") for e in events)
    assert not any(e["type"] == "context.imported" for e in events)
    count = len(json.loads(cli("sessions", "list", "--json")))
    task(["ask", "--new", "新对话"])
    assert len(json.loads(cli("sessions", "list", "--json"))) == count + 1
    env["TERMINAL_AGENT_SHELL_ID"] = "shell-conversation-two"
    task(["ask", "新终端里的提问"])
    assert len(json.loads(cli("sessions", "list", "--json"))) == count + 2
    print("PASS: same-shell followups restore persisted state; --new and different shells stay independent", flush=True)

    before = trace.read_text()
    env["TERMINAL_AGENT_FIXTURE_SCENARIO"] = "resume-fails"
    term = Terminal(["ask", "恢复失败不应自动变成新会话"], env, cwd)
    try:
        term.until("resume_failed")
        # The CLI reports the failure without submitting a replacement prompt.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            waited, status = os.waitpid(term.pid, os.WNOHANG)
            if waited:
                term.waited = True
                assert os.waitstatus_to_exitcode(status) != 0
                break
            time.sleep(0.05)
        assert term.waited
    finally:
        term.close()
    calls = [json.loads(line) for line in trace.read_text()[len(before):].splitlines()]
    assert not any(m["method"] == "session/prompt" for m in calls)
    print("PASS: failed native restore never silently starts a replacement prompt", flush=True)
