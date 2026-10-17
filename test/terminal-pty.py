"""Exercise the real zsh widget and CLI in a PTY using a deterministic SDK peer."""
import os
import re
import faulthandler
import pty
import select
import signal
import tempfile
import time

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
faulthandler.dump_traceback_later(60, exit=True)

def run_case(mode, ui_mode):
    with tempfile.TemporaryDirectory(prefix="ta-pty-") as runtime:
        env = dict(os.environ, TERM="xterm-256color", TA_HOME=os.path.join(runtime, "product"), TERMINAL_AGENT_HOME=runtime, TERMINAL_AGENT_UI=ui_mode,
                   TERMINAL_AGENT_FIXTURE_SCENARIO="question" if mode in ("question", "question-cancel") else "max-tokens" if mode == "max-tokens" else "",
                   TERMINAL_AGENT_DSH_BIN=os.path.join(root, "test", "fixture-dsh.mjs"))
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(root)
            os.execvpe("/bin/zsh", ["/bin/zsh", "-f", "-i"], env)
        os.set_blocking(master, False)
        transcript = b""
        consumed = 0

        def send(text):
            os.write(master, text.encode())

        def until(marker, timeout=15):
            nonlocal transcript, consumed
            deadline = time.monotonic() + timeout
            needle = marker.encode()
            while time.monotonic() < deadline:
                visible = re.sub(rb'\x1b\][^\x07]*?(?:\x07|\x1b\\)', b'', transcript)
                visible = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', visible)
                at = visible.find(needle, consumed)
                if at >= 0:
                    consumed = at + len(needle)
                    return
                if select.select([master], [], [], 0.1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except BlockingIOError:
                        continue
                    except OSError:
                        break
                    if not data:
                        break
                    transcript += data
            raise AssertionError("missing " + marker + "\n" + visible[-9000:].decode(errors="replace"))

        try:
            startup = "PS1='TEST_PROMPT> '; "
            if mode == "reload":
                plugins = os.path.expanduser("~/.oh-my-zsh/custom/plugins")
                startup += f"source '{plugins}/zsh-autosuggestions/zsh-autosuggestions.zsh'; "
                startup += "_zsh_autosuggest_start; "
                highlight = f"{plugins}/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh"
                if os.path.exists(highlight): startup += f"source '{highlight}'; "
            send(startup + "source ./shell/sayrun.zsh\n")
            until("sayrun 已启用")
            until("TEST_PROMPT> ")
            if mode == "reload":
                for iteration in range(3):
                    send("sayrun-off\n")
                    until("sayrun 已关闭")
                    until("TEST_PROMPT> ")
                    send(f"printf 'RELOAD_%s_OK\\n' {iteration}\n")
                    until(f"RELOAD_{iteration}_OK")
                    until("TEST_PROMPT> ")
                    # Sourcing twice must update safely without wrapping the
                    # wrapper again or recursing through the saved widget.
                    for _ in range(2):
                        send("source ./shell/sayrun.zsh\n")
                        until("sayrun 已启用")
                        until("TEST_PROMPT> ")
                send("帮我验证重新加载\n")
                until("执行？[Y/n/q]")
                send("n\n")
                until("已拒绝，命令未执行")
                until("TEST_PROMPT> ")
                assert b"No such shell function" not in transcript
                send("exit\n")
                return
            # Native multiline syntax must finish normally, with no agent entry.
            send("printf 'NATIVE_%s\\n' \\\nOK\n")
            until("NATIVE_OK")
            until("TEST_PROMPT> ")
            send("find largest files\n" if mode == "classify" else "帮我验证这个任务\n")
            if mode in ("question", "question-cancel"):
                until("QUESTION_FIXTURE_SCOPE")
                if mode == "question-cancel":
                    send("\x03")
                    until("任务已取消")
                else:
                    # Text "y" answers the question. It must NOT approve the
                    # subsequent command; that requires a second explicit key.
                    if ui_mode == "tui": until("输入你的回答")
                    else: until("补充信息：")
                    send("y\r")
            if mode == "question-cancel":
                until("TEST_PROMPT> ")
                assert b"FIRST_STEP" not in transcript
                send("exit\n")
                return
            until("执行？[Y/n/q]" if ui_mode == "plain" else "FIRST_STEP")
            if mode == "edit":
                send("\x1b[C\x1b[C\r")
                until("编辑命令 · Enter 执行")
                send("\x1b[200~printf EDITED_STEP; \x1b[201~")
                send("\x1b[13;2u")  # Shift-Enter inserts a newline.
                send("\r")  # Enter submits the edited command directly.
            if mode in ("approve", "default-approve", "question", "classify", "max-tokens", "edit"):
                if mode != "edit":
                    send("\r" if mode == "default-approve" else ("y\n" if ui_mode == "plain" else "y"))
                until("✗ 退出码：7")
                until("执行？[Y/n/q]" if ui_mode == "plain" else "VERIFIED_RESULT")
                send("\r" if mode == "default-approve" else ("y\n" if ui_mode == "plain" else "y"))
                until("FIXTURE_COMPLETED_WITH_VERIFICATION")
                until("FINAL_ANSWER_END")
                # Inspect the actual rendered history, not just whether task
                # markers arrived. Captured ANSI must never become visible.
                visible_history = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', transcript)
                assert not re.search(rb'\[(?:36|39|1|22|90|32)m', visible_history), visible_history[-9000:]
                assert b"INTERNAL_PLAN_SHOULD_NOT_APPEAR" not in transcript
                assert b"**FIXTURE_COMPLETED" not in transcript
                assert "任务结论".encode() in transcript
                if mode == "max-tokens": until("以上回答可能不完整")
                if ui_mode == "tui":
                    # Final conclusion must be printed AFTER OpenTUI restores
                    # mouse/input modes, not inside a persistent footer.
                    assert transcript.rfind(b'\x1b[?1000l') < transcript.rfind(b'FIXTURE_COMPLETED_WITH_VERIFICATION')
                    assert b'\x1b[?1000l' in transcript
                assert "继续对话".encode() not in transcript
            elif mode == "deny":
                send("n\n" if ui_mode == "plain" else "n")
                until("已拒绝，命令未执行")
            else:
                send("\x03")
                until("任务已取消")
            until("TEST_PROMPT> ")
            # shell remains usable and widget restoration works.
            send("sayrun-off\n")
            until("sayrun 已关闭")
            until("TEST_PROMPT> ")
            send("printf 'AFTER_%s\\n' OK\n")
            until("AFTER_OK")
            if mode in ("deny", "cancel"):
                assert b"[\xe9\x80\x80\xe5\x87\xba\xe7\xa0\x81" not in transcript, transcript
            send("exit\n")
        finally:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(master)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    waited, _ = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        break
                except ChildProcessError:
                    break
                time.sleep(0.02)

for ui_mode in ("plain", "tui"):
    for case in ("approve", "default-approve", "deny", "cancel", "question", "question-cancel", "classify", "max-tokens"):
        run_case(case, ui_mode)
        print("PASS:", ui_mode, case, flush=True)
run_case("edit", "tui")
print("PASS: tui select edit, Shift-Enter newline, Enter executes directly", flush=True)
if os.path.exists(os.path.expanduser("~/.oh-my-zsh/custom/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh")):
    run_case("reload", "plain")
    print("PASS: autosuggestions + syntax-highlighting reload", flush=True)
faulthandler.cancel_dump_traceback_later()
