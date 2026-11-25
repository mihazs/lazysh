#!/usr/bin/python3 -I
"""Drives the probe and checks what the compositor shows. Run it inside `virtual-kwin.sh` or `headless-sway.sh` (see the architecture document).
usage: [POC_RENDER=vulkan] check.py wayland|x11 below|above OUTDIR [--probe PATH | --app PATH]   (POC_RENDER=vulkan: Wayland only, a wgpu Vulkan swapchain instead of wl_shm buffers)
--app PATH runs the same checks against the real app instead of the probe: a debug build of lazysh with the `native-terminal` feature, which loads
its page from the dev URL. This script serves app-page.html there, and the page calls the app's own surface commands. On X11 the app must refuse.
Exit status 0 only when every check passed; OUTDIR gets the screenshots of each step and report.json."""
import atexit, glob, json, os, queue, subprocess, sys, time
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
mode, order, out = sys.argv[1:4]
probe = sys.argv[sys.argv.index("--probe") + 1] if "--probe" in sys.argv else os.path.join(HERE, "..", "target", "debug", "surface-poc")
real = sys.argv[sys.argv.index("--app") + 1] if "--app" in sys.argv else None
os.makedirs(out, exist_ok=True)
env = dict(os.environ, POC_MODE=mode, POC_ORDER=order, WAYLAND_DISPLAY=os.environ.get("POC_SOCKET", "kwin-poc"))
scale = int(os.environ.get("POC_SCALE", "1"))
xserver = niri = app = None
atexit.register(lambda: [p.kill() for p in (app, xserver, niri) if p and p.poll() is None])  # a crashed run must not leave a compositor or X server holding the caller's pipes
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
    xserver = subprocess.Popen(["Xvfb", ":9", "-screen", "0", "1280x800x24"] if os.environ.get("POC_XSERVER") == "xvfb" else ["Xwayland", ":9", "-geometry", "1280x800", "-noreset"], env=env, stderr=subprocess.DEVNULL)
    for _ in range(50):
        if os.path.exists("/tmp/.X11-unix/X9"):
            break
        time.sleep(0.2)
    env["DISPLAY"] = ":9"
    del env["WAYLAND_DISPLAY"]
    time.sleep(1.0)
if real:
    # The app's dev URL (tauri.conf.json). Its files go to a private home, so a run never reads or writes the user's own.
    sys.path.insert(0, HERE)
    import app_driver
    server, todo, done = app_driver.start()
    atexit.register(server.server_close)
    home = os.path.abspath(f"{out}/home")
    os.makedirs(home, exist_ok=True)
    env.update(LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU="1", HOME=home, XDG_CONFIG_HOME=f"{home}/config", XDG_DATA_HOME=f"{home}/data", XDG_CACHE_HOME=f"{home}/cache")
    app = subprocess.Popen([real], stdin=subprocess.DEVNULL, stdout=open(f"{out}/app.out", "w"), stderr=open(f"{out}/app.err", "w"), env=env)
else:
    app = subprocess.Popen([probe], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(f"{out}/app.err", "w"), text=True, env=env, bufsize=1)
    os.set_blocking(app.stdout.fileno(), False)
pending, page_log = "", []


def lines(seconds):
    global pending
    end = time.time() + seconds
    while time.time() < end:
        try:
            chunk = os.read(app.stdout.fileno(), 65536).decode()  # not .read(): a non-blocking text stream raises TypeError on Python 3.12
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


def sway(*message):
    """Asks the headless sway of this run; None under another compositor."""
    sockets = glob.glob(os.path.join(os.environ["XDG_RUNTIME_DIR"], "sway-ipc.*.sock"))
    return subprocess.check_output(["swaymsg", "-s", sockets[0], *message], text=True) if sockets else None


def window(node):
    """The app's window in sway's tree."""
    return node if node.get("pid") == app.pid else next(filter(None, map(window, node.get("nodes", []) + node.get("floating_nodes", []))), None)


def command(line):
    if real:  # the compositor resizes and measures the window, the app is stopped by a signal, and the page does the rest
        if line.startswith("resize"):
            return "DONE resize" if sway(f"[pid={app.pid}] resize set {line[7:]}") else "SKIP resize (not sway)"
        if line == "info":
            rect = window(json.loads(sway("-t", "get_tree")))["rect"]
            return f"DONE info toplevel={rect['width']}x{rect['height']} "
        if line == "quit":
            app.terminate()
            return "DONE quit"
        todo.put(line)
        try:
            return done.get(timeout=15)
        except queue.Empty:
            return "TIMEOUT"
    app.stdin.write(line + "\n")
    app.stdin.flush()
    return next((l for l in lines(15) if l.startswith(("DONE", "ERR"))), "TIMEOUT")


def shot(name):
    path = f"{out}/{name}.png"
    if mode == "x11":
        subprocess.check_call(["import", "-display", ":9", "-window", "root", path])
    elif os.environ.get("POC_CAPTURE") == "grim":
        subprocess.check_call(["grim", path], env=env)  # wlr-screencopy: every output at its own scale, so device pixels
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


GREEN, BLUE, RED, CELL = (0, 200, 0), (0x33, 0x66, 0xFF), (255, 0, 0), (200, 30, 30)


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


def finish():
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


if real:
    try:
        ready = done.get(timeout=120)  # the app starts and loads the page; from here every command has exactly one answer
    except queue.Empty:
        ready = "the page never loaded"
    check("the app loaded the page from its dev URL", ready == "READY", ready)
    asked = command("probe")
    if mode == "x11":  # no surface can sit below the page here: the probe must say so, and the host must refuse
        check("the probe refuses native on an X11 display and names it", '"available":false' in asked and "GdkX11Display" in asked, asked)
        refused = command("create")
        check("the host refuses a surface on X11", refused.startswith("ERR") and "Wayland only" in refused, refused)
        unplaced = command("state")
        check("no surface is reported as placed", '"placed":false' in unplaced, unplaced)
        time.sleep(1.0)
        img = shot("1-refused")
        check("nothing but the page is on screen", region(img, GREEN) is None and region(img, RED) is not None, region(img, GREEN))
        finish()
    check("the probe does not refuse the Wayland display", asked.startswith("DONE") and "the window is on" not in asked, asked)
time.sleep(5)  # the page loads and reports its anchor
for _ in range(30):  # a slow runner may need longer: `create` echoes the anchor it has, which is the page's once it has reported
    created = command("create")
    if "anchor=[60.0, 40.0, 240.0, 160.0]" in created:
        break
    command("destroy")
    time.sleep(2)
time.sleep(1.2)
img, surface, dom, (ox, oy), rel = measure("1-placed", GREEN)
check("placement matches the DOM anchor (240x160 at 60,40)", rel == want(60, 40, 240, 160), rel)
if real:
    check("the host reports the surface it placed, in device pixels", f'"placed":true,"ready":true,"generation":1,"width":{240 * scale},"height":{160 * scale}' in created, created)
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
resized = command("resize 1100 650").startswith("DONE")  # the app is resized by sway alone: under another compositor the step is not run
time.sleep(1.5)
_, _, _, _, rel = measure("3-resized", GREEN)
if resized:
    check("a window resize keeps the surface at its anchor", rel == want(110, 70, 150, 100), rel)
if os.environ.get("POC_CAPTURE") == "grim":  # headless-sway.sh floats the window, so the compositor must grant the size: the check above is not vacuous
    info = command("info")
    check("the compositor granted the resize (toplevel 1100x650)", "toplevel=1100x650 " in info, info)
command("destroy")
time.sleep(1.0)
_, surface, dom, _, _ = measure("4-destroyed", GREEN)
check("a destroyed surface leaves nothing on screen", surface is None and dom is not None, surface)
if real:
    gone = command("state")
    check("a removed surface is no longer reported as placed", '"placed":false' in gone, gone)
command("color 3366ff")
command("create")
time.sleep(1.2)
_, _, _, (ox, oy), rel = measure("5-recreated", BLUE)
check("a recreated surface shows the new colour exactly, at the anchor", rel == want(110, 70, 150, 100), rel)
if real and mode == "wayland":  # a real session: the renderer host draws the core's screen on the subsurface
    command("destroy")
    opened = command("core 17 5")
    check("a local terminal opens with a native core", opened.startswith("DONE core ") and len(opened) > 20, opened)
    time.sleep(3)  # the shell starts
    placed = command("anchor 110 70 150 100")
    check("the surface of the terminal is placed", placed.startswith("DONE anchor") and '"placed":true' in placed, placed)
    time.sleep(2)
    painted = command("paint")
    check("the terminal takes the painting command", painted.startswith("DONE paint"), painted)
    time.sleep(2)
    _, _, _, _, rel = measure("6-terminal", CELL)
    metric = lambda v: (v * 42 * scale + 20) // 40  # a cell of the 14 px font at this ratio: the renderer's metrics, rounded to whole pixels
    check("the core's four coloured cells are drawn at the top left of the surface, a whole cell grid wide and high",
          rel == want(110, 70, 0, 0) | {"w": 4 * metric(8), "h": metric(16)}, rel)
    command("destroy")
if mode == "x11":  # the probe only: the app refuses X11 above
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
finish()
