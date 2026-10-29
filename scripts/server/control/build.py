#!/usr/bin/python3
import json
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from data import unpack


WORK = Path("/var/lib/pupitre-build/work")
BUN = "/opt/pupitre/bin/bun"


def run(*command):
    print("Exécution : " + " ".join(command), flush=True)
    subprocess.run(command, cwd=WORK / "source", check=True)


if __name__ == "__main__":
    source = WORK / "source"
    if sys.argv[1] == "deps":
        source.mkdir()
        with tarfile.open(WORK / "source.tar") as archive:
            unpack(archive, source)
        run(BUN, "install", "--frozen-lockfile", "--ignore-scripts")
        raise SystemExit(0)
    sha = (WORK / "sha").read_text().strip()
    run(BUN, "run", "typecheck:sidecar")
    run(BUN, "test", "--cwd", "sidecar")
    run(BUN, "test", "--cwd", "ui", "--preload", "/opt/pupitre-control/offline-websocket.ts")
    run(BUN, "test", "scripts/setup.test.ts")
    run(BUN, "run", "--cwd", "ui", "build")
    artifacts = WORK / "artifacts"
    artifacts.mkdir()
    run(BUN, "build", "--compile", "--minify", "--define", f"process.env.PUPITRE_BUILD_SHA={json.dumps(sha[:10])}",
        "--define", 'process.env.PUPITRE_BUILD_DIRTY="0"', "--outfile", str(artifacts / "pupitre-sidecar"),
        "sidecar/src/index.ts")
    shutil.copytree(source / "ui/dist", artifacts / "ui")
    print("Compilation et vérifications terminées", flush=True)
