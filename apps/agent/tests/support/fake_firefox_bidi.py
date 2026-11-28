#!/usr/bin/env python3
"""A stand-in Firefox for the host browser relay tests: serves WebDriver BiDi over WebSocket on a random loopback
port the way Firefox does (the port is written to WebDriverBiDiServer.json in the profile, a `Host` without the
real port or any `Origin` is refused, and only one session exists at a time), records what it was started with and
every command it received, and answers with fake screenshots. A helper process stays alive in the browser's
process group so that a test can prove the whole group is stopped."""
import base64, hashlib, json, os, socket, struct, subprocess, sys, threading, time

directory = os.environ["FAKE_BROWSER_DIR"]
args = sys.argv[1:]
profile = args[args.index("--profile") + 1]
mode = os.environ.get("FAKE_MODE", "")
version = os.environ.get("FAKE_VERSION", "160.0")


def record(name, text, mode="w"):
    with open(os.path.join(directory, name), mode) as f:
        f.write(text)


record("launches", "launch\n", "a")
launches = len(open(os.path.join(directory, "launches")).read().split())
record("args", "\n".join(args) + "\n")
record("env", "\n".join(k for k in os.environ if k.startswith("MOZ_")) + "\n")
open(os.path.join(profile, "cookies.sqlite"), "w").write("session-cookie")
helper = subprocess.Popen(["sleep", "600"])
for name, pid in (("helper", helper.pid), ("browser", os.getpid())):
    record(name, str(pid))
    # Every launch, so that a test can prove that a replaced browser is gone too.
    record("pids", f"{pid}\n", "a")

commands = open(os.path.join(directory, "commands"), "a")
lock = threading.Lock()
# A browser that already holds a session when the relay arrives: the first launch, or every launch.
session_open = mode == "leak-always" or (mode == "leak-first" and launches == 1)
captures = 0
JPEG = b"\xff\xd8fake-jpeg\xff\xd9"
page_url = next((a for a in args if a.startswith(("http://", "https://", "about:"))), "about:blank")
# The top-level contexts, in the order they were made: each has its history (`entries`, the shown one at `index`),
# and the context that opened it. A navigation to an address containing "popup" opens another context from it.
contexts = {"C1": {"entries": [page_url], "index": 0, "opener": None}}
made = 1


def shown(context):
    return context["entries"][context["index"]]


def title_of(context):
    return "Fixture page" if shown(context) == page_url else "Title of " + shown(context).split("://", 1)[-1]


def answer(message):
    """The reply to one command, or None to say nothing."""
    global session_open, captures, made
    method, id = message["method"], message["id"]
    ok = lambda result: {"type": "success", "id": id, "result": result}
    error = lambda name, text: {"type": "error", "id": id, "error": name, "message": text}
    with lock:
        if method == "session.new":
            if session_open:
                return error("session not created", "Maximum number of active sessions")
            session_open = True
            return ok({"sessionId": "S1", "capabilities": {"browserName": "firefox", "browserVersion": version}})
        if method == "session.end":
            session_open = False
            return ok({})
        if not session_open:
            return error("invalid session id", "no session")
        params = message.get("params", {})
        context = contexts.get(params.get("context"))
        if method == "browsingContext.getTree":
            gone = mode == "close" and captures > 0
            return ok({"contexts": [] if gone else [
                {"context": name, "parent": None, "url": shown(c), "children": [],
                 **({"originalOpener": c["opener"]} if c["opener"] else {})}
                for name, c in contexts.items()]})
        if method == "browsingContext.create":
            made += 1
            contexts[f"C{made}"] = {"entries": ["about:blank"], "index": 0, "opener": None}
            return ok({"context": f"C{made}", "userContext": "default"})
        if method in ("browsingContext.navigate", "browsingContext.reload", "browsingContext.traverseHistory",
                      "browsingContext.close", "browsingContext.activate", "browsingContext.setViewport",
                      "browsingContext.captureScreenshot", "script.evaluate") and context is None:
            context = contexts.get(params.get("target", {}).get("context"))
            if context is None:
                return error("no such frame", "no such context")
        if method == "browsingContext.navigate":
            context["entries"][context["index"] + 1:] = [params["url"]]
            context["index"] += 1
            # "popup" opens one page from this one, "popups" a page that opens windows without end.
            for _ in range(20 if "popups" in params["url"] else "popup" in params["url"]):
                made += 1
                contexts[f"C{made}"] = {"entries": ["http://127.0.0.1:3000/popped"], "index": 0, "opener": params["context"]}
            return ok({"navigation": "N1", "url": params["url"]})
        if method == "browsingContext.reload":
            return ok({"navigation": "N2", "url": shown(context)})
        if method == "browsingContext.traverseHistory":
            at = context["index"] + params["delta"]
            if not 0 <= at < len(context["entries"]):
                return error("no such history entry", "no such history entry")
            context["index"] = at
            return ok({})
        if method == "browsingContext.close":
            del contexts[params["context"]]
            return ok({})
        if method in ("browsingContext.activate", "browsingContext.setViewport"):
            return ok({})
        if method == "browsingContext.captureScreenshot":
            captures += 1
            if mode == "exit" and captures > 1:
                os._exit(0)
            if mode == "close" and captures > 1:
                return error("no such frame", "gone")
            time.sleep(0.005)
            same = mode == "same"
            # The context is in the picture, so that a test can tell which page streams.
            tag = params["context"].encode()
            return ok({"data": base64.b64encode(JPEG + tag + (b"" if same else bytes([captures % 256]))).decode()})
        if method == "input.performActions":
            if mode == "input-error":
                return error("invalid argument", "bad sequence")
            return ok({})
        if method == "input.releaseActions":
            return ok({})
        if method == "script.evaluate":
            return ok({"type": "success", "realm": "R1", "result": {"type": "string", "value": title_of(context)}})
    return error("unknown command", method)


def read_exact(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def send(conn, opcode, payload):
    head = bytes([0x80 | opcode])
    if len(payload) < 126:
        head += bytes([len(payload)])
    elif len(payload) < 65536:
        head += bytes([126]) + struct.pack(">H", len(payload))
    else:
        head += bytes([127]) + struct.pack(">Q", len(payload))
    conn.sendall(head + payload)


def serve(conn, port):
    try:
        raw = b""
        while b"\r\n\r\n" not in raw:
            chunk = conn.recv(4096)
            if not chunk:
                return
            raw += chunk
        lines = raw.split(b"\r\n\r\n")[0].decode().split("\r\n")
        headers = {k.lower(): v for k, v in (l.split(": ", 1) for l in lines[1:] if ": " in l)}
        # Firefox refuses a Host that does not carry its real port, and any Origin.
        if headers.get("host") != f"127.0.0.1:{port}" or "origin" in headers:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
            return
        if lines[0].split(" ")[1] != "/session":
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
            return
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        conn.sendall(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
        while True:
            b0, b1 = read_exact(conn, 2)
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", read_exact(conn, 2))[0]
            elif length == 127:
                length = struct.unpack(">Q", read_exact(conn, 8))[0]
            mask = read_exact(conn, 4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(read_exact(conn, length)))
            opcode = b0 & 0x0F
            if opcode == 8:
                return
            if opcode == 9:
                send(conn, 10, payload)
            elif opcode == 1:
                with lock:
                    commands.write(payload.decode() + "\n")
                    commands.flush()
                reply = answer(json.loads(payload))
                if reply is not None:
                    send(conn, 1, json.dumps(reply).encode())
    except (EOFError, OSError):
        pass
    finally:
        conn.close()


server = socket.socket()
server.bind(("127.0.0.1", 0))
server.listen(8)
port = server.getsockname()[1]
with open(os.path.join(profile, "WebDriverBiDiServer.json"), "w") as f:
    json.dump({"ws_host": "127.0.0.1", "ws_port": port}, f)
while True:
    conn, _ = server.accept()
    threading.Thread(target=serve, args=(conn, port), daemon=True).start()
