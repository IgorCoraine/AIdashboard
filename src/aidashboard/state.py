"""Estado em memória das sessões e limites, e difusão das mudanças para os celulares conectados."""

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import PurePath

from fastapi import WebSocket

from aidashboard.config import DATA_DIR, STATE_FILE

# Sessão sem nenhum evento por esse tempo é considerada morta (terminal fechado sem SessionEnd).
SESSION_TTL_S = 4 * 3600

# Tipos de Notification que significam "o Claude está esperando você agir".
WAITING_NOTIFICATIONS = {
    "permission_prompt",
    "elicitation_dialog",
    "elicitation_url_dialog",
    "agent_needs_input",
}


@dataclass
class Session:
    id: str
    project: str = ""
    title: str = ""
    state: str = "idle"  # idle | working | waiting | done | compacting | error
    tool: str = ""
    message: str = ""
    model: str = ""
    context_pct: float | None = None
    cost_usd: float | None = None
    tokens: int = 0
    started: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)


def _project_name(cwd: str | None) -> str:
    return PurePath(cwd).name if cwd else ""


class Hub:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.limits: dict = self._load_limits()
        self.clients: set[WebSocket] = set()

    # ---------- difusão

    def snapshot(self) -> dict:
        return {
            "type": "snapshot",
            "sessions": [asdict(s) for s in self.sessions.values()],
            "limits": self.limits,
        }

    async def broadcast(self, msg: dict) -> None:
        for ws in list(self.clients):
            try:
                await ws.send_json(msg)
            except Exception:
                self.clients.discard(ws)

    async def _push(self, s: Session) -> None:
        s.updated = time.time()
        await self.broadcast({"type": "session", "session": asdict(s)})

    def _get(self, session_id: str, cwd: str | None = None) -> Session:
        s = self.sessions.get(session_id)
        if s is None:
            s = self.sessions[session_id] = Session(id=session_id)
        if cwd and not s.project:
            s.project = _project_name(cwd)
        return s

    # ---------- entradas

    async def handle_hook(self, p: dict) -> None:
        sid = p.get("session_id")
        event = p.get("hook_event_name")
        if not sid or not event:
            return

        if event == "SessionEnd":
            if self.sessions.pop(sid, None):
                await self.broadcast({"type": "session_removed", "id": sid})
            return

        s = self._get(sid, p.get("cwd"))
        if event == "SessionStart":
            s.state, s.tool, s.message = "idle", "", ""
            s.title = p.get("session_title") or s.title
            s.model = p.get("model") or s.model
        elif event == "UserPromptSubmit":
            s.state, s.tool, s.message = "working", "", ""
        elif event in ("PreToolUse", "PostToolUse"):
            s.state, s.tool, s.message = "working", p.get("tool_name") or "", ""
        elif event == "Notification":
            kind = p.get("notification_type") or ""
            if kind in WAITING_NOTIFICATIONS or (not kind and "permission" in (p.get("message") or "")):
                s.state, s.message = "waiting", (p.get("message") or "")[:120]
            else:
                return
        elif event == "Stop":
            s.state, s.tool, s.message = "done", "", ""
        elif event == "StopFailure":
            s.state, s.tool = "error", ""
            s.message = p.get("error_type") or p.get("reason") or "erro na API"
        elif event == "PreCompact":
            s.state, s.tool = "compacting", ""
        else:
            return
        await self._push(s)

    async def handle_status(self, p: dict) -> None:
        sid = p.get("session_id")
        if sid:
            s = self._get(sid, (p.get("workspace") or {}).get("current_dir") or p.get("cwd"))
            ctx = p.get("context_window") or {}
            s.context_pct = ctx.get("used_percentage", s.context_pct)
            s.cost_usd = (p.get("cost") or {}).get("total_cost_usd", s.cost_usd)
            s.model = (p.get("model") or {}).get("display_name") or s.model
            await self._push(s)

        rl = p.get("rate_limits") or {}
        limits = {
            k: {"pct": rl[k].get("used_percentage"), "resets_at": rl[k].get("resets_at")}
            for k in ("five_hour", "seven_day")
            if isinstance(rl.get(k), dict)
        }
        if limits and limits != {k: self.limits.get(k) for k in limits}:
            self.limits.update(limits)
            self._save_limits()
            await self.broadcast({"type": "limits", "limits": self.limits})

    async def handle_usage(self, sid: str, cwd: str | None, usage: dict) -> None:
        s = self._get(sid, cwd)
        s.tokens += sum(usage.values())
        # O JSONL é lido com atraso e pode chegar depois do Stop; por isso "done" não volta a "working".
        if s.state == "idle":
            s.state = "working"
        await self.broadcast({"type": "tokens", "session_id": sid, **usage})
        await self._push(s)

    async def handle_title(self, sid: str, title: str) -> None:
        s = self.sessions.get(sid)
        if s and title and s.title != title:
            s.title = title
            await self._push(s)

    async def reap(self) -> None:
        now = time.time()
        for sid in [k for k, s in self.sessions.items() if now - s.updated > SESSION_TTL_S]:
            del self.sessions[sid]
            await self.broadcast({"type": "session_removed", "id": sid})
        expired = [k for k, v in self.limits.items() if v.get("resets_at") and v["resets_at"] < now]
        if expired:
            for k in expired:
                self.limits[k] = {"pct": 0, "resets_at": None}
            self._save_limits()
            await self.broadcast({"type": "limits", "limits": self.limits})

    # ---------- persistência dos limites (para os tubos não começarem vazios)

    @staticmethod
    def _load_limits() -> dict:
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8")).get("limits", {})
        except (OSError, ValueError):
            return {}

    def _save_limits(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps({"limits": self.limits}), encoding="utf-8")
