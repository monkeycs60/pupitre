import time


class Conflict(Exception):
    pass


class Engine:
    def __init__(self, store, host, grace=180, now=time.time):
        self.store = store
        self.host = host
        self.grace = grace
        self.now = now
        self.failures = 0

    @property
    def state(self):
        return self.store.state

    def quiet(self, force=False):
        if force:
            return
        fleet = self.host.fleet()
        if fleet and not force:
            raise Conflict("Un agent travaille encore. Attendre sa fin ; le secours permet aussi un arrêt forcé.")

    def apply(self, release):
        if self.state["pending"]:
            raise Conflict("Confirmer ou annuler d'abord la mise à jour en cours")
        if release != self.state["ready"] or not release:
            raise Conflict("La version préparée a changé. Actualiser la page.")
        self.store.verify(release)
        if not self.host.preview_healthy(release):
            raise Conflict("La version de test ne répond plus. Préparer à nouveau la version.")
        self.quiet()
        previous = self.state["current"]
        self.store.verify(previous)
        snapshot = f"before-{release}-{int(self.now())}.tar.gz"
        self.state["pending"] = {
            "from": previous, "to": release, "snapshot": snapshot,
            "snapshotComplete": False, "dataRestored": False, "phase": "snapshot",
            "started": self.now(), "deadline": None,
        }
        self.store.save()
        try:
            self.host.stop()
            self.host.snapshot(snapshot)
            self.state["pending"]["snapshotComplete"] = True
            self.store.save()
            self.store.link("current", release)
            self.state["current"] = release
            self.state["pending"]["phase"] = "starting"
            self.store.save()
            self.host.start()
            self.host.wait_healthy(release)
            self.state["pending"].update(phase="probation", deadline=self.now() + self.grace)
            self.store.event("Nouvelle version en attente de confirmation")
            self.failures = 0
        except Exception:
            self.rollback("Échec de démarrage de la nouvelle version", force=True)
            raise

    def confirm(self, release):
        pending = self.state["pending"]
        if not pending or pending["phase"] != "probation" or pending["to"] != release:
            raise Conflict("Aucune version correspondante à confirmer")
        if self.now() >= pending["deadline"] or not self.host.healthy(release):
            self.rollback("Confirmation trop tardive ou version défaillante", force=True)
            raise Conflict("La version précédente a été restaurée")
        self.state["undo"] = {
            "release": pending["from"], "snapshot": pending["snapshot"], "at": pending["started"],
        }
        self.state["pending"] = None
        self.state["ready"] = None
        self.store.event("Mise à jour confirmée ; version précédente et données conservées")

    def rollback(self, reason="Retour arrière demandé", force=False, baseline=False):
        pending = self.state["pending"]
        if not pending:
            self.quiet(force)
            undo = self.state["undo"]
            if baseline:
                undo = {"release": self.state["baseline"], "snapshot": self.state["baselineSnapshot"], "at": 0}
            if not undo:
                raise Conflict("Aucune version précédente disponible")
            self.store.verify(undo["release"])
            pending = {
                "from": undo["release"], "to": self.state["current"],
                "snapshot": undo["snapshot"], "snapshotComplete": True,
                "dataRestored": False, "phase": "restoring", "started": undo["at"], "deadline": None,
            }
            self.state["pending"] = pending
            self.store.save()
        self.store.verify(pending["from"])
        pending["phase"] = "restoring"
        pending["deadline"] = None
        self.store.save()
        self.host.stop()
        if pending["snapshotComplete"] and not pending["dataRestored"]:
            self.host.restore(pending["snapshot"])
            pending["dataRestored"] = True
            self.store.save()
        self.store.link("current", pending["from"])
        self.state["current"] = pending["from"]
        self.store.save()
        self.host.start()
        self.host.wait_healthy(pending["from"])
        self.state["pending"] = None
        self.state["ready"] = None
        self.state["undo"] = None
        self.store.event(f"{reason} — version précédente restaurée ; données remplacées conservées à part")
        self.failures = 0

    def recover(self):
        if self.state["pending"]:
            self.rollback("Redémarrage pendant une mise à jour non confirmée", force=True)

    def tick(self):
        pending = self.state["pending"]
        if not pending:
            return
        if pending["phase"] != "probation":
            self.recover()
            return
        if self.now() >= pending["deadline"]:
            self.rollback("Délai de confirmation expiré", force=True)
            return
        self.failures = 0 if self.host.healthy(pending["to"]) else self.failures + 1
        if self.failures >= 3:
            self.rollback("La nouvelle version ne répond plus", force=True)
