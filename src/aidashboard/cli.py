import argparse


def serve(port: int | None) -> None:
    import uvicorn

    from aidashboard.config import ensure_config, save_config
    from aidashboard.server import create_app, pairing_url

    cfg = ensure_config()
    if port and port != cfg["port"]:
        cfg["port"] = port
        save_config(cfg)
        print("Porta alterada: rode 'aidashboard install' de novo para os hooks usarem a nova porta.")
    url = pairing_url(cfg)
    print("AIdashboard rodando")
    print(f"  celular:  {url}")
    print(f"  QR code:  http://127.0.0.1:{cfg['port']}/pair")
    try:
        import qrcode

        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.print_ascii(invert=True)
    except Exception:
        pass
    uvicorn.run(create_app(cfg), host="0.0.0.0", port=cfg["port"], log_level="warning")


def main() -> None:
    parser = argparse.ArgumentParser(prog="aidashboard", description="Painel animado do Claude Code")
    sub = parser.add_subparsers(dest="cmd")
    p_serve = sub.add_parser("serve", help="inicia o servidor (padrão)")
    p_serve.add_argument("--port", type=int)
    sub.add_parser("install", help="instala o plugin de hooks e a status line no Claude Code")
    sub.add_parser("uninstall", help="remove a integração e restaura a status line original")
    sub.add_parser("statusline", help="uso interno: comando da status line")
    args = parser.parse_args()

    if args.cmd == "statusline":
        from aidashboard.statusline import main as statusline

        statusline()
    elif args.cmd == "install":
        from aidashboard.installer import install

        install()
    elif args.cmd == "uninstall":
        from aidashboard.installer import uninstall

        uninstall()
    else:
        serve(getattr(args, "port", None))
