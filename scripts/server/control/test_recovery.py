import io
import http.client
import os
import socket
import threading
from contextlib import closing
import json
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from controller import Controller, Handler, Server
from data import export, restore, unpack
from engine import Conflict, Engine
from store import Store


class FakeHost:
    def __init__(self):
        self.data = "original"
        self.snapshots = {}
        self.running = True
        self.healthy_value = True
        self.preview_value = True
        self.fail_start = None
        self.busy = []
        self.restore_count = 0

    def fleet(self):
        if isinstance(self.busy, Exception):
            raise self.busy
        return self.busy

    def stop(self):
        self.running = False

    def start(self):
        self.running = True

    def snapshot(self, name):
        self.snapshots[name] = self.data

    def restore(self, name):
        self.data = self.snapshots[name]
        self.restore_count += 1

    def wait_healthy(self, release):
        if release == self.fail_start:
            raise RuntimeError("Version cassée")

    def healthy(self, release):
        return self.healthy_value

    def preview_healthy(self, release):
        return self.preview_value


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = Store(self.root / "state", self.root / "releases")
        for name in ("old", "new"):
            artifacts = self.root / name
            (artifacts / "ui").mkdir(parents=True)
            (artifacts / "pupitre-sidecar").write_text(name)
            (artifacts / "ui/index.html").write_text("<html><head></head></html>")
            self.store.freeze(artifacts, name, name, "https://host.ts.net:8443/")
        self.store.state.update(current="old", baseline="old", baselineSnapshot="baseline.tar.gz", ready="new")
        self.store.link("current", "old")
        self.store.save()
        self.host = FakeHost()
        self.host.snapshots["baseline.tar.gz"] = "baseline"
        self.clock = 1000
        self.engine = Engine(self.store, self.host, 180, lambda: self.clock)

    def tearDown(self):
        self.tmp.cleanup()

    def test_confirmation_retains_previous_snapshot(self):
        self.engine.apply("new")
        self.assertEqual(self.store.state["current"], "new")
        self.assertEqual(self.store.state["pending"]["deadline"], 1180)
        self.engine.confirm("new")
        self.assertIsNone(self.store.state["pending"])
        self.assertEqual(self.store.state["undo"]["release"], "old")

    def test_no_confirmation_restores_code_and_original_data(self):
        self.engine.apply("new")
        self.host.data = "migrated"
        self.clock = 1180
        self.engine.tick()
        self.assertEqual(self.store.state["current"], "old")
        self.assertEqual(self.host.data, "original")
        self.assertTrue(self.host.running)

    def test_crashing_release_restores_automatically(self):
        self.host.fail_start = "new"
        with self.assertRaisesRegex(RuntimeError, "cassée"):
            self.engine.apply("new")
        self.assertEqual(self.store.state["current"], "old")
        self.assertIsNone(self.store.state["pending"])

    def test_corrupt_artifact_refused_before_stop(self):
        (self.store.release("new") / "ui/index.html").write_text("corrupt")
        with self.assertRaisesRegex(ValueError, "corrompue"):
            self.engine.apply("new")
        self.assertEqual(self.store.state["current"], "old")
        self.assertTrue(self.host.running)
        self.assertIsNone(self.store.state["pending"])

    def test_three_failed_health_checks_restore(self):
        self.engine.apply("new")
        self.host.healthy_value = False
        self.engine.tick()
        self.engine.tick()
        self.assertEqual(self.store.state["current"], "new")
        self.engine.tick()
        self.assertEqual(self.store.state["current"], "old")

    def test_controller_restart_during_probation_restores(self):
        self.engine.apply("new")
        reloaded = Store(self.store.directory, self.store.releases)
        Engine(reloaded, self.host).recover()
        self.assertEqual(reloaded.state["current"], "old")
        self.assertIsNone(reloaded.state["pending"])

    def test_restart_before_snapshot_does_not_restore_missing_snapshot(self):
        self.store.state["pending"] = {"from": "old", "to": "new", "snapshot": "missing", "snapshotComplete": False,
                                      "dataRestored": False, "phase": "snapshot", "deadline": None}
        self.engine.recover()
        self.assertEqual(self.host.restore_count, 0)
        self.assertTrue(self.host.running)

    def test_restart_during_restore_does_not_restore_twice(self):
        self.engine.apply("new")
        self.store.state["pending"].update(phase="restoring", dataRestored=True)
        self.engine.recover()
        self.assertEqual(self.host.restore_count, 0)

    def test_active_agent_prevents_update(self):
        self.host.busy = [{"running": True}]
        with self.assertRaises(Conflict):
            self.engine.apply("new")
        self.assertIsNone(self.store.state["pending"])
        self.assertTrue(self.host.running)

    def test_failed_preview_prevents_update(self):
        self.host.preview_value = False
        with self.assertRaises(Conflict):
            self.engine.apply("new")
        self.assertTrue(self.host.running)

    def test_stale_release_or_confirmation_refused(self):
        with self.assertRaises(Conflict):
            self.engine.apply("stale")
        self.engine.apply("new")
        with self.assertRaises(Conflict):
            self.engine.confirm("old")
        self.assertIsNotNone(self.store.state["pending"])

    def test_late_confirmation_restores(self):
        self.engine.apply("new")
        self.clock = 1181
        with self.assertRaises(Conflict):
            self.engine.confirm("new")
        self.assertEqual(self.store.state["current"], "old")

    def test_manual_rollback_restores_even_if_app_api_is_broken(self):
        self.engine.apply("new")
        self.engine.confirm("new")
        self.host.data = "new messages"
        self.host.busy = RuntimeError("API unavailable")
        self.engine.rollback(force=True)
        self.assertEqual(self.host.data, "original")
        self.assertEqual(self.store.state["current"], "old")

    def test_baseline_available_after_rollback(self):
        self.engine.apply("new")
        self.engine.confirm("new")
        self.engine.rollback(force=True)
        self.engine.rollback(force=True, baseline=True)
        self.assertEqual(self.host.data, "baseline")

    def test_symlink_and_extra_file_in_release_rejected(self):
        (self.store.release("new") / "escape").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            self.store.verify("new")

    def test_release_path_escape_refused(self):
        for name in ("../../etc", "/tmp", "a/b", "", None):
            with self.assertRaises(ValueError):
                self.store.release(name)

    def test_unknown_or_arbitrary_command_refused(self):
        control = Controller(self.store, self.host, {})
        for data in ({"action": "shell"}, {"action": "restart", "command": "rm"}, []):
            with self.assertRaises(ValueError):
                control.action(data)

    def test_job_mutex_refuses_concurrent_mutation(self):
        control = Controller(self.store, self.host, {})
        control.lock.acquire()
        with self.assertRaises(Conflict):
            control.launch("test", lambda: None)
        control.lock.release()


class DataTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "media").mkdir()
        (self.data / "media/photo").write_text("photo")
        with closing(sqlite3.connect(self.data / "pupitre.db")) as db, db:
            db.execute("create table test (message text)")
            db.execute("insert into test values ('before')")

    def tearDown(self):
        self.tmp.cleanup()

    def test_restore_keeps_replaced_database_and_media(self):
        snapshot = io.BytesIO()
        export(self.data, snapshot)
        with closing(sqlite3.connect(self.data / "pupitre.db")) as db, db:
            db.execute("update test set message='after'")
        (self.data / "media/new").write_text("new photo")
        snapshot.seek(0)
        restore(self.data, snapshot)
        with closing(sqlite3.connect(self.data / "pupitre.db")) as db:
            self.assertEqual(db.execute("select message from test").fetchone()[0], "before")
        retained = next(self.root.glob("data-retained-*"))
        self.assertEqual((retained / "media/new").read_text(), "new photo")
        with closing(sqlite3.connect(retained / "pupitre.db")) as db:
            self.assertEqual(db.execute("select message from test").fetchone()[0], "after")

    def test_symlink_export_rejected(self):
        (self.data / "media/escape").symlink_to("/etc/passwd")
        with self.assertRaises(ValueError):
            export(self.data, io.BytesIO())

    def test_malicious_restore_does_not_replace_current_data(self):
        for kind in ("symlink", "traversal"):
            archive = io.BytesIO()
            with tarfile.open(fileobj=archive, mode="w:gz") as tar:
                info = tarfile.TarInfo("escape" if kind == "symlink" else "../../outside")
                if kind == "symlink":
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc"
                tar.addfile(info)
            archive.seek(0)
            with self.assertRaises((ValueError, tarfile.FilterError)):
                restore(self.data, archive)
            self.assertTrue((self.data / "pupitre.db").is_file())
            self.assertFalse((self.root / "outside").exists())

    def test_invalid_database_does_not_replace_current_data(self):
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            info = tarfile.TarInfo("pupitre.db")
            info.size = 3
            tar.addfile(info, io.BytesIO(b"bad"))
        archive.seek(0)
        with self.assertRaises(sqlite3.DatabaseError):
            restore(self.data, archive)
        self.assertTrue((self.data / "pupitre.db").is_file())


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.control = Controller(Store(root / "state", root / "releases"), FakeHost(),
                                  {"host": "host.ts.net", "login": "owner@example.com", "serverAddresses": ["100.64.0.1"]})
        class SilentHandler(Handler):
            def log_message(self, *args):
                pass
        self.address = str(root / "socket")
        self.server = Server(self.address, SilentHandler)
        os.chmod(self.address, 0o600)
        self.server.control = self.control
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, method="GET", path="/api/status", body=None, **changes):
        headers = {"Host": "localhost", "Tailscale-User-Login": "owner@example.com",
                   "Content-Type": "application/json", "X-Pupitre-CSRF": self.control.csrf,
                   "X-Forwarded-For": "100.64.0.2"}
        headers.update(changes)
        connection = http.client.HTTPConnection("localhost")
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.connect(self.address)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        result = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return result

    def test_serve_unix_host_rewrite_and_identity_accepted(self):
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.request(**{"Host": "host.ts.net:8443"})[0], 200)

    def test_wrong_login_host_or_cross_origin_rejected(self):
        for changes in ({"Tailscale-User-Login": "other@example.com"}, {"Host": "attacker.com"},
                        {"Origin": "https://attacker.com"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request(**changes)[0], 403)

    def test_post_requires_token_and_json(self):
        self.assertEqual(self.request("POST", "/api/action", '{}', **{"X-Pupitre-CSRF": ""})[0], 403)
        self.assertEqual(self.request("POST", "/api/action", '{}', **{"Content-Type": "text/plain"})[0], 400)

    def test_vps_cannot_confirm_itself_even_with_spoofed_forwarded_prefix(self):
        for client in ("", "invalid", "127.0.0.1", "::1", "100.64.0.1", "100.64.0.2, 100.64.0.1"):
            self.assertEqual(self.request(**{"X-Forwarded-For": client})[0], 403)

    def test_missing_server_addresses_fail_closed(self):
        self.control.config.pop("serverAddresses")
        self.assertEqual(self.request()[0], 403)

    def test_arbitrary_commands_and_oversized_body_refused(self):
        self.assertEqual(self.request("POST", "/api/action", '{"action":"shell"}')[0], 400)
        self.assertEqual(self.request("POST", "/api/action", 'x' * 2049)[0], 400)

    def test_page_cannot_be_framed_and_is_not_cached(self):
        status, body, headers = self.request(path="/")
        self.assertEqual(status, 200)
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertIn(b"Mises", body)


if __name__ == "__main__":
    unittest.main()
