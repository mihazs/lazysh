"""Owned xdg-desktop-portal Inhibit server for the private native GUI bus.

It owns org.freedesktop.portal.Desktop on the bus named by the single argument.
For every Inhibit call it answers with the Request handle the caller predicted
from its own token, then emits Response(0) for that handle as a portal does once
the request is granted, and prints one bounded JSON line. It prints another line
for every Request.Close of a handle it issued and removes that Request. It never
inhibits anything, so it proves what the application asked of the portal and
when it ended the request, not what a compositor or a display timer did.
"""
import os
import sys

from gi.repository import Gio, GLib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I keeps this directory off the path
from ownedBus import connect, emit

NAME = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
INHIBIT = "org.freedesktop.portal.Inhibit"
REQUEST = "org.freedesktop.portal.Request"
LIMIT = 256
INHIBIT_XML = f"""<node><interface name="{INHIBIT}">
<method name="Inhibit"><arg type="s" direction="in"/><arg type="u" direction="in"/>
<arg type="a{{sv}}" direction="in"/><arg type="o" direction="out"/></method>
</interface></node>"""
REQUEST_XML = f"""<node><interface name="{REQUEST}"><method name="Close"/>
<signal name="Response"><arg type="u"/><arg type="a{{sv}}"/></signal></interface></node>"""


def main():
    connection = connect("ownedPortal.py")
    request_info = Gio.DBusNodeInfo.new_for_xml(REQUEST_XML).interfaces[0]
    requests = {}
    loop = GLib.MainLoop()

    def close(_connection, _sender, path, _interface, method, _parameters, invocation):
        if method != "Close" or path not in requests:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        connection.unregister_object(requests.pop(path))
        emit({"event": "close", "handle": path})
        invocation.return_value(None)

    def inhibit(_connection, sender, _path, _interface, method, parameters, invocation):
        if method != "Inhibit":
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)
            return
        window, flags, options = parameters.unpack()
        token = options.get("handle_token", "")
        # The caller derives the handle from its unique name and token, as the real portal does.
        handle = f"{PATH}/request/{sender.lstrip(':').replace('.', '_')}/{token}"
        requests[handle] = connection.register_object(handle, request_info, close, None, None)
        emit({"event": "inhibit", "handle": handle, "window": window[:LIMIT], "flags": flags,
              "reason": str(options.get("reason", ""))[:LIMIT]})
        invocation.return_value(GLib.Variant("(o)", (handle,)))
        GLib.idle_add(lambda: connection.emit_signal(
            sender, handle, REQUEST, "Response", GLib.Variant("(ua{sv})", (0, {}))) and False)

    connection.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(INHIBIT_XML).interfaces[0], inhibit, None, None)
    Gio.bus_own_name_on_connection(connection, NAME, Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
                                   lambda *_: emit({"event": "ready"}), lambda *_: loop.quit())
    loop.run()


if __name__ == "__main__":
    main()
