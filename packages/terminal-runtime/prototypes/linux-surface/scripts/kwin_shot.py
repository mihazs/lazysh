#!/usr/bin/python3 -I
"""Writes a PNG of the whole KWin workspace (org.kde.KWin.ScreenShot2). usage: kwin_shot.py OUT.png"""
import gc, os, subprocess, sys
import gi
gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib

out = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
read_end, write_end = os.pipe()
fds = Gio.UnixFDList()
args = GLib.Variant("(a{sv}h)", ({"native-resolution": GLib.Variant("b", True), "include-cursor": GLib.Variant("b", False)}, fds.append(write_end)))
meta = bus.call_with_unix_fd_list_sync("org.kde.KWin", "/org/kde/KWin/ScreenShot2", "org.kde.KWin.ScreenShot2", "CaptureWorkspace",
                                       args, GLib.VariantType("(a{sv})"), Gio.DBusCallFlags.NONE, 10000, fds, None)[0].unpack()[0]
os.close(write_end)
del fds, args
gc.collect()  # the pipe reaches EOF only once every copy of the write end is closed
with os.fdopen(read_end, "rb") as f:
    raw = f.read()
width, height, fmt = meta["width"], meta["height"], meta["format"]
# QImage formats: 4, 5 and 6 are BGRA in memory; 16 and 17 are RGB(A) with an unused or real alpha byte.
order = "bgra" if fmt in (4, 5, 6) else "rgba"
subprocess.run(["magick", "-size", f"{width}x{height}", "-depth", "8", f"{order}:-", "-alpha", "off", out], input=raw, check=True)
