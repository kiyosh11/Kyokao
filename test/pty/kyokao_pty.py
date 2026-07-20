import os
import pty
import select
import shlex
import sys
import tempfile
import time
import fcntl
import struct
import subprocess
import termios

ALT_ENTER = "\x1b[?1049h"
ALT_LEAVE = "\x1b[?1049l"
PROMPT = "KYOKAO_PTY_PROMPT> "


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
    assert "Ready. Type a task" not in tail and "╭" not in tail, "stale TUI after exit"
    assert PROMPT in tail, "shell prompt was not restored"


def run(binary):
    shell = Shell()
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
        shell.wait("Ready. Type a task", start)

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
        assert_restored(shell.output[start:])

        start = shell.command(command)
        shell.wait("Ready. Type a task", start)
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
    shell.close()


if __name__ == "__main__":
    run(os.path.abspath(sys.argv[1]))
