"""Owned pointer for the private native GUI display, which has no window manager.

Without a window manager the display's keyboard focus follows the pointer, so
the pointer leaving or entering the application window is how that window loses
or gains focus. The X server returns the pointer to the display centre as soon
as the client that moved it disconnects, so this process keeps one connection
for as long as it runs. It prints `{"event":"ready"}`, then reads one command
per stdin line: `leave` warps the pointer to the display's last pixel, outside
the window, and `enter` warps it back to where `leave` found it. Each command
prints one `{"event":"leave"|"enter","x":...,"y":...}` line once the server
has applied it.
"""
import ctypes
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I keeps this directory off the path
from ownedBus import emit


def main():
    x11 = ctypes.CDLL("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDisplayWidth.argtypes = x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_void_p] * 7
    x11.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong] + [ctypes.c_int] * 6
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    if not display:
        raise SystemExit("The owned X display is unavailable")
    root = x11.XDefaultRootWindow(display)

    def position():
        window, x, y, unused, mask = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
        x11.XQueryPointer(display, root, ctypes.byref(window), ctypes.byref(window), ctypes.byref(x), ctypes.byref(y),
                          ctypes.byref(unused), ctypes.byref(unused), ctypes.byref(mask))
        return x.value, y.value

    def warp(x, y):
        x11.XWarpPointer(display, 0, root, 0, 0, 0, 0, x, y)
        x11.XSync(display, 0)
        return position()

    corner = (x11.XDisplayWidth(display, 0) - 1, x11.XDisplayHeight(display, 0) - 1)
    home = position()
    emit({"event": "ready"})
    for line in sys.stdin:
        command = line.strip()
        if command == "leave":
            if position() != corner:
                home = position()
            x, y = warp(*corner)
        elif command == "enter":
            x, y = warp(*home)
        else:
            raise SystemExit("usage: leave | enter")
        emit({"event": command, "x": x, "y": y})
    x11.XCloseDisplay(display)


if __name__ == "__main__":
    main()
