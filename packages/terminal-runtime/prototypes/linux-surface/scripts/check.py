#!/usr/bin/python3 -I
"""Drives the probe and checks what the compositor shows. Run it inside `virtual-kwin.sh` (see the architecture document).
usage: [POC_RENDER=vulkan] check.py wayland|x11 below|above OUTDIR [--probe PATH]   (POC_RENDER=vulkan: Wayland only, a wgpu Vulkan swapchain instead of wl_shm buffers)
Exit status 0 only when every check passed; OUTDIR gets the screenshots of each step and report.json."""
import json, os, subprocess, sys, time
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
mode, order, out = sys.argv[1:4]
probe = sys.argv[sys.argv.index("--probe") + 1] if "--probe" in sys.argv else os.path.join(HERE, "..", "target", "debug", "surface-poc")
os.makedirs(out, exist_ok=True)
env = dict(os.environ, POC_MODE=mode, POC_ORDER=order, WAYLAND_DISPLAY="kwin-poc")
scale = int(os.environ.get("POC_SCALE", "1"))
xserver = niri = None
if os.environ.get("POC_COMPOSITOR") == "niri":  # a second compositor, nested in KWin: niri draws into one KWin window that the screenshot sees
    config = os.path.join(os.environ["XDG_RUNTIME_DIR"], "niri.kdl")
    open(config, "w").write(f'xwayland-satellite {{ off; }}\nhotkey-overlay {{ skip-at-startup; }}\nlayout {{\n  gaps 0\n  default-column-width {{ proportion 1.0; }}\n}}\noutput "winit" {{ scale {scale}; }}\n')
    niri = subprocess.Popen(["niri", "-c", config], env=env, stdout=open(f"{out}/niri.log", "w"), stderr=subprocess.STDOUT)
    for _ in range(50):
        if os.path.exists(os.path.join(os.environ["XDG_RUNTIME_DIR"], "wayland-1")):
            break
        time.sleep(0.2)
    env["WAYLAND_DISPLAY"] = "wayland-1"
    time.sleep(2.0)
if mode == "x11":  # a real X server on the same compositor: an X11 client sees it exactly as on Xvfb
    xserver = subprocess.Popen(["Xwayland", ":9", "-geometry", "1280x800", "-noreset"], env=env, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if os.path.exists("/tmp/.X11-unix/X9"):
            break
        time.sleep(0.2)
    env["DISPLAY"] = ":9"
    del env["WAYLAND_DISPLAY"]
    time.sleep(1.0)
app = subprocess.Popen([probe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f"{out}/app.err", "w"), text=True, env=env, bufsize=1)
os.set_blocking(app.stdout.fileno(), False)
pending, page_log = "", []


def lines(seconds):
    global pending
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = app.stdout.read()
        except BlockingIOError:
            chunk = None
        if chunk:
            pending += chunk
        while "\n" in pending:
            line, pending = pending.split("\n", 1)
            if line.startswith("LOG "):
                page_log.append(line[4:])
            else:
                yield line
        time.sleep(0.05)


def command(line):
    app.stdin.write(line + "\n")
    app.stdin.flush()
    return next((l for l in lines(15) if l.startswith(("DONE", "ERR"))), "TIMEOUT")


def shot(name):
    path = f"{out}/{name}.png"
    if mode == "x11":
        subprocess.check_call(["import", "-display", ":9", "-window", "root", path])
    else:
        subprocess.check_call([os.path.join(HERE, "kwin_shot.py"), path])
    return np.array(Image.open(path).convert("RGB")).astype(int)


def region(img, rgb):
    mask = (np.abs(img - np.array(rgb)).max(axis=2) == 0)
    if not mask.any():
        return None
    ys, xs = np.where(mask)
    return {"n": int(mask.sum()), "x": int(xs.min()), "y": int(ys.min()), "w": int(xs.max() - xs.min() + 1), "h": int(ys.max() - ys.min() + 1)}


results, failures = [], []


def check(name, ok, detail):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    if not ok:
        failures.append(name)


GREEN, BLUE, RED = (0, 200, 0), (0x33, 0x66, 0xFF), (255, 0, 0)


def want(x, y, w, h):
    """The expected region in device pixels for a rectangle in the page's logical pixels."""
    return {"x": x * scale, "y": y * scale, "w": w * scale, "h": h * scale}


def measure(step, color):
    """Page origin from the DOM box's right and bottom edges, which no surface ever covers: the page paints it at (200,120) 140x100."""
    img = shot(step)
    dom, surface = region(img, RED), region(img, color)
    ox, oy = (dom["x"] + dom["w"] - 340 * scale, dom["y"] + dom["h"] - 220 * scale) if dom else (None, None)
    rel = None if not (surface and dom) else {"x": surface["x"] - ox, "y": surface["y"] - oy, "w": surface["w"], "h": surface["h"]}  # device pixels
    return img, surface, dom, (ox, oy), rel


time.sleep(5)  # the page loads and reports its anchor
command("create")
time.sleep(1.2)
img, surface, dom, (ox, oy), rel = measure("1-placed", GREEN)
check("placement matches the DOM anchor (240x160 at 60,40)", rel == want(60, 40, 240, 160), rel)
if os.environ.get("POC_RENDER") == "vulkan":
    check("the surface is presented by a wgpu Vulkan swapchain", "vulkan target on the subsurface" in open(f"{out}/app.err").read(), open(f"{out}/app.err").read()[-200:])
covered = tuple(int(v) for v in img[oy + 160 * scale, ox + 250 * scale]) if dom else None  # inside both the anchor and the DOM box
dom_above = covered == RED
check("a DOM box that overlaps the pane is drawn " + ("over" if order == "below" and mode == "wayland" else "under") + " the surface",
      dom_above == (order == "below" and mode == "wayland"), {"pixel_in_overlap": covered})
command("anchor 110 70 150 100")
time.sleep(1.2)
_, _, _, _, rel = measure("2-moved", GREEN)
check("the surface follows a changed anchor (150x100 at 110,70)", rel == want(110, 70, 150, 100), rel)
command("resize 1100 650")
time.sleep(1.5)
_, _, _, _, rel = measure("3-resized", GREEN)
check("a window resize keeps the surface at its anchor", rel == want(110, 70, 150, 100), rel)
command("destroy")
time.sleep(1.0)
_, surface, dom, _, _ = measure("4-destroyed", GREEN)
check("a destroyed surface leaves nothing on screen", surface is None and dom is not None, surface)
command("color 3366ff")
command("create")
time.sleep(1.2)
_, _, _, (ox, oy), rel = measure("5-recreated", BLUE)
check("a recreated surface shows the new colour exactly, at the anchor", rel == want(110, 70, 150, 100), rel)
if mode == "x11":
    command("focus")
    for name, (x, y) in {"on the surface": (rel["x"] + 20, rel["y"] + 20), "on a DOM field": (400, 50)}.items():
        page_log.clear()
        subprocess.check_call(["xdotool", "mousemove", str(ox + x), str(oy + y), "click", "1"], env=env)
        list(lines(0.6))
        check(f"a click {name} reaches the page at the same coordinates", any(f"at {x},{y}" in m for m in page_log), page_log[-1:])
    command("focus")
    page_log.clear()
    subprocess.check_call(["xdotool", "key", "x"], env=env)
    list(lines(0.6))
    check("a key press reaches the page with the surface mapped", any(m.startswith("keydown") for m in page_log), page_log[-1:])
command("quit")
try:
    app.wait(5)
except subprocess.TimeoutExpired:
    app.kill()
for proc in (xserver, niri):
    if proc:
        proc.terminate()
json.dump({"mode": mode, "order": order, "results": results}, open(f"{out}/report.json", "w"), indent=1)
for r in results:
    print("PASS" if r["ok"] else "FAIL", f"[{mode} {order}]", r["check"], "" if r["ok"] else r["detail"])
sys.exit(1 if failures else 0)
