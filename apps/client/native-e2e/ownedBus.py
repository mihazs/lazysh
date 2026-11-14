"""Start-up shared by the owned helpers of the native GUI suite.

Each helper takes the private session bus address as its only argument and
prints one bounded JSON record per line, `{"event":"ready"}` first.
"""
import json
import sys

from gi.repository import Gio


def emit(record):
    print(json.dumps(record, separators=(",", ":")), flush=True)


def connect(script):
    if len(sys.argv) != 2 or not sys.argv[1].startswith("unix:path=/"):
        raise SystemExit(f"usage: {script} unix:path=/private/bus")
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    return Gio.DBusConnection.new_for_address_sync(sys.argv[1], flags, None, None)
