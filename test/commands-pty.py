"""Exercise the built management UI through Node -> bundled Bun in a real PTY."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / 'dist/sayrun.js'

class Terminal:
    def __init__(self, args, env, cwd, width=90):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.execvpe('node', ['node', str(CLI), *args], env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, width, 0, 0))
        self.data = b''
        self.waited = False

    def send(self, text):
        os.write(self.fd, text.encode())

    def text(self):
        value = re.sub(rb'\x1b\][^\x07]*?(?:\x07|\x1b\\)', b'', self.data)
        return re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', value).decode(errors='replace')

    def read(self):
        if select.select([self.fd], [], [], 0.1)[0]:
            try:
                self.data += os.read(self.fd, 65536)
            except OSError:
                pass

    def until(self, marker):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if marker in self.text():
                return
            self.read()
        raise AssertionError(f'missing {marker}\n{self.text()}')

    def exited(self, code=0):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            self.read()
            waited, status = os.waitpid(self.pid, os.WNOHANG)
            if waited:
                self.waited = True
                self.read()
                assert os.waitstatus_to_exitcode(status) == code, self.text()
                return self.text()
        raise AssertionError('did not exit\n' + self.text())

    def close(self):
        if not self.waited:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            os.waitpid(self.pid, 0)
        os.close(self.fd)

with tempfile.TemporaryDirectory(prefix='sayrun-ui-', dir='/tmp') as directory:
    temp = Path(directory)
    env = dict(os.environ, TERM='xterm-256color', TA_HOME=str(temp / 'product'), ZDOTDIR=str(temp),
               TERMINAL_AGENT_UI='opentui', TERMINAL_AGENT_DSH_BIN=str(ROOT / 'test/fixture-dsh.mjs'))
    env.pop('TERMINAL_AGENT_HOME', None)
    zshrc = temp / '.zshrc'
    zshrc.write_text('# preserve my shell\n')

    def run(args, marker=None, answer=None, code=0, width=90):
        terminal = Terminal(args, env, temp, width)
        try:
            if marker:
                terminal.until(marker)
            if answer is not None:
                terminal.send(answer)
            return terminal.exited(code)
        finally:
            terminal.close()

    preview = run(['setup', '--dry-run'])
    assert '███████' in preview and '安装预览' in preview and '预览模式' in preview
    assert not (temp / 'product').exists()
    assert zshrc.read_text() == '# preserve my shell\n'
    run(['setup', '--no-shell'], '应用以上配置？', '\r', 130)
    run(['setup', '--no-shell'], '应用以上配置？', '\x03', 130)
    assert not (temp / 'product').exists()
    applied = run(['setup', '--no-shell'], '应用以上配置？', 'y')
    assert '环境检查通过' in applied and 'Sayrun 已就绪' in applied
    assert '"diagnostics"' not in applied and '"available"' not in applied
    assert '# >>> sayrun >>>' in zshrc.read_text()
    assert list(temp.glob('.zshrc.sayrun.*.bak'))
    print('PASS: setup logo, dry-run, default cancellation, Ctrl-C, apply, and backup', flush=True)

    for args, expected in [(['doctor'], '环境检查通过'), (['backend', 'list'], '已注册后端'),
                           (['auth', 'status'], '认证状态'), (['config', 'show', '--effective'], '配置总览'),
                           (['sessions'], '没有匹配的会话'), (['--help'], '命令指南'), (['version'], '版本信息')]:
        text = run(args, width=44)
        assert expected in text and '◆ SAYRUN' in text, text
        assert 'dlopen' not in text and 'error:' not in text, text
    env['EDITOR'] = '/usr/bin/true'
    assert '配置已保存' in run(['config', 'edit'])
    env.pop('EDITOR')
    payload = run(['doctor', '--json'])
    assert '\x1b' not in payload and 'diagnostics' in json.loads(payload)
    print('PASS: management cards at 44 columns and unadorned TTY JSON', flush=True)

    # Start the new input UI, then hand terminal ownership to the approval UI.
    terminal = Terminal([], env, temp)
    try:
        terminal.until('输入内容，Enter 继续')
        terminal.send('帮我检查目录\r')
        terminal.until('FIRST_STEP')
        terminal.send('y')
        terminal.until('VERIFIED_RESULT')
        terminal.send('y')
        terminal.until('FINAL_ANSWER_END')
        terminal.exited()
    finally:
        terminal.close()
    listed = subprocess.run(['node', str(CLI), 'sessions', 'list', '--json'], env=env, cwd=temp,
                            capture_output=True, text=True, check=True)
    session = json.loads(listed.stdout)[0]
    text = run(['sessions'], '选择一个历史任务', '\r')
    assert session['title'] in text and 'FINAL_ANSWER_END' in text, text
    run(['resume', session['sessionId']], '继续请求', '\r')
    print('PASS: task input hands off to approval; history selection and resume return cleanly', flush=True)
