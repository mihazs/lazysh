#!/usr/bin/env python3
"""A stand-in Chrome for the host browser relay tests: speaks the DevTools Protocol on the pipe a browser
started with --remote-debugging-pipe gets (commands on fd 3, replies and events on fd 4, each message ended by a
NUL byte), records what it was started with and every command it received, and streams fake screencast frames.
A helper process stays alive in the browser's process group so a test can prove the whole group is stopped.

It keeps pages (targets) with a navigation history each. Navigating a page to one of these paths makes it do what
a real page does that a test cannot make a fake page do otherwise: /popup opens a second page that names the
first as its opener, /dialog asks a confirm question, /download starts a download and /chooser opens a file
chooser."""
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
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Emulation.setPageScaleFactor",
    "Target.activateTarget", "Page.stopLoading",
}
# Each page: its address, title and history (the addresses visited and which one is shown).
targets = {"T1": {"url": "about:blank", "title": "", "history": ["about:blank"], "at": 0, "opener": None}}
sessions = {}
streaming, frames, created, attached = None, 0, 1, 0


def send(message):
    writes.write(json.dumps(message).encode() + b"\0")


def info(id):
    page = targets[id]
    result = {"targetId": id, "type": "page", "title": page["title"], "url": page["url"]}
    if page["opener"]:
        result["openerId"] = page["opener"]
    return result


def session_of(id):
    return next((session for session, target in sessions.items() if target == id), None)


def event(method, params, session=None):
    message = {"method": method, "params": params}
    if session:
        message["sessionId"] = session
    send(message)


def frame():
    global frames
    frames += 1
    time.sleep(0.005)
    send({
        "method": "Page.screencastFrame", "sessionId": streaming,
        "params": {
            "data": base64.b64encode(JPEG + bytes([frames % 256])).decode(), "sessionId": frames,
            "metadata": {"deviceWidth": 412, "deviceHeight": 915, "scrollOffsetY": 7.5, "timestamp": 1700000000.5},
        },
    })
    if mode == "exit":
        os._exit(0)


def title_of(url):
    return "Title of " + url.split("//", 1)[-1]


def load(id, url):
    """What a page does when it loads an address. Chromium's change notice carries a title made of the address
    (measured), and the real title is only in the target list afterwards."""
    global created
    page = targets[id]
    page["url"], page["title"] = url, title_of(url)
    session = session_of(id)
    event("Page.frameStartedLoading", {"frameId": id}, session)
    event("Target.targetInfoChanged", {"targetInfo": {**info(id), "title": url.split("//", 1)[-1]}})
    event("Page.frameStoppedLoading", {"frameId": id}, session)
    path = url.split("//", 1)[-1].partition("/")[2]
    if path == "popup":
        created += 1
        new = f"T{created}"
        popup = "http://fake.test/popup-page"
        targets[new] = {"url": "", "title": "", "history": [popup], "at": 0, "opener": id}
        event("Target.targetCreated", {"targetInfo": info(new)})
        load(new, popup)
    elif path == "dialog":
        event("Page.javascriptDialogOpening", {"url": url, "type": "confirm", "message": "Leave the page?", "defaultPrompt": ""}, session)
    elif path == "download":
        event("Browser.downloadWillBegin", {"url": url, "suggestedFilename": "loot.bin"})
    elif path == "chooser":
        event("Page.fileChooserOpened", {"mode": "selectSingle"}, session)


def handle(message):
    """The reply's result, or None for an error, and what to send after the reply."""
    global streaming, created, attached
    method, params = message["method"], message.get("params", {})
    id = sessions.get(message.get("sessionId"))
    after = []
    if method == "Browser.getVersion":
        return {"product": product}, after
    if method == "Target.getTargets":
        listed = [info(target) for target in targets]
        if mode == "ghost":
            # A page that the browser lists and cannot be attached to: it closed in between.
            listed.append({"targetId": "T9", "type": "page", "title": "Ghost", "url": "about:blank"})
        return {"targetInfos": listed}, after
    if method == "Target.attachToTarget":
        if params["targetId"] not in targets:
            return None, after
        attached += 1
        sessions[f"S{attached}"] = params["targetId"]
        return {"sessionId": f"S{attached}"}, after
    if method == "Target.detachFromTarget":
        sessions.pop(params["sessionId"], None)
        if streaming == params["sessionId"]:
            streaming = None
        after.append(lambda: event("Target.detachedFromTarget", {"sessionId": params["sessionId"]}))
        return {}, after
    if method == "Target.createTarget":
        created += 1
        new = f"T{created}"
        targets[new] = {"url": params["url"], "title": title_of(params["url"]), "history": [params["url"]], "at": 0, "opener": None}
        after.append(lambda: event("Target.targetCreated", {"targetInfo": info(new)}))
        return {"targetId": new}, after
    if method == "Target.closeTarget":
        gone = params["targetId"]
        targets.pop(gone, None)
        for session in [s for s, target in sessions.items() if target == gone]:
            del sessions[session]
            after.append(lambda session=session: event("Target.detachedFromTarget", {"sessionId": session}))
        after.append(lambda: event("Target.targetDestroyed", {"targetId": gone}))
        return {"success": True}, after
    if method == "Page.navigate":
        page = targets[id]
        page["history"] = page["history"][: page["at"] + 1] + [params["url"]]
        page["at"] += 1
        after.append(lambda: load(id, params["url"]))
        return {"frameId": id}, after
    if method == "Page.getNavigationHistory":
        page = targets[id]
        entries = [{"id": 100 + n, "url": url} for n, url in enumerate(page["history"])]
        return {"currentIndex": page["at"], "entries": entries}, after
    if method == "Page.navigateToHistoryEntry":
        page = targets[id]
        page["at"] = params["entryId"] - 100
        after.append(lambda: load(id, page["history"][page["at"]]))
        return {}, after
    if method == "Page.reload":
        after.append(lambda: load(id, targets[id]["url"]))
        return {}, after
    if method == "Page.handleJavaScriptDialog":
        after.append(lambda: event("Page.javascriptDialogClosed", {"result": params["accept"], "userInput": params.get("promptText", "")}, message.get("sessionId")))
        return {}, after
    if method not in KNOWN:
        return None, after
    if method == "Page.startScreencast":
        streaming = message["sessionId"]
        if id == "T1" and targets["T1"]["url"] == "about:blank":
            fixture = "http://127.0.0.1:3000/secret-path"
            targets["T1"].update(title="Fixture page", url=fixture, history=[fixture])
        after.append(lambda: event("Target.targetInfoChanged", {"targetInfo": info(id)}))
        if mode == "close":
            after.append(lambda: event("Target.targetDestroyed", {"targetId": id}))
        after.append(frame)
    elif method == "Page.stopScreencast":
        streaming = None
    elif method == "Page.screencastFrameAck" and streaming:
        after.append(frame)
    return {}, after


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
        result, after = handle(message)
        if result is None:
            send({"id": message["id"], "error": {"code": -32601, "message": "not found"}})
            continue
        send({"id": message["id"], "result": result})
        for step in after:
            step()
