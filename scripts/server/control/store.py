import hashlib
import json
import os
import re
import shutil
import stat
import time
from pathlib import Path


RELEASE_ID = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}\Z")


def atomic_json(path, value):
    path = Path(path)
    tmp = path.with_suffix(".new")
    with tmp.open("w") as file:
        json.dump(value, file, ensure_ascii=False, indent=2)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def files_in(root):
    result = {}
    for path in sorted(Path(root).rglob("*")):
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
            raise ValueError(f"Fichier non régulier interdit : {path.name}")
        if stat.S_ISREG(mode) and path != Path(root) / "manifest.json":
            result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


class Store:
    def __init__(self, directory, releases):
        self.directory = Path(directory)
        self.releases = Path(releases)
        self.path = self.directory / "state.json"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.releases.mkdir(parents=True, exist_ok=True)
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            "current": None, "baseline": None, "baselineSnapshot": None,
            "ready": None, "pending": None, "undo": None, "history": [],
        }

    def save(self):
        atomic_json(self.path, self.state)

    def release(self, name):
        if not isinstance(name, str) or not RELEASE_ID.fullmatch(name):
            raise ValueError("Identifiant de version invalide")
        return self.releases / name

    def manifest(self, name):
        return json.loads((self.release(name) / "manifest.json").read_text())

    def verify(self, name):
        root = self.release(name)
        if root.is_symlink() or not root.is_dir():
            raise ValueError("Version absente ou non protégée")
        manifest = self.manifest(name)
        if manifest["id"] != name or manifest["files"] != files_in(root):
            raise ValueError("Version corrompue : empreintes différentes. L'application actuelle est conservée.")
        if "pupitre-sidecar" not in manifest["files"] or "ui/index.html" not in manifest["files"]:
            raise ValueError("Version incomplète")
        return manifest

    def freeze(self, source, name, sha, control_url):
        self.release(name)
        source = Path(source)
        files_in(source)
        destination = self.release(name)
        if destination.exists():
            raise ValueError("Cette version existe déjà")
        temporary = self.releases / f".staging-{name}"
        if temporary.exists():
            shutil.rmtree(temporary)
        shutil.copytree(source, temporary)
        os.chmod(temporary, 0o755)
        index = temporary / "ui/index.html"
        injection = f'<script>window.__PUPITRE__={{serverControlUrl:{json.dumps(control_url)}}};</script>'
        index.write_text(index.read_text().replace("<head>", f"<head>{injection}", 1))
        for path in temporary.rglob("*"):
            os.chmod(path, 0o755 if path.is_dir() or path.name == "pupitre-sidecar" else 0o644)
        manifest = {"id": name, "sha": sha, "created": time.time(), "files": files_in(temporary)}
        atomic_json(temporary / "manifest.json", manifest)
        os.chmod(temporary / "manifest.json", 0o644)
        os.replace(temporary, destination)
        self.verify(name)
        return manifest

    def link(self, which, name):
        if which not in ("current", "preview"):
            raise ValueError("Lien invalide")
        self.verify(name)
        temporary = self.releases / f".{which}.new"
        temporary.unlink(missing_ok=True)
        temporary.symlink_to(name)
        os.replace(temporary, self.releases / which)
        fd = os.open(self.releases, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def event(self, text):
        self.state["history"] = (self.state["history"] + [{"at": time.time(), "text": text}])[-40:]
        self.save()
