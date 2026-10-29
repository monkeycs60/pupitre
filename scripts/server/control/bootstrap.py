#!/usr/bin/python3
import json
import os
import shutil
from pathlib import Path
from host import Host, run
from store import Store


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("Exécuter avec sudo")
    config = json.loads(Path("/etc/pupitre/control.json").read_text())
    store = Store("/var/lib/pupitre-control", "/opt/pupitre/releases")
    host = Host(store, config)
    if store.state["current"] or store.state["pending"]:
        raise SystemExit("Installation déjà initialisée ; utiliser la console de secours")
    release = store.state["ready"]
    store.verify(release)
    if not host.preview_healthy(release):
        raise SystemExit("Préparer et vérifier d'abord la version de référence")
    if host.fleet():
        raise SystemExit("Attendre la fin des agents actifs")
    unit = Path("/etc/systemd/system/pupitre.service")
    legacy_unit = store.directory / "legacy-pupitre.service"
    shutil.copy2(unit, legacy_unit)
    legacy_web = Path("/var/www/pupitre-before-releases")
    web = Path("/var/www/pupitre")
    if legacy_web.exists() or web.is_symlink():
        raise SystemExit("Migration manuelle précédente à vérifier")
    snapshot = f"baseline-{release}.tar.gz"
    captured = False
    moved = False
    run("systemctl", "stop", "pupitre-control.service")
    try:
        host.stop()
        host.snapshot(snapshot)
        captured = True
        store.link("current", release)
        store.state.update(current=release, baseline=release, baselineSnapshot=snapshot, ready=None)
        store.save()
        os.replace(web, legacy_web)
        moved = True
        web.symlink_to("/opt/pupitre/releases/current/ui")
        shutil.copyfile("/opt/pupitre-control/pupitre-release.service", unit)
        os.chmod(unit, 0o644)
        run("systemctl", "daemon-reload")
        run("systemctl", "start", "pupitre-control.service")
        host.start()
        host.wait_healthy(release)
        store.event("Version de référence protégée ; secours initialisé")
    except BaseException:
        host.stop()
        if captured:
            host.restore(snapshot)
        if moved:
            web.unlink(missing_ok=True)
            os.replace(legacy_web, web)
        shutil.copyfile(legacy_unit, unit)
        store.state.update(current=None, baseline=None, baselineSnapshot=None, ready=release)
        store.save()
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", "pupitre-control.service")
        host.start()
        raise
    run("systemctl", "restart", "pupitre-control.service")
    print("Pupitre utilise désormais une version immuable et le secours indépendant")
