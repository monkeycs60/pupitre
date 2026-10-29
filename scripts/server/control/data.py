#!/usr/bin/python3
import os
from contextlib import closing
import sqlite3
import sys
import tarfile
import tempfile
import time
from pathlib import Path


def unpack(archive, destination):
    for entry in archive:
        if not (entry.isfile() or entry.isdir()):
            raise ValueError("Les liens et fichiers spéciaux sont interdits")
        archive.extract(entry, destination, filter="data")


def check(database):
    with closing(sqlite3.connect(f"file:{database}?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Snapshot SQLite invalide")


def export(source, output):
    source = Path(source)
    with tempfile.TemporaryDirectory(prefix="pupitre-snapshot-") as tmp:
        database = Path(tmp) / "pupitre.db"
        with closing(sqlite3.connect(f"file:{source / 'pupitre.db'}?mode=ro", uri=True)) as src:
            with closing(sqlite3.connect(database)) as dest:
                src.backup(dest)
        check(database)
        with tarfile.open(fileobj=output, mode="w|gz", dereference=False) as archive:
            archive.add(database, arcname="pupitre.db")
            for path in sorted(source.iterdir()):
                if path.name in ("pupitre.db", "pupitre.db-wal", "pupitre.db-shm"):
                    continue
                def regular(info):
                    if not (info.isfile() or info.isdir()):
                        raise ValueError("Lien interdit dans les données à sauvegarder")
                    return info
                archive.add(path, arcname=path.name, filter=regular)


def restore(source, input_file):
    source = Path(source)
    source.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".pupitre-restore-", dir=source.parent) as tmp:
        staged = Path(tmp) / "data"
        staged.mkdir(mode=0o700)
        with tarfile.open(fileobj=input_file, mode="r|gz") as archive:
            unpack(archive, staged)
        check(staged / "pupitre.db")
        retained = source.with_name(f"{source.name}-retained-{time.time_ns()}")
        if source.exists():
            os.replace(source, retained)
        try:
            os.replace(staged, source)
        except BaseException:
            if retained.exists() and not source.exists():
                os.replace(retained, source)
            raise
        print(f"Données précédentes conservées dans {retained}", file=sys.stderr)


if __name__ == "__main__":
    if sys.argv[1] == "export":
        export(sys.argv[2], sys.stdout.buffer)
    elif sys.argv[1] == "restore":
        restore(sys.argv[2], sys.stdin.buffer)
    else:
        raise SystemExit("Commande inconnue")
