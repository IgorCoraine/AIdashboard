"""Comando da status line: repassa o JSON ao servidor e exibe a status line original do usuário.

Roda a cada atualização da status line, então usa só stdlib e não bloqueia se o servidor estiver fora.
"""

import json
import os
import shutil
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

from aidashboard.config import DEFAULT_PORT, load_config


def _post(port: int, raw: bytes) -> None:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/status", data=raw, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=0.5).close()
    except Exception:
        pass


def _shell_argv(command: str) -> list[str]:
    """Mesmo shell que o Claude Code usa para status line: Git Bash no Windows, ou PowerShell."""
    if os.name != "nt":
        return ["sh", "-c", command]
    candidates = [
        os.environ.get("CLAUDE_CODE_GIT_BASH_PATH"),
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ]
    git = shutil.which("git")
    if git:
        candidates.append(str(Path(git).resolve().parent.parent / "bin" / "bash.exe"))
    for bash in candidates:
        if bash and Path(bash).is_file():
            return [bash, "-c", command]
    return ["powershell", "-NoProfile", "-Command", command]


def _default_line(raw: bytes) -> str:
    try:
        d = json.loads(raw)
    except ValueError:
        return ""
    parts = [(d.get("model") or {}).get("display_name") or "Claude"]
    ctx = (d.get("context_window") or {}).get("used_percentage")
    if ctx is not None:
        parts.append(f"ctx {ctx:.0f}%")
    rl = d.get("rate_limits") or {}
    for key, label in (("five_hour", "5h"), ("seven_day", "sem")):
        pct = (rl.get(key) or {}).get("used_percentage")
        if pct is not None:
            parts.append(f"{label} {pct:.0f}%")
    return " · ".join(parts)


def main() -> None:
    raw = sys.stdin.buffer.read()
    cfg = load_config()
    sender = threading.Thread(target=_post, args=(cfg.get("port", DEFAULT_PORT), raw))
    sender.start()

    original = (cfg.get("statusline_original") or {}).get("command")
    if original:
        try:
            out = subprocess.run(_shell_argv(original), input=raw, capture_output=True, timeout=10).stdout
            sys.stdout.buffer.write(out)
        except Exception:
            pass
    else:
        sys.stdout.buffer.write((_default_line(raw) + "\n").encode("utf-8"))
    sys.stdout.flush()
    sender.join()
