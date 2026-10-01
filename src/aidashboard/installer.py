"""Integra o AIdashboard ao Claude Code: plugin com os hooks + status line no settings.json do usuário.

Plugins não podem definir a statusLine, por isso ela é a única coisa escrita direto no settings.json
(com backup, e preservando a status line que o usuário já tinha).
"""

import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

from aidashboard import __version__
from aidashboard.config import CLAUDE_DIR, DATA_DIR, ensure_config, save_config

MARKETPLACE = "aidashboard-local"
PLUGIN = "aidashboard"
PLUGIN_ID = f"{PLUGIN}@{MARKETPLACE}"
MARKETPLACE_DIR = DATA_DIR / "marketplace"
SETTINGS = CLAUDE_DIR / "settings.json"

HOOK_EVENTS = [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Notification",
    "Stop",
    "StopFailure",
    "PreCompact",
]


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_marketplace(port: int) -> Path:
    """Gera um marketplace local com o plugin de hooks apontando para a porta configurada."""
    plugin_dir = MARKETPLACE_DIR / "plugins" / PLUGIN
    _write_json(
        MARKETPLACE_DIR / ".claude-plugin" / "marketplace.json",
        {
            "name": MARKETPLACE,
            "owner": {"name": "AIdashboard"},
            "description": "Marketplace local do AIdashboard",
            "plugins": [{"name": PLUGIN, "source": f"./plugins/{PLUGIN}"}],
        },
    )
    _write_json(
        plugin_dir / ".claude-plugin" / "plugin.json",
        {
            "name": PLUGIN,
            "displayName": "AIdashboard",
            "version": __version__,
            "description": "Envia o estado das sessões para o painel animado do AIdashboard",
            "author": {"name": "AIdashboard"},
        },
    )
    handler = {"type": "http", "url": f"http://127.0.0.1:{port}/hook", "timeout": 2}
    _write_json(
        plugin_dir / "hooks" / "hooks.json",
        {"hooks": {event: [{"hooks": [handler]}] for event in HOOK_EVENTS}},
    )
    return MARKETPLACE_DIR


def statusline_command() -> str:
    # Barras normais: o Claude Code roda a status line pelo Git Bash no Windows.
    exe = Path(sys.executable).as_posix()
    if " " in exe:
        exe = f'"{exe}"'
    return f"{exe} -m aidashboard statusline"


def _claude(*args: str) -> subprocess.CompletedProcess:
    claude = shutil.which("claude")
    if not claude:
        raise SystemExit("Comando 'claude' não encontrado no PATH. Instale o Claude Code primeiro.")
    return subprocess.run([claude, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")


def _load_settings() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except ValueError as e:
        raise SystemExit(f"Não consegui ler {SETTINGS} ({e}). Corrija o JSON e tente de novo.")


def _backup_settings() -> None:
    if SETTINGS.exists():
        backup = SETTINGS.with_name(f"settings.json.aidashboard-{time.strftime('%Y%m%d-%H%M%S')}.bak")
        shutil.copy2(SETTINGS, backup)
        print(f"  backup: {backup}")


def install() -> None:
    cfg = ensure_config()
    print("Instalando a integração do AIdashboard com o Claude Code...")

    write_marketplace(cfg["port"])
    r = _claude("plugin", "marketplace", "add", str(MARKETPLACE_DIR))
    if r.returncode != 0:
        r = _claude("plugin", "marketplace", "update", MARKETPLACE)
        if r.returncode != 0:
            raise SystemExit(f"Falha ao registrar o marketplace:\n{r.stdout}{r.stderr}")
    r = _claude("plugin", "install", PLUGIN_ID)
    if r.returncode != 0 and "already" not in (r.stdout + r.stderr).lower():
        raise SystemExit(f"Falha ao instalar o plugin:\n{r.stdout}{r.stderr}")
    print(f"  plugin {PLUGIN_ID} instalado (hooks -> http://127.0.0.1:{cfg['port']}/hook)")

    settings = _load_settings()
    ours = statusline_command()
    current = settings.get("statusLine")
    if not (isinstance(current, dict) and current.get("command") == ours):
        _backup_settings()
        if isinstance(current, dict) and current.get("command"):
            cfg["statusline_original"] = current
            print(f"  status line existente preservada: {current['command']}")
        new = {"type": "command", "command": ours}
        for key in ("padding", "refreshInterval"):
            if isinstance(current, dict) and key in current:
                new[key] = current[key]
        settings["statusLine"] = new
        _write_json(SETTINGS, settings)
        save_config(cfg)
    print(f"  status line configurada em {SETTINGS}")
    print("Pronto. Sessões novas e abertas passam a enviar dados; rode 'aidashboard' para abrir o painel.")


def uninstall() -> None:
    cfg = ensure_config()
    print("Removendo a integração do AIdashboard...")
    _claude("plugin", "uninstall", PLUGIN_ID)
    _claude("plugin", "marketplace", "remove", MARKETPLACE)
    shutil.rmtree(MARKETPLACE_DIR, ignore_errors=True)
    print("  plugin removido")

    settings = _load_settings()
    current = settings.get("statusLine")
    if isinstance(current, dict) and current.get("command") == statusline_command():
        _backup_settings()
        original = cfg.pop("statusline_original", None)
        if original:
            settings["statusLine"] = original
            print(f"  status line original restaurada: {original.get('command')}")
        else:
            settings.pop("statusLine")
        _write_json(SETTINGS, settings)
        save_config(cfg)
    print("Pronto.")
