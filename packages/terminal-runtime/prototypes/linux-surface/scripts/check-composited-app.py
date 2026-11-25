#!/usr/bin/env python3
"""Check a feature-enabled Lazysh app window on a logged-in Windows or macOS desktop."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

from PIL import Image, ImageGrab

HERE = Path(__file__).resolve().parent
import app_driver

DOM_OVERLAY = (200, 120, 140, 100)
FIRST_ANCHOR = (60, 40, 240, 160)
MOVED_ANCHOR = (110, 70, 150, 100)
CELL = (60, 160, 230)


def red(pixel):
    r, g, b = pixel
    return r >= 200 and g < 70 and b < 70


def box_of(image, predicate):
    mask = Image.new("L", image.size)
    mask.putdata([255 if predicate(pixel) else 0 for pixel in image.getdata()])
    return mask.getbbox()


def wait_for(sample, message, timeout=20):
    deadline = time.monotonic() + timeout
    while True:
        result = sample()
        if result is not None:
            return result
        if time.monotonic() >= deadline:
            raise RuntimeError(message)
        time.sleep(0.25)


def windows_window(pid):
    import ctypes
    from ctypes import wintypes

    user = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.IsWindowVisible.argtypes = [wintypes.HWND]
    user.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    matches = []

    @callback_type
    def visit(window, _):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value == pid and user.IsWindowVisible(window) and user.GetWindowTextLengthW(window):
            matches.append(window)
        return True

    if not user.EnumWindows(visit, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    return matches[0] if len(matches) == 1 else None


def run(app_path, out):
    out.mkdir(parents=True, exist_ok=True)
    home = out / "home"
    home.mkdir(exist_ok=True)
    windows = sys.platform == "win32"
    finder = out / "owned-window"
    environment = dict(os.environ, HOME=str(home))
    if windows:
        environment.update(APPDATA=str(home), LOCALAPPDATA=str(home), WEBVIEW2_USER_DATA_FOLDER=str(home / "webview"))
    else:
        swift = HERE.parents[1] / "macos-surface" / "scripts" / "owned-window.swift"
        subprocess.run(["swiftc", str(swift), "-o", str(finder)], check=True, timeout=90)

    server, commands, replies = app_driver.start()

    def command(line):
        commands.put(line)
        reply = replies.get(timeout=20)
        if not reply.startswith(f"DONE {line.split()[0]} "):
            raise RuntimeError(reply)
        return reply.split(" ", 2)[2]

    def capture(window, step):
        png = out / f"{step}.png"
        if windows:
            image = ImageGrab.grab(window=window).convert("RGB")
            image.save(png)
            return image
        subprocess.run(["screencapture", "-x", "-o", "-l", window, str(png)], check=True, timeout=15)
        with Image.open(png) as image:
            return image.convert("RGB")

    with server, (out / "app.log").open("w") as log:
        app = subprocess.Popen([str(app_path)], stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                               env=environment)
        try:
            ready = replies.get(timeout=120)
            if ready != "READY":
                raise RuntimeError(f"The Tauri fixture did not become ready: {ready}")

            def find_window():
                if app.poll() is not None:
                    raise RuntimeError(f"The app exited with status {app.returncode}")
                if windows:
                    return windows_window(app.pid)
                result = subprocess.run([str(finder), str(app.pid)], text=True, capture_output=True, timeout=5)
                return result.stdout.strip() if result.returncode == 0 else None

            window = wait_for(find_window, "No unique, visible app window")
            command("core 17 5")
            results = []

            def place(anchor):
                result = command("anchor " + " ".join(map(str, anchor)))
                state = json.loads(result[result.index("{"):])
                if not state["placed"] or not state["ready"]:
                    raise RuntimeError(f"App reports an unavailable surface: {state}")
                return state["width"] / anchor[2]

            scale = place(FIRST_ANCHOR)
            cell = json.loads(command("cell"))
            expected_width, expected_height = 4 * cell["width"], cell["height"]
            overlay_x, overlay_y, overlay_w, overlay_h = DOM_OVERLAY
            overlay_expected = (round(overlay_w * scale), round(overlay_h * scale))
            # Restrict the overlay match to WebView content. The close button in the title bar is also red.
            image = capture(window, "overlay-control")
            red_box = box_of(image.crop((0, round(overlay_y * scale), image.width, image.height)), red)
            if red_box is None or (red_box[2] - red_box[0], red_box[3] - red_box[1]) != overlay_expected:
                raise RuntimeError("The app window capture does not show the complete DOM overlay")
            origin = (red_box[0] - round(overlay_x * scale), red_box[1])

            def page(x, y):
                return (origin[0] + round(x * scale), origin[1] + round(y * scale))

            def marker(pixel):
                return max(abs(actual - expected) for actual, expected in zip(pixel, CELL)) <= 16

            def match(step, anchor):
                image = capture(window, step)
                region = box_of(image, marker)
                x, y = page(*anchor[:2])
                expected = (x, y, x + expected_width, y + expected_height)
                if not region or any(abs(a - b) > 1 for a, b in zip(region, expected)):
                    return None
                if not red(image.getpixel(page(220, 140))):
                    return None
                return {"step": step, "cellBox": region}

            command("paint " + " ".join(map(str, CELL)))
            results.append(wait_for(lambda: match("placed", FIRST_ANCHOR), "The renderer did not paint at the first anchor"))
            if place(MOVED_ANCHOR) != scale:
                raise RuntimeError("The app scale changed during the move")
            results.append(wait_for(lambda: match("moved", MOVED_ANCHOR), "The renderer did not move with the anchor"))

            command("destroy")
            if json.loads(command("state"))["placed"]:
                raise RuntimeError("The app still reports a placed surface after removal")

            def removed():
                image = capture(window, "removed")
                if box_of(image, marker) is None and red(image.getpixel(page(220, 140))):
                    return {"step": "removed"}
                return None

            results.append(wait_for(removed, "The removed terminal's pixels remained visible"))
            (out / "report.json").write_text(json.dumps({"scale": scale, "checks": results}, indent=2) + "\n")
        finally:
            if app.poll() is None:
                app.terminate()
            try:
                app.wait(timeout=5)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("output", type=Path)
    options = parser.parse_args()
    run(options.app.resolve(), options.output.resolve())
