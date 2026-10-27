"""Authorization UI and controlling-terminal regression; sudo is a test double."""
import json
import faulthandler
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import termios
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
faulthandler.dump_traceback_later(60, exit=True)

for ui in ('plain', 'opentui'):
    for mode in ('normal', 'normal-sudo', 'full'):
        with tempfile.TemporaryDirectory(prefix='sayrun-auth-') as directory:
            env = dict(os.environ, TERM='xterm-256color', TA_HOME=directory + '/home')
            pid, fd = pty.fork()
            if pid == 0:
                os.chdir(directory)
                os.execvpe('/bin/zsh', ['/bin/zsh', '-f', '-i'], env)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 90, 0, 0))
            os.set_blocking(fd, False)
            data = b''

            def until(marker):
                global data
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    visible = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', data)
                    if marker.encode() in visible:
                        return visible.decode(errors='replace')
                    if select.select([fd], [], [], 0.1)[0]:
                        try:
                            data += os.read(fd, 65536)
                        except BlockingIOError:
                            continue
                raise AssertionError(f'{ui}/{mode} missing {marker}: {data[-6000:]!r}')

            try:
                runtime = 'node --import ' + str(ROOT / 'node_modules/tsx/dist/loader.mjs') if ui == 'plain' else str(ROOT / 'node_modules/.bin/bun')
                os.write(fd, f"PS1='AUTH_PROMPT> '; export AUTH_SESSION=$$; {runtime} {ROOT}/test/fixture-authorization.mjs {mode} {ui}; printf 'TASK_%s\\n' DONE\n".encode())
                if mode == 'normal-sudo':
                    until('执行？' if ui == 'plain' else '命令预览')
                    os.write(fd, b'y\n' if ui == 'plain' else b'y')
                if mode == 'full':
                    until('TTY_VERIFIED')
                    until('SLEEP_READY')
                    # The command preview contains these strings as well. Wait
                    # for the child's side effect before testing cancellation.
                    deadline = time.monotonic() + 10
                    sleeper = Path(directory) / 'sleeper.pid'
                    while not sleeper.exists() and time.monotonic() < deadline:
                        if select.select([fd], [], [], 0.1)[0]:
                            data += os.read(fd, 65536)
                    assert sleeper.exists(), data
                    os.write(fd, b'\x03')
                    until('CANCELLED_OK')
                until('TASK_DONE')
                until('AUTH_PROMPT> ')
                state = json.loads((Path(directory) / 'auth.json').read_text())
                assert state == {'auth': int(mode != 'normal'), 'closed': int(mode != 'normal')}, state
                if mode == 'full':
                    child = int(sleeper.read_text())
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        try:
                            os.kill(child, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(0.05)
                    else:
                        raise AssertionError('cancelled descendant still alive')
                else:
                    assert b'AUTO_SECOND' in data
                    if mode == 'normal':
                        assert b'AUTO_FIRST' in data
                        assert '执行？' not in data.decode(errors='replace')
                os.write(fd, b"printf 'SHELL_%s\\n' RESTORED\n")
                until('SHELL_RESTORED')
                os.write(fd, b'exit\n')
                print(f'PASS: {ui}/{mode} automatic execution, terminal and cleanup', flush=True)
            finally:
                os.close(fd)
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    try:
                        if os.waitpid(pid, os.WNOHANG)[0]:
                            break
                    except ChildProcessError:
                        break
                    time.sleep(0.02)
                else:
                    raise AssertionError(f'PTY shell {pid} did not terminate')
faulthandler.cancel_dump_traceback_later()
