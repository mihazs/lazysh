"""Owned Desktop Notifications server for the private native GUI bus.

It owns org.freedesktop.Notifications on the bus named by the single
argument, prints one bounded JSON line per Notify and CloseNotification
call, and on a stdin line `invoke <id> <action>` emits ActionInvoked for
that notification, then NotificationClosed with the dismissed reason, as a
notification server does after a user clicks an action. It never displays
anything and keeps no state beyond the identifiers it issued.
"""
import json
import sys

from gi.repository import Gio, GLib

INTERFACE = "org.freedesktop.Notifications"
PATH = "/org/freedesktop/Notifications"
XML = f"""<node><interface name="{INTERFACE}">
<method name="GetCapabilities"><arg direction="out" type="as"/></method>
<method name="Notify"><arg type="s"/><arg type="u"/><arg type="s"/><arg type="s"/><arg type="s"/>
<arg type="as"/><arg type="a{{sv}}"/><arg type="i"/><arg direction="out" type="u"/></method>
<method name="CloseNotification"><arg type="u"/></method>
<method name="GetServerInformation"><arg direction="out" type="s"/><arg direction="out" type="s"/>
<arg direction="out" type="s"/><arg direction="out" type="s"/></method>
<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal>
<signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal>
</interface></node>"""
LIMIT = 256


def emit(record):
    # Callers bound every field (at most 8 actions of LIMIT), so each line stays valid JSON.
    print(json.dumps(record, separators=(",", ":")), flush=True)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].startswith("unix:path=/"):
        raise SystemExit("usage: ownedNotifications.py unix:path=/private/bus")
    flags = Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION
    connection = Gio.DBusConnection.new_for_address_sync(sys.argv[1], flags, None, None)
    issued = set()
    loop = GLib.MainLoop()

    def call(_connection, _sender, _path, _interface, method, parameters, invocation):
        if method == "GetCapabilities":
            invocation.return_value(GLib.Variant("(as)", (["actions", "body"],)))
        elif method == "GetServerInformation":
            invocation.return_value(GLib.Variant("(ssss)", ("lazysh-owned", "lazysh", "1", "1.2")))
        elif method == "Notify":
            app, replaces, _icon, summary, body, actions, _hints, _timeout = parameters.unpack()
            identifier = replaces if replaces in issued else len(issued) + 1
            issued.add(identifier)
            emit({"event": "notify", "id": identifier, "app": app[:LIMIT], "summary": summary[:LIMIT],
                  "body": body[:LIMIT], "actions": [action[:LIMIT] for action in actions[:8]]})
            invocation.return_value(GLib.Variant("(u)", (identifier,)))
        elif method == "CloseNotification":
            (identifier,) = parameters.unpack()
            emit({"event": "close", "id": identifier})
            invocation.return_value(None)
            if identifier in issued:
                connection.emit_signal(None, PATH, INTERFACE, "NotificationClosed", GLib.Variant("(uu)", (identifier, 3)))
        else:
            invocation.return_dbus_error("org.freedesktop.DBus.Error.UnknownMethod", method)

    connection.register_object(PATH, Gio.DBusNodeInfo.new_for_xml(XML).interfaces[0], call, None, None)

    def command(channel, _condition):
        line = channel.readline()
        if not line:
            loop.quit()
            return False
        parts = line.split()
        if len(parts) == 3 and parts[0] == "invoke" and parts[1].isdigit() and int(parts[1]) in issued:
            identifier = int(parts[1])
            connection.emit_signal(None, PATH, INTERFACE, "ActionInvoked", GLib.Variant("(us)", (identifier, parts[2][:LIMIT])))
            connection.emit_signal(None, PATH, INTERFACE, "NotificationClosed", GLib.Variant("(uu)", (identifier, 2)))
            emit({"event": "invoked", "id": identifier, "action": parts[2][:LIMIT]})
        else:
            emit({"event": "rejected"})
        return True

    def acquired(_connection, _name):
        emit({"event": "ready"})

    Gio.bus_own_name_on_connection(connection, INTERFACE, Gio.BusNameOwnerFlags.DO_NOT_QUEUE, acquired, lambda *_: loop.quit())
    GLib.io_add_watch(GLib.IOChannel.unix_new(sys.stdin.fileno()), GLib.PRIORITY_DEFAULT, GLib.IOCondition.IN | GLib.IOCondition.HUP, command)
    loop.run()


if __name__ == "__main__":
    main()
