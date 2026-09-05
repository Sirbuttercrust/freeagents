#!/usr/bin/env python3
"""Preview server for these wireframes. Threading, and no-cache.

WHY IT IS COMMITTED. An earlier version of this file lived in a temp
directory, on the reasoning that it was session scaffolding rather than a
deliverable in a public repo. That reasoning was wrong, and a review caught
it: every gate in this directory measures a rendered page, so a reviewer who
cannot start the server cannot run a single one of them. A prerequisite for
running the checks is part of the deliverable.

Two things it fixes over `python3 -m http.server`, both of which cost real
time on this tree:

  1. THREADING. `http.server` is single threaded, so one hung keep-alive
     socket, typically a leaked headless Chrome, wedges the whole server. It
     keeps LISTENing and answers with empty replies, which looks exactly like
     a crashed process while the process is perfectly healthy.
  2. `no-store` on every response, plus `GET /healthz` returning a build
     fingerprint and the size of every served file. Without it, "the server
     is dead" and "your browser is showing you a cached page" are the same
     symptom. With it, the question is settled by loading one URL.

Usage:

    python3 devserver.py                 # port 3111, serves this directory
    python3 devserver.py 8080 --dir ..   # explicit port and root

Binds 0.0.0.0 on purpose. A 127.0.0.1 bind answers local curl with 200 while
being invisible from every other device on the network, which is the most
misleading failure available because every check you run passes.
"""

import hashlib
import http.server
import os
import socketserver
import sys

TRACKED_EXTS = (".html", ".css", ".js")

PORT = 3111
ROOT = os.path.dirname(os.path.abspath(__file__))

args = sys.argv[1:]
if args and args[0].isdigit():
    PORT = int(args[0])
if "--dir" in args:
    ROOT = os.path.abspath(args[args.index("--dir") + 1])


def fingerprint():
    """Hash over every served asset, plus per-file sizes.

    The sizes are what make a stale cache obvious: a file the browser never
    fetched has a size here and is absent from the access log.
    """
    h = hashlib.sha1()
    lines = []
    for entry in sorted(os.listdir(ROOT)):
        if not entry.endswith(TRACKED_EXTS):
            continue
        with open(os.path.join(ROOT, entry), "rb") as fh:
            data = fh.read()
        h.update(data)
        lines.append("%s:%d" % (entry, len(data)))
    return h.hexdigest()[:12], lines


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control",
                         "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path.rstrip("/") == "/healthz":
            build, lines = fingerprint()
            body = ("build %s\n\n" % build + "\n".join(lines) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, format, *a):
        sys.stderr.write("%s - %s\n" % (self.address_string(), format % a))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    build, _ = fingerprint()
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        sys.stderr.write("serving %s on 0.0.0.0:%d  build %s\n"
                         % (ROOT, PORT, build))
        httpd.serve_forever()
