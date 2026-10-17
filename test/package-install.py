"""Pack and globally install in an isolated prefix, then exercise the public CLI.

Requires npm registry access (or a warm npm cache with
TERMINAL_AGENT_PACKAGE_TEST_OFFLINE=1). Never installs into the user's prefix.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import signal
import stat
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
CACHE = os.environ.get("TERMINAL_AGENT_PACKAGE_TEST_CACHE", "/tmp/terminal-agent-npm-cache")


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, capture_output=True, timeout=180, **kwargs).stdout


class Terminal:
    def __init__(self, argv, cwd, env):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 110, 0, 0))
        os.set_blocking(self.fd, False)
        self.data = b""
        self.consumed = 0
        self.waited = False

    def send(self, text):
        os.write(self.fd, text.encode())

    def visible(self):
        text = re.sub(rb'\x1b\][^\x07]*?(?:\x07|\x1b\\)', b'', self.data)
        return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', text)

    def read(self):
        if select.select([self.fd], [], [], 0.1)[0]:
            try:
                self.data += os.read(self.fd, 65536)
            except (OSError, BlockingIOError):
                pass

    def until(self, marker, timeout=15):
        deadline = time.monotonic() + timeout
        needle = marker.encode()
        while time.monotonic() < deadline:
            at = self.visible().find(needle, self.consumed)
            if at >= 0:
                self.consumed = at + len(needle)
                return
            self.read()
        raise AssertionError(f"missing {marker}\n{self.visible()[-10000:].decode(errors='replace')}")

    def exited(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            self.read()
            waited, status = os.waitpid(self.pid, os.WNOHANG)
            if waited:
                self.waited = True
                assert os.waitstatus_to_exitcode(status) == 0, self.visible().decode(errors="replace")
                return
        raise AssertionError("CLI did not exit\n" + self.visible().decode(errors="replace"))

    def close(self):
        if not self.waited:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
        os.close(self.fd)


def task_case(cli, cwd, env, ui, cancel=None):
    term = Terminal([str(cli)], cwd, dict(env, TERMINAL_AGENT_UI=ui))
    try:
        term.until("terminal-agent> ")
        if cancel:
            term.send(cancel)
        else:
            term.send("\r")  # Empty input must not launch the backend.
            term.until("terminal-agent> ")
            term.send("帮我验证全局安装\r")
            term.until("执行？[Y/n/q]" if ui == "plain" else "FIRST_STEP")
            term.send("y\r" if ui == "plain" else "y")
            term.until("✗ 退出码：7")
            term.until("执行？[Y/n/q]" if ui == "plain" else "VERIFIED_RESULT")
            term.send("y\r" if ui == "plain" else "y")
            term.until("FINAL_ANSWER_END")
        term.exited()
    finally:
        term.close()


with tempfile.TemporaryDirectory(prefix="ta-npm-") as temp:
    temp = Path(temp)
    # Quotes and spaces catch unsafe shell initialization and path handling.
    prefix = temp / "global ' prefix"
    cwd = temp / "unrelated workspace"
    cwd.mkdir()
    # npm pack must create a fresh release via prepack, without prior dist files.
    shutil.rmtree(ROOT / "dist", ignore_errors=True)
    packed = json.loads(run(["npm", "pack", "--silent", "--json", "--pack-destination", str(temp), "--cache", CACHE], cwd=ROOT))[0]
    paths = {entry["path"] for entry in packed["files"]}
    assert {"dist/terminal-agent.mjs", "dist/ui-opentui.mjs", "dist/terminal-tool.mjs", "dist/terminal-agent.zsh"} <= paths
    assert not any(path.startswith(("src/", "bin/", "shell/", "dsh/", "scripts/", "test/", "docs/", ".runtime/", "node_modules/", ".git/")) or ".credentials" in path or path == ".env" for path in paths)
    assert not any(path.endswith((".map", ".ts")) for path in paths), "release must not contain source maps or TypeScript sources"
    command = ["npm", "install", "--global", str(temp / packed["filename"]), "--prefix", str(prefix),
               "--cache", CACHE, "--registry", "https://registry.npmjs.org", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=30000"]
    if os.environ.get("TERMINAL_AGENT_PACKAGE_TEST_OFFLINE") == "1":
        command.append("--offline")
    try:
        run(command, cwd=cwd)
    except subprocess.CalledProcessError as error:
        raise RuntimeError(error.stderr) from error
    print("PASS: tarball allowlist and isolated npm install --global", flush=True)
    package = prefix / "lib/node_modules/terminal-agent"
    cli = prefix / "bin/terminal-agent"
    fixture_bin = temp / "fixture-bin"
    fixture_bin.mkdir()
    shutil.copy2(ROOT / "test/fixture-dsh.mjs", fixture_bin / "dsh")
    env = {key: value for key, value in os.environ.items() if not key.startswith("TERMINAL_AGENT_")}
    env.update(PATH=f"{fixture_bin}:{prefix / 'bin'}:{env['PATH']}", TERM="xterm-256color",
               XDG_STATE_HOME=str(temp / "state"), XDG_CONFIG_HOME=str(temp / "config"), XDG_DATA_HOME=str(temp / "data"), XDG_CACHE_HOME=str(temp / "cache"), DSH_HOME=str(temp / "existing-dsh"))
    assert run([str(cli), "--version"], cwd=cwd, env=env).strip() == packed["version"]
    assert "shell init zsh" in run([str(cli), "--help"], cwd=cwd, env=env)
    diagnosis = run([str(cli), "doctor"], cwd=cwd, env=env)
    assert "fixture-dsh" in diagnosis and str(package / "node_modules/bun/bin/bun.exe") in diagnosis
    assert str(ROOT) not in diagnosis
    assert not (temp / "state").exists(), "doctor should not create runtime state"
    # Make the installed assets read-only, as with a system-managed prefix.
    for base, dirs, files in os.walk(package):
        for name in files + dirs:
            path = Path(base) / name
            if not path.is_symlink():
                path.chmod(path.stat().st_mode & ~0o222)
    package.chmod(0o555)
    try:
        for ui in ("plain", "tui"):
            task_case(cli, cwd, env, ui)
            print(f"PASS: installed CLI task entry, approval, execution and conclusion ({ui})", flush=True)
        for key in ("\x03", "\x04"):
            task_case(cli, cwd, env, "plain", cancel=key)
        print("PASS: Ctrl-C / EOF at initial prompt", flush=True)
        state = temp / "state/terminal-agent/dsh"
        # Bridge patch files now live in private per-run IPC directories and are
        # deleted on close. Unified history retains only the backend mapping.
        metas = list((temp / "data/terminal-agent/sessions").glob("*/meta.json"))
        assert metas and all(json.loads(p.read_text())["backend"] == "dsh" for p in metas)
        assert state.is_dir()
        assert not (package / ".runtime").exists()
        term = Terminal(["/bin/zsh", "-f", "-i"], cwd, dict(env, TERMINAL_AGENT_UI="plain"))
        try:
            term.send("PS1='INSTALL_PROMPT> '; eval \"$(terminal-agent shell init zsh)\"\r")
            term.until("terminal-agent 已启用")
            term.until("INSTALL_PROMPT> ")
            term.send("ta --version\r")
            term.until(packed["version"])
            term.until("INSTALL_PROMPT> ")
            term.send("帮我验证全局 zsh 接入\r")
            term.until("执行？[Y/n/q]")
            term.send("n\r")
            term.until("已拒绝，命令未执行")
            term.until("INSTALL_PROMPT> ")
            term.send("terminal-agent-off\r")
            term.until("terminal-agent 已关闭")
            term.until("INSTALL_PROMPT> ")
            term.send("exit\r")
            term.exited()
        finally:
            term.close()
        print("PASS: installed zsh init, ta wrapper, approval rejection and shell restoration", flush=True)
    finally:
        # Restore owner permissions so TemporaryDirectory can clean up.
        package.chmod(0o755)
        for base, dirs, files in os.walk(package):
            for name in files + dirs:
                path = Path(base) / name
                if not path.is_symlink():
                    path.chmod(path.stat().st_mode | stat.S_IWUSR)
