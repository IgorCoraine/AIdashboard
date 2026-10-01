"""Acompanha os transcripts JSONL do Claude Code e emite o consumo de tokens de cada resposta."""

import asyncio
import json
from collections import OrderedDict
from pathlib import Path
from typing import Awaitable, Callable

from watchfiles import Change, awatch

USAGE_FIELDS = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read_input_tokens": "cache_read",
    "cache_creation_input_tokens": "cache_write",
}

OnUsage = Callable[[str, str | None, dict], Awaitable[None]]
OnTitle = Callable[[str, str], Awaitable[None]]


class TranscriptWatcher:
    def __init__(self, root: Path, on_usage: OnUsage, on_title: OnTitle) -> None:
        self.root = root
        self.on_usage = on_usage
        self.on_title = on_title
        self.offsets: dict[str, int] = {}
        # Cada bloco de conteúdo de uma resposta vira uma linha com o mesmo message.id e o
        # mesmo usage; guardamos o último usage visto por id e só emitimos o que aumentou.
        self.seen: OrderedDict[str, dict] = OrderedDict()

    async def run(self) -> None:
        while not self.root.exists():
            await asyncio.sleep(5)
        # O histórico não interessa: só o que for escrito a partir de agora.
        for path in self.root.rglob("*.jsonl"):
            self.offsets[str(path)] = path.stat().st_size

        async for changes in awatch(self.root, watch_filter=lambda _c, p: p.endswith(".jsonl")):
            for change, path in changes:
                if change == Change.deleted:
                    self.offsets.pop(path, None)
                else:
                    await self._read_new_lines(path)

    async def _read_new_lines(self, path: str) -> None:
        offset = self.offsets.get(path, 0)
        try:
            with open(path, "rb") as f:
                f.seek(0, 2)
                if f.tell() < offset:  # arquivo foi reescrito
                    offset = 0
                f.seek(offset)
                data = f.read()
        except OSError:
            return
        end = data.rfind(b"\n")
        if end < 0:
            return  # linha ainda incompleta
        self.offsets[path] = offset + end + 1

        for line in data[: end + 1].splitlines():
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            kind = entry.get("type")
            if kind == "assistant":
                await self._handle_assistant(entry)
            elif kind == "ai-title" and entry.get("sessionId"):
                await self.on_title(entry["sessionId"], entry.get("aiTitle") or "")

    async def _handle_assistant(self, entry: dict) -> None:
        msg = entry.get("message") or {}
        usage = msg.get("usage") or {}
        sid = entry.get("sessionId")
        if not usage or not sid:
            return
        current = {short: int(usage.get(key) or 0) for key, short in USAGE_FIELDS.items()}
        mid = msg.get("id") or entry.get("uuid") or ""
        previous = self.seen.get(mid, dict.fromkeys(current, 0))
        delta = {k: max(0, current[k] - previous[k]) for k in current}
        self.seen[mid] = {k: max(current[k], previous[k]) for k in current}
        self.seen.move_to_end(mid)
        while len(self.seen) > 5000:
            self.seen.popitem(last=False)
        if any(delta.values()):
            await self.on_usage(sid, entry.get("cwd"), delta)
