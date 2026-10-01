"""Caminhos e configuração persistente. Só stdlib: é importado pelo comando da status line."""

import json
import os
import secrets
from pathlib import Path

DEFAULT_PORT = 47800

DATA_DIR = Path(os.environ.get("AIDASHBOARD_HOME") or Path.home() / ".aidashboard")
CLAUDE_DIR = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
CONFIG_FILE = DATA_DIR / "config.json"
STATE_FILE = DATA_DIR / "state.json"


def load_config() -> dict:
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def ensure_config() -> dict:
    """Carrega a config, criando porta e token de pareamento na primeira execução."""
    cfg = load_config()
    changed = False
    if "port" not in cfg:
        cfg["port"] = DEFAULT_PORT
        changed = True
    if not cfg.get("token"):
        cfg["token"] = secrets.token_urlsafe(16)
        changed = True
    if changed:
        save_config(cfg)
    return cfg
