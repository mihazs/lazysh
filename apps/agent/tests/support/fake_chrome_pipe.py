#!/usr/bin/env python3
"""A stand-in Chrome for the host browser relay tests: speaks the DevTools Protocol on the pipe a browser
started with --remote-debugging-pipe gets (commands on fd 3, replies and events on fd 4, each message ended by a
NUL byte), records what it was started with and every command it received, and streams fake screencast frames.
In FAKE_MODE=animate it is a page that changes every 1/60 s: frames come on that clock, every everyNthFrame-th, as
large as the quality and the size asked for make a text page (67 KB at q60 and 412 by 915), not once per
acknowledgement. A helper process stays alive in the browser's process group so a test can prove the whole group is stopped."""
import base64, json, os, subprocess, sys, threading, time

directory = os.environ["FAKE_BROWSER_DIR"]
args = sys.argv[1:]
profile = next(a.split("=", 1)[1] for a in args if a.startswith("--user-data-dir="))
with open(os.path.join(directory, "args"), "w") as f:
    f.write("\n".join(args) + "\n")
with open(os.path.join(profile, "Cookies"), "w") as f:
    f.write("session-cookie")
helper = subprocess.Popen(["sleep", "600"])
for name, pid in (("helper", helper.pid), ("browser", os.getpid())):
    with open(os.path.join(directory, name), "w") as f:
        f.write(str(pid))

mode = os.environ.get("FAKE_MODE", "")
product = os.environ.get("FAKE_PRODUCT", "Chrome/120.0.6099.109")
commands = open(os.path.join(directory, "commands"), "a")
reads, writes = os.fdopen(3, "rb", buffering=0), os.fdopen(4, "wb", buffering=0)
JPEG = b"\xff\xd8fake-jpeg\xff\xd9"
KNOWN = {
    "Target.setDiscoverTargets", "Page.enable", "Browser.setDownloadBehavior",
    "Page.setInterceptFileChooserDialog", "Emulation.setDeviceMetricsOverride",
    "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck",
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setPageScaleFactor",
}
streaming, frames, screencast = False, 0, {}
animate = mode == "animate"
lock = threading.Lock()


def send(message):
    with lock:
        writes.write(json.dumps(message).encode() + b"\0")


def frame():
    global frames
    frames += 1
    if animate:
        pixels = screencast["maxWidth"] * screencast["maxHeight"]
        payload = b"\0" * int(1120 * screencast["quality"] * pixels / (412 * 915))
    else:
        time.sleep(0.005)
        payload = bytes([frames % 256])
    send({
        "method": "Page.screencastFrame", "sessionId": "S1",
        "params": {
            "data": base64.b64encode(JPEG + payload).decode(), "sessionId": frames,
            "metadata": {"deviceWidth": 412, "deviceHeight": 915, "scrollOffsetY": 7.5, "timestamp": 1700000000.5},
        },
    })
    if mode == "exit":
        os._exit(0)


def animation():
    produced = 0
    while True:
        time.sleep(1 / 60)
        produced += 1
        if streaming and produced % screencast["everyNthFrame"] == 0:
            frame()


if animate:
    threading.Thread(target=animation, daemon=True).start()
buffer = b""
while True:
    chunk = reads.read(65536)
    if not chunk:
        break
    buffer += chunk
    while b"\0" in buffer:
        raw, buffer = buffer.split(b"\0", 1)
        commands.write(raw.decode() + "\n")
        commands.flush()
        message = json.loads(raw)
        method = message["method"]
        result = {}
        if method == "Browser.getVersion":
            result = {"product": product}
        elif method == "Target.getTargets":
            result = {"targetInfos": [{"targetId": "T1", "type": "page", "title": "", "url": "about:blank"}]}
        elif method == "Target.attachToTarget":
            result = {"sessionId": "S1"}
        elif method not in KNOWN:
            send({"id": message["id"], "error": {"code": -32601, "message": "not found"}})
            continue
        send({"id": message["id"], "result": result})
        if method == "Page.startScreencast":
            streaming, screencast = True, message["params"]
            info = {"targetId": "T1", "type": "page", "title": "Fixture page", "url": "http://127.0.0.1:3000/secret-path"}
            send({"method": "Target.targetInfoChanged", "params": {"targetInfo": info}})
            if mode == "close":
                send({"method": "Target.targetDestroyed", "params": {"targetId": "T1"}})
            frame()
        elif method == "Page.stopScreencast":
            streaming = False
        elif method == "Page.screencastFrameAck" and streaming and not animate:
            frame()
