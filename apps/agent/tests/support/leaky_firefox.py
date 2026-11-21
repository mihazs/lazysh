#!/usr/bin/env python3
"""Stands between the host browser relay and a real Firefox (REAL_FIREFOX) so that a test can give the relay a
Firefox that already holds a BiDi session, which is what a client that dropped without ending its session leaves
behind. The first start runs Firefox on a profile of its own, opens a session in it, drops the connection without
ending the session, and only then shows the relay where Firefox listens. Every later start is the real Firefox,
unchanged."""
import base64, json, os, shutil, socket, struct, subprocess, sys, time

directory, real = os.environ["FAKE_BROWSER_DIR"], os.environ["REAL_FIREFOX"]
args = sys.argv[1:]
with open(os.path.join(directory, "launches"), "a") as f:
    f.write("launch\n")
if len(open(os.path.join(directory, "launches")).read().split()) > 1:
    os.execv(real, [real] + args)

profile = args[args.index("--profile") + 1]
leaky = os.path.join(directory, "leaky-profile")
os.mkdir(leaky)
shutil.copy(os.path.join(profile, "user.js"), leaky)
firefox = subprocess.Popen([real] + [leaky if arg == profile else arg for arg in args])
with open(os.path.join(directory, "leaked-pid"), "w") as f:
    f.write(str(firefox.pid))
endpoint = os.path.join(leaky, "WebDriverBiDiServer.json")
while True:
    try:
        port = json.load(open(endpoint))["ws_port"]
        break
    except (OSError, ValueError):
        time.sleep(0.05)

conn = socket.create_connection(("127.0.0.1", port))
key = base64.b64encode(os.urandom(16)).decode()
conn.sendall(f"GET /session HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode())
reply = b""
while b"\r\n\r\n" not in reply:
    reply += conn.recv(4096)
body = json.dumps({"id": 1, "method": "session.new", "params": {"capabilities": {}}}).encode()
mask = os.urandom(4)
conn.sendall(bytes([0x81, 0x80 | len(body)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(body)))
conn.recv(65536)  # the session exists
conn.close()  # and is never ended
shutil.copy(endpoint, os.path.join(profile, "WebDriverBiDiServer.json"))
firefox.wait()
