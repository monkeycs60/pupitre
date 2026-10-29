#!/usr/bin/python3
import json
import ipaddress
import os
import secrets
import socket
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from engine import Conflict, Engine
from host import Host
from store import Store


class Controller:
    def __init__(self, store, host, config):
        self.store, self.host, self.config = store, host, config
        self.engine = Engine(store, host, config.get("confirmSeconds", 180))
        self.lock = threading.Lock()
        self.csrf = secrets.token_urlsafe(32)
        self.job = None
        self.messages = []
        self.host.log = self.log

    def log(self, message):
        self.messages = (self.messages + [str(message)])[-20:]
        print(message, flush=True)

    def launch(self, name, action):
        if not self.lock.acquire(False):
            raise Conflict("Une opération est déjà en cours")
        self.job = {"name": name, "running": True, "error": None}
        self.messages = []
        def work():
            try:
                action()
            except Exception as error:
                self.log(str(error))
                self.job["error"] = str(error)
            finally:
                self.job["running"] = False
                self.lock.release()
        threading.Thread(target=work, daemon=True).start()

    def status(self):
        state = self.store.state
        def version(name):
            if not name:
                return None
            try:
                value = self.store.manifest(name)
                return {"id": name, "sha": value["sha"], "created": value["created"]}
            except Exception:
                return {"id": name, "sha": "inconnu", "created": None}
        return {
            "csrf": self.csrf, "now": time.time(), "current": version(state["current"]),
            "ready": version(state["ready"]), "previous": state["undo"], "pending": state["pending"],
            "baseline": version(state["baseline"]), "history": state["history"],
            "job": self.job, "messages": self.messages,
            "appUrl": f'https://{self.config["host"]}/',
            "previewUrl": f'https://{self.config["host"]}:10000/',
        }

    def action(self, data):
        if not isinstance(data, dict) or set(data) - {"action", "release", "force"}:
            raise ValueError("Requête invalide")
        action = data.get("action")
        if action == "prepare":
            self.launch("Préparer la version", self.host.prepare)
        elif action == "apply":
            self.launch("Appliquer la version", lambda: self.engine.apply(data.get("release")))
        elif action == "confirm":
            self.launch("Confirmer la version", lambda: self.engine.confirm(data.get("release")))
        elif action in ("rollback", "baseline"):
            self.launch("Restaurer la version", lambda: self.engine.rollback(
                force=data.get("force") is True, baseline=action == "baseline"))
        elif action == "restart":
            def restart():
                if self.store.state["pending"]:
                    raise Conflict("Annuler ou confirmer d'abord la mise à jour")
                self.engine.quiet(data.get("force") is True)
                self.store.verify(self.store.state["current"])
                self.host.stop()
                self.host.start()
                self.host.wait_healthy(self.store.state["current"])
                self.store.event("Pupitre redémarré depuis la console de secours")
            self.launch("Redémarrer Pupitre", restart)
        else:
            raise ValueError("Action inconnue")

    def watch(self):
        while True:
            time.sleep(3)
            if not self.store.state["pending"] or not self.lock.acquire(False):
                continue
            try:
                self.engine.tick()
            except Exception as error:
                self.log(f"Restauration à réessayer : {error}")
            finally:
                self.lock.release()


class Handler(BaseHTTPRequestHandler):
    def address_string(self):
        return "tailscale"

    def reply(self, status, body, content_type="application/json; charset=utf-8"):
        raw = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        for key, value in {
            "Content-Type": content_type, "Content-Length": str(len(raw)), "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        }.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        control = self.server.control
        origin = f'https://{control.config["host"]}:8443'
        try:
            client = ipaddress.ip_address(self.headers.get("X-Forwarded-For", "").split(",")[-1].strip())
        except ValueError:
            return False
        # Serve réécrit Host en localhost pour les cibles Unix ; le socket reste réservé à root.
        return (self.headers.get("Host") in ("localhost", control.config["host"] + ":8443")
                and self.headers.get("Tailscale-User-Login") == control.config["login"]
                and bool(control.config.get("serverAddresses"))
                and not client.is_loopback
                and str(client) not in control.config.get("serverAddresses", [])
                and self.headers.get("Origin", origin) == origin
                and self.headers.get("Sec-Fetch-Site") != "cross-site")

    def do_GET(self):
        if not self.authorized():
            return self.reply(403, {"error": "Accès privé Tailscale requis"})
        if self.path == "/":
            return self.reply(200, (Path(__file__).parent / "console.html").read_bytes(), "text/html; charset=utf-8")
        if self.path == "/api/status":
            return self.reply(200, self.server.control.status())
        if self.path == "/api/log":
            return self.reply(200, {"log": self.server.control.host.build_log()})
        self.reply(404, {"error": "Page inconnue"})

    def do_POST(self):
        control = self.server.control
        if not self.authorized() or not secrets.compare_digest(self.headers.get("X-Pupitre-CSRF", ""), control.csrf):
            return self.reply(403, {"error": "Accès refusé ; actualiser la page"})
        if self.path != "/api/action" or self.headers.get("Content-Type") != "application/json":
            return self.reply(400, {"error": "Requête invalide"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2048:
                raise ValueError("Requête trop grande ou vide")
            data = json.loads(self.rfile.read(length))
            control.action(data)
            self.reply(202, {"ok": True})
        except Conflict as error:
            self.reply(409, {"error": str(error)})
        except (ValueError, TypeError) as error:
            self.reply(400, {"error": str(error)})


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(10)
        return connection, address


def notify_ready():
    address = os.environ.get("NOTIFY_SOCKET")
    if address:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as connection:
            connection.connect(address.replace("@", "\0", 1) if address.startswith("@") else address)
            connection.sendall(b"READY=1")


if __name__ == "__main__":
    config = json.loads(Path("/etc/pupitre/control.json").read_text())
    store = Store("/var/lib/pupitre-control", "/opt/pupitre/releases")
    host = Host(store, config)
    control = Controller(store, host, config)
    address = Path("/run/pupitre-control/http.sock")
    address.unlink(missing_ok=True)
    server = Server(str(address), Handler)
    os.chmod(address, 0o600)
    server.control = control
    notify_ready()
    if store.state["pending"]:
        control.launch("Récupération après interruption", control.engine.recover)
    threading.Thread(target=control.watch, daemon=True).start()
    server.serve_forever()
