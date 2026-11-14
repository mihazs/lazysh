#!/usr/bin/env python3
"""A stand-in Chrome for the host browser relay tests: speaks the DevTools Protocol on the pipe a browser
started with --remote-debugging-pipe gets (commands on fd 3, replies and events on fd 4, each message ended by a
NUL byte), records what it was started with and every command it received, and streams fake screencast frames.
A helper process stays alive in the browser's process group so a test can prove the whole group is stopped."""
import base64, json, os, subprocess, sys, time

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
}
streaming, frames = False, 0


def send(message):
    writes.write(json.dumps(message).encode() + b"\0")


def frame():
    global frames
    frames += 1
    time.sleep(0.005)
    send({
        "method": "Page.screencastFrame", "sessionId": "S1",
        "params": {
            "data": base64.b64encode(JPEG + bytes([frames % 256])).decode(), "sessionId": frames,
            "metadata": {"deviceWidth": 412, "deviceHeight": 915, "scrollOffsetY": 7.5, "timestamp": 1700000000.5},
        },
    })
    if mode == "exit":
        os._exit(0)


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
            streaming = True
            info = {"targetId": "T1", "type": "page", "title": "Fixture page", "url": "http://127.0.0.1:3000/secret-path"}
            send({"method": "Target.targetInfoChanged", "params": {"targetInfo": info}})
            if mode == "close":
                send({"method": "Target.targetDestroyed", "params": {"targetId": "T1"}})
            frame()
        elif method == "Page.stopScreencast":
            streaming = False
        elif method == "Page.screencastFrameAck" and streaming:
            frame()
