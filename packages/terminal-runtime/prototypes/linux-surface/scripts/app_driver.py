"""Serve the real app's Tauri terminal surface fixture on its development URL."""
import http.server
import queue
import threading
from pathlib import Path


def start(port=1420):
    """Return the server and the page's command and response queues."""
    html = Path(__file__).with_name("app-page.html").read_bytes()
    commands, replies = queue.Queue(), queue.Queue()

    class Page(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = html if self.path == "/" else commands.get().encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html" if self.path == "/" else "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            replies.put(self.rfile.read(int(self.headers["Content-Length"])).decode())
            self.send_response(204)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, commands, replies
