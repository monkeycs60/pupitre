"""Ouvre une page dans WebKitGTK, le moteur de l'app Linux, y joue un scénario
JavaScript et imprime sur stdout le JSON que le scénario dépose dans
window.__probe (étape « done » ou « error »)."""
import json
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

url, script_path, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
script = open(script_path, encoding="utf-8").read()

window = Gtk.Window()
window.set_default_size(1440, 900)
view = WebKit2.WebView()
window.add(view)
window.show_all()
state = {"started": time.time(), "result": None, "last": None, "injected": False}


def finish(result):
    state["result"] = result
    Gtk.main_quit()


def poll():
    def done(source, result, _data):
        try:
            value = source.evaluate_javascript_finish(result)
            text = value.to_string() if value else "null"
            data = json.loads(text) if text and text != "undefined" else None
        except Exception as error:  # noqa: BLE001
            data = {"step": "eval-error", "message": str(error)}
        state["last"] = data
        if data and data.get("step") in ("done", "error"):
            finish(data)

    view.evaluate_javascript("JSON.stringify(window.__probe ?? null)", -1, None, None, None, done, None)
    if time.time() - state["started"] > timeout:
        finish({"step": "timeout", "last": state["last"]})
        return False
    return True


def on_load(_view, event):
    if event != WebKit2.LoadEvent.FINISHED or state["injected"]:
        return
    state["injected"] = True
    view.evaluate_javascript(script, -1, None, None, None, None, None)
    GLib.timeout_add(500, poll)


view.connect("load-changed", on_load)
view.load_uri(url)
Gtk.main()
print(json.dumps(state["result"]))
