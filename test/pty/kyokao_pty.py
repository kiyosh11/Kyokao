import os
import pty
import select
import shlex
import sys
import tempfile
import time
import fcntl
import json
import re
import struct
import subprocess
import termios
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALT_ENTER = "\x1b[?1049h"
ALT_LEAVE = "\x1b[?1049l"
PROMPT = "KYOKAO_PTY_PROMPT> "
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class FakeProvider(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        self.rfile.read(length)
        chunks = [
            {
                "id": "pty-response",
                "object": "chat.completion.chunk",
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": "deterministic fake-provider response"},
                        "finish_reason": None,
                    }
                ],
            },
            {
                "id": "pty-response",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            },
            {
                "id": "pty-response",
                "object": "chat.completion.chunk",
                "choices": [],
                "usage": {
                    "prompt_tokens": 900,
                    "completion_tokens": 4,
                    "total_tokens": 904,
                },
            },
        ]
        body = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks) + "data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(body.encode())))
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *_args):
        pass


class Shell:
    def __init__(self):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.environ["PS1"] = PROMPT
            os.environ["TERM"] = "xterm-256color"
            os.execl("/bin/bash", "bash", "--noprofile", "--norc", "-i")
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        self.output = ""
        self.wait(PROMPT)

    def read(self, timeout=0.1):
        ready, _, _ = select.select([self.fd], [], [], timeout)
        if ready:
            try:
                self.output += os.read(self.fd, 65536).decode("utf-8", "replace")
            except OSError:
                pass

    def send(self, value):
        os.write(self.fd, value.encode())

    def wait(self, needle, start=0, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if needle in self.output[start:]:
                return
            self.read()
        raise AssertionError(f"timed out waiting for {needle!r}; tail={self.output[-1000:]!r}")

    def command(self, command):
        start = len(self.output)
        self.send(command + "\r")
        return start

    def close(self):
        self.send("exit\r")
        os.waitpid(self.pid, 0)


def assert_restored(session):
    assert session.count(ALT_ENTER) == 1, "alternate screen entered more or less than once"
    assert session.count(ALT_LEAVE) == 1, "alternate screen left more or less than once"
    tail = session.rsplit(ALT_LEAVE, 1)[1]
    assert "╭" not in tail, "stale TUI after exit"
    assert PROMPT in tail, "shell prompt was not restored"


def run(binary):
    shell = Shell()
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeProvider)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    fake_url = f"http://127.0.0.1:{server.server_address[1]}/v1"
    with tempfile.TemporaryDirectory(prefix="kyokao-pty-home-") as home, tempfile.TemporaryDirectory(
        prefix="kyokao-pty-workspace-"
    ) as workspace:
        subprocess.run(["git", "-C", workspace, "init", "-q"], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                workspace,
                "-c",
                "user.name=Kyokao PTY",
                "-c",
                "user.email=pty@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
            check=True,
        )
        command = (
            f"cd {shlex.quote(workspace)} && HOME={shlex.quote(home)} "
            f"{shlex.quote(binary)} --skip-model-check"
        )
        start = shell.command(command)
        shell.wait("Choose a provider", start)
        shell.send("\x1b[B" * 11 + "\r")
        shell.wait("Enter a model ID", start)
        shell.send("pty-model\r")
        shell.wait("Choose approval mode", start)
        shell.send("\r")
        shell.wait("Review setup", start)
        shell.send("\r")
        shell.wait("Ready", start)

        mark = len(shell.output)
        shell.send("/helx\x7fp\r")
        shell.wait("Manage memory", mark)

        mark = len(shell.output)
        shell.send("/sessionsx\x1b[D\x1b[3~\r")
        shell.wait("No saved sessions.", mark)

        mark = len(shell.output)
        shell.send("/model wrong\x17corrected\r")
        shell.wait("Active model changed to corrected.", mark)

        mark = len(shell.output)
        shell.send("offline draft\x1b[A\x1b[B!")
        shell.wait("offline draft!", mark)
        assert "Running command" not in shell.output[mark:], "history navigation executed the draft"
        shell.send("\x15")

        checks = [
            ("/provider ollama", "Active provider changed to ollama."),
            ("/approval auto-edit", "Approval mode changed to auto-edit."),
            ("/resume missing-session", "Error"),
            ("/memory list", "{}"),
            ("/doctor", "sandbox: enabled"),
            ("/diff", "Working tree"),
            ("/new", "Started a new session."),
        ]
        for value, expected in checks:
            mark = len(shell.output)
            shell.send(value + "\r")
            shell.wait(expected, mark)

        mark = len(shell.output)
        shell.send("/clear\r")
        shell.wait("Running command", mark)
        time.sleep(0.1)
        shell.read()

        shell.send("/")
        shell.wait("Commands", len(shell.output) - 1)
        shell.send("\x1b")
        time.sleep(0.05)
        mark = len(shell.output)
        shell.send("\x1b[200~/exit\npasted literally\x1b[201~")
        shell.wait("pasted literally", mark)
        time.sleep(0.05)
        shell.read()
        assert ALT_LEAVE not in shell.output[mark:], "pasted /exit executed before Enter"
        assert PROMPT not in shell.output[mark:], "pasted /exit returned to the shell before Enter"
        shell.send("\r")
        shell.wait(PROMPT, mark)
        first_session = shell.output[start:]
        assert_restored(first_session)
        assert "Session " not in first_session.rsplit(ALT_LEAVE, 1)[1], "/new printed a resume hint"

        config_path = os.path.join(home, ".config", "kyokao", "config.json")
        with open(config_path, encoding="utf-8") as config_file:
            config = json.load(config_file)
        config.update(
            {
                "provider": "pty",
                "model": "pty-model",
                "providers": {"pty": {"baseURL": fake_url, "apiKey": "pty-test-key"}},
            }
        )
        with open(config_path, "w", encoding="utf-8") as config_file:
            json.dump(config, config_file)

        start = shell.command(command)
        shell.wait("Ready", start)
        mark = len(shell.output)
        shell.send("respond deterministically\r")
        shell.wait("deterministic fake-provider response", mark)
        shell.wait("904 tokens · $0.0000 estimated", mark)
        before_exit = ANSI.sub("", shell.output[mark:])
        assert "Status" not in before_exit, "usage entered the transcript"
        assert "Session " not in before_exit, "session status appeared after a turn"
        ready_mark = len(shell.output)
        shell.wait("Ready", ready_mark)
        shell.send("/exit\r")
        shell.wait(PROMPT, mark)
        interactive = shell.output[start:]
        assert_restored(interactive)
        exit_tail = interactive.rsplit(ALT_LEAVE, 1)[1]
        session_match = re.search(
            r'Session ([0-9a-f-]{36}) · resume: kyokao resume \1 "continue"', exit_tail
        )
        assert session_match, "resume hint missing after interactive exit"
        assert exit_tail.index("Session ") < exit_tail.index(PROMPT), "resume hint followed shell prompt"
        session_id = session_match.group(1)

        start = shell.command(command)
        shell.wait("Ready", start)
        mark = len(shell.output)
        shell.send(f"/resume {session_id}\r")
        shell.wait(f"Resumed session {session_id}.", mark)
        shell.wait("904 tokens · $0.0000 estimated", mark)
        ready_mark = len(shell.output)
        shell.wait("Ready", ready_mark)
        shell.send("\x03")
        shell.wait(PROMPT, mark)
        resumed = shell.output[start:]
        assert_restored(resumed)
        assert f"Session {session_id} · resume:" in resumed.rsplit(ALT_LEAVE, 1)[1]

        start = shell.command(command)
        shell.wait("Ready", start)
        shell.send(f"/resume {session_id}\r")
        shell.wait(f"Resumed session {session_id}.", start)
        shell.send("/new\r")
        shell.wait("Started a new session.", start)
        shell.send("/exit\r")
        shell.wait(PROMPT, start)
        cleared = shell.output[start:]
        assert_restored(cleared)
        assert "Session " not in cleared.rsplit(ALT_LEAVE, 1)[1], "/new did not suppress hint"

        one_shot_start = shell.command(command + " one-shot")
        shell.wait(PROMPT, one_shot_start)
        one_shot = ANSI.sub("", shell.output[one_shot_start:])
        assert "904 tokens · $0.0000 estimated" in one_shot, "one-shot usage changed"
        assert re.search(r"Session [0-9a-f-]{36} \(completed\)", one_shot), "one-shot session changed"

        start = shell.command(command)
        shell.wait("Ready", start)
        shell.send("unsubmitted draft")
        time.sleep(0.05)
        shell.send("\x03")
        shell.wait(PROMPT, start)
        assert_restored(shell.output[start:])

        cancel_home = tempfile.mkdtemp(prefix="kyokao-pty-cancel-")
        start = shell.command(
            f"cd {shlex.quote(workspace)} && HOME={shlex.quote(cancel_home)} "
            f"{shlex.quote(binary)} --skip-model-check"
        )
        shell.wait("Choose a provider", start)
        shell.send("\x03")
        shell.wait(PROMPT, start)
        assert_restored(shell.output[start:])
    server.shutdown()
    server.server_close()
    shell.close()


if __name__ == "__main__":
    run(os.path.abspath(sys.argv[1]))
