import json
import os
import pwd
import re
import shutil
import subprocess
import time
import urllib.request
from pathlib import Path


ROOT = Path("/opt/pupitre-control")
DATA = "/home/pupitre/.local/share/pupitre"
REPO = "/home/pupitre/projects/pupitre"
WORK = Path("/var/lib/pupitre-build/work")


def run(*command, **kwargs):
    environment = os.environ.copy()
    environment.pop("NOTIFY_SOCKET", None)
    return subprocess.run(command, check=kwargs.pop("check", True), env=environment,
                          timeout=kwargs.pop("timeout", 180), **kwargs)


class Host:
    def __init__(self, store, config, log=print):
        self.store = store
        self.config = config
        self.log = log

    def stop(self):
        self.log("Arrêt de Pupitre")
        run("systemctl", "stop", "pupitre.service")

    def start(self):
        run("systemctl", "reset-failed", "pupitre.service", check=False, stderr=subprocess.DEVNULL)
        run("systemctl", "start", "pupitre.service")

    def request(self, port, path, authenticated=False, limit=4_000_000):
        headers = {}
        if authenticated:
            suffix = "" if port == 4880 else ":10000"
            headers = {"Host": self.config["host"] + suffix,
                       "Tailscale-User-Login": self.config["login"]}
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers)
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.read(limit)

    def fleet(self):
        try:
            value = json.loads(self.request(4820, "/api/fleet"))
            if not isinstance(value, list):
                raise ValueError("Réponse fleet invalide")
            return value
        except Exception:
            # Une application hors service doit rester restaurable depuis le secours.
            if self.store.state["pending"]:
                return []
            raise RuntimeError("Impossible de vérifier les agents actifs. Utiliser le retour forcé si Pupitre est cassé.")

    def healthy_at(self, release, port, gateway):
        try:
            health = json.loads(self.request(port, "/api/health"))
            sha = self.store.manifest(release)["sha"]
            if health.get("ok") is not True or not sha.startswith(health["build"]["sha"]):
                return False
            if not isinstance(json.loads(self.request(port, "/api/projects")), list):
                return False
            index = self.request(gateway, "/", True).decode()
            scripts = re.findall(r'<script[^>]+src="([^"]+)"', index)
            if not scripts:
                return False
            return all(path.startswith("/assets/") and self.request(gateway, path, True, 1024)
                       for path in scripts)
        except Exception:
            return False

    def healthy(self, release):
        return self.healthy_at(release, 4820, 4880)

    def preview_healthy(self, release):
        return self.healthy_at(release, 4822, 4884)

    def wait_healthy(self, release):
        deadline = time.monotonic() + self.config.get("startupSeconds", 45)
        while time.monotonic() < deadline:
            if self.healthy(release):
                return
            time.sleep(1)
        raise RuntimeError("La version ne démarre pas correctement")

    def snapshot_path(self, name):
        if not re.fullmatch(r"[a-zA-Z0-9_-]+\.tar\.gz", name):
            raise ValueError("Nom de snapshot invalide")
        return self.store.directory / name

    def snapshot(self, name):
        self.log("Instantané complet des données")
        destination = self.snapshot_path(name)
        temporary = destination.with_suffix(".partial")
        try:
            with temporary.open("xb") as output:
                os.chmod(temporary, 0o600)
                run("runuser", "-u", "pupitre", "--", "python3", str(ROOT / "data.py"), "export", DATA,
                    stdout=output, cwd="/tmp", timeout=300)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

    def restore(self, name):
        self.log("Restauration des données ; conservation du dossier remplacé")
        with self.snapshot_path(name).open("rb") as snapshot:
            run("runuser", "-u", "pupitre", "--", "python3", str(ROOT / "data.py"), "restore", DATA,
                stdin=snapshot, cwd="/tmp", timeout=300)

    def prepare(self):
        if self.store.state["pending"]:
            raise RuntimeError("Confirmer ou annuler la mise à jour en cours")
        if shutil.disk_usage(self.store.releases).free < 3 * 1024**3:
            raise RuntimeError("Moins de 3 Gio libres ; aucune mise à jour autorisée")
        def git(*args):
            return run("runuser", "-u", "pupitre", "--", "git", "-C", REPO, *args,
                       capture_output=True, text=True, cwd="/tmp").stdout.strip()
        if git("status", "--porcelain"):
            raise RuntimeError("Le projet Pupitre contient des changements non commités. Demander à l'agent de terminer son commit.")
        sha = git("rev-parse", "HEAD")
        if not re.fullmatch(r"[a-f0-9]{40}", sha):
            raise ValueError("Commit Git invalide")
        name = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + sha[:10]
        self.store.state["ready"] = None
        self.store.save()
        for unit in ("pupitre-deps.service", "pupitre-build.service", "pupitre-preview.service"):
            run("systemctl", "stop", unit)
        if WORK.exists():
            shutil.rmtree(WORK)
        WORK.mkdir(mode=0o700)
        builder = pwd.getpwnam("pupitre-build")
        with (WORK / "source.tar").open("wb") as output:
            run("runuser", "-u", "pupitre", "--", "git", "-C", REPO, "archive", "--format=tar", sha,
                stdout=output, cwd="/tmp")
        (WORK / "sha").write_text(sha)
        for path in (WORK, WORK / "source.tar", WORK / "sha"):
            os.chown(path, builder.pw_uid, builder.pw_gid)
        self.log(f"Préparation du commit {sha[:10]} sans accès aux comptes du serveur")
        for unit in ("pupitre-deps.service", "pupitre-build.service"):
            run("systemctl", "reset-failed", unit, check=False, stderr=subprocess.DEVNULL)
            try:
                run("systemctl", "start", unit, timeout=1500)
            finally:
                run("systemctl", "stop", unit)
        os.chown(WORK, 0, 0)
        os.chmod(WORK, 0o700)
        self.log("Gel des fichiers et calcul des empreintes")
        self.store.freeze(WORK / "artifacts", name, sha, f'https://{self.config["host"]}:8443/')
        self.store.link("preview", name)
        preview_snapshot = f"preview-{name}.tar.gz"
        self.snapshot(preview_snapshot)
        with self.snapshot_path(preview_snapshot).open("rb") as snapshot:
            run("runuser", "-u", "pupitre-preview", "--", "python3", str(ROOT / "data.py"),
                "restore", "/var/lib/pupitre-preview/data", stdin=snapshot, cwd="/tmp", timeout=300)
        run("systemctl", "restart", "pupitre-preview.service")
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if self.preview_healthy(name):
                self.store.state["ready"] = name
                self.store.event(f"Version de test prête : {sha[:10]}")
                return
            time.sleep(1)
        raise RuntimeError("La version de test ne démarre pas ; l'application actuelle est conservée")

    def build_log(self):
        result = run("journalctl", "--no-pager", "-u", "pupitre-deps.service", "-u", "pupitre-build.service",
                     "-n", "25", "--output=cat", capture_output=True, text=True)
        return result.stdout[-6000:]
