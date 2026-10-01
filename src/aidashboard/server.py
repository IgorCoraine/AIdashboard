"""Servidor local: recebe hooks e status line do Claude Code e transmite tudo ao celular por WebSocket."""

import asyncio
import io
import secrets
import socket
from contextlib import asynccontextmanager, suppress
from html import escape
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from aidashboard.config import CLAUDE_DIR
from aidashboard.state import Hub
from aidashboard.transcripts import TranscriptWatcher

WEB_DIR = Path(__file__).parent / "web"
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}


def lan_ip() -> str:
    """IP da máquina na rede local (nenhum pacote é enviado)."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        except OSError:
            return "127.0.0.1"


def pairing_url(cfg: dict) -> str:
    return f"http://{lan_ip()}:{cfg['port']}/#t={cfg['token']}"


def _require_local(request: Request) -> None:
    if not request.client or request.client.host not in LOOPBACK:
        raise HTTPException(status_code=403)


def create_app(cfg: dict) -> FastAPI:
    hub = Hub()
    watcher = TranscriptWatcher(CLAUDE_DIR / "projects", hub.handle_usage, hub.handle_title)

    async def reaper() -> None:
        while True:
            await asyncio.sleep(60)
            await hub.reap()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        tasks = [asyncio.create_task(watcher.run()), asyncio.create_task(reaper())]
        yield
        for t in tasks:
            t.cancel()
        for t in tasks:
            with suppress(asyncio.CancelledError):
                await t

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    # Corpo vazio = hook bem-sucedido, sem nenhuma decisão para o Claude Code.
    @app.post("/hook")
    async def hook(request: Request) -> Response:
        _require_local(request)
        await hub.handle_hook(await request.json())
        return Response(status_code=200)

    @app.post("/status")
    async def status(request: Request) -> Response:
        _require_local(request)
        await hub.handle_status(await request.json())
        return Response(status_code=200)

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket) -> None:
        await ws.accept()
        if not secrets.compare_digest(ws.query_params.get("token", ""), cfg["token"]):
            await ws.close(code=4401)
            return
        hub.clients.add(ws)
        try:
            await ws.send_json(hub.snapshot())
            while True:
                await ws.receive_text()  # o cliente só manda pings
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(ws)

    @app.get("/pair", response_class=HTMLResponse)
    async def pair(request: Request) -> str:
        _require_local(request)
        url = pairing_url(cfg)
        buf = io.BytesIO()
        qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage, box_size=12).save(buf)
        return f"""<!doctype html><meta charset="utf-8"><title>Parear AIdashboard</title>
<style>body{{font-family:system-ui;background:#0f1218;color:#e6e9ef;display:grid;place-items:center;
min-height:100vh;margin:0;text-align:center}}.qr{{background:#fff;padding:16px;border-radius:12px;display:inline-block}}
.qr svg{{width:300px;height:300px}}code{{color:#9fb3c8;word-break:break-all}}</style>
<div><h1>Escaneie com o celular</h1><div class="qr">{buf.getvalue().decode()}</div>
<p>O celular precisa estar na mesma rede Wi-Fi.</p><p><code>{escape(url)}</code></p></div>"""

    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
    return app
