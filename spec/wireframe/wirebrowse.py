#!/usr/bin/env python3
"""wirebrowse - a headless Chrome driver for the wireframe gates.

WHY THIS FILE IS IN THE REPO. Every gate that measures a rendered page needs a
browser. Pointing them at a script that lives outside the repo makes the whole
suite unrunnable by anybody else: a reviewer clones the tree, runs the gates,
and gets an ImportError naming a file they have no way to obtain. A gate a
reviewer cannot run is a claim, not a check.

So this is deliberately SELF CONTAINED:

  * standard library only. No websocket-client, no requests, no sharp, no npm.
    The WebSocket client below is about eighty lines of RFC 6455 against a
    loopback socket, which is cheaper than asking a reviewer to install a
    package before they are allowed to disagree with us.
  * no absolute paths. Chrome is discovered across macOS, Linux and Windows
    layouts, and CHROME_BIN overrides the search.
  * no shared state with any other browser. It drives a throwaway profile on a
    private debug port, so it cannot wedge, and cannot be wedged by, anything
    else on the machine.

If no Chrome is found it exits 3 with the list of places it looked. Three,
because a gate exiting 1 means "the thing I measure is broken" and a missing
browser is a different fact that must not be read as a pass or a failure.

Usage as a library:

    from wirebrowse import Browser
    b = Browser(width=320, height=640, mobile=True)
    try:
        b.goto("http://127.0.0.1:3111/agreement.html")
        print(b.js("document.title"))
    finally:
        b.close()

Usage from a shell, to check the driver itself works:

    python3 wirebrowse.py probe http://127.0.0.1:3111/agreement.html
    python3 wirebrowse.py eval  http://127.0.0.1:3111/ --js "document.title"
"""

import base64
import glob
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request

CHROME_ENV = "CHROME_BIN"

# Ordered by how likely a machine running these gates has one. Globs are
# expanded, so a versioned Chrome-for-Testing download is found without the
# version being written down anywhere.
CHROME_CANDIDATES = [
    "~/.agent-browser/browsers/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "~/.cache/puppeteer/chrome/*/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "~/.cache/puppeteer/chrome/*/chrome-linux64/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
]

NO_BROWSER_EXIT = 3


class NoBrowser(Exception):
    """No Chrome on this machine. Distinct from a gate failure."""


def chrome_bin():
    explicit = os.environ.get(CHROME_ENV)
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise NoBrowser("%s=%s does not exist" % (CHROME_ENV, explicit))
    for pattern in CHROME_CANDIDATES:
        hits = sorted(glob.glob(os.path.expanduser(pattern)))
        if hits:
            return hits[-1]
    raise NoBrowser(
        "no Chrome found. Set %s to a Chrome or Chromium binary.\nLooked in:\n  %s"
        % (CHROME_ENV, "\n  ".join(CHROME_CANDIDATES)))


# ----------------------------------------------------------------- websocket
# A minimal RFC 6455 client. Loopback only, so no TLS and no proxy handling.
# Server frames arrive unmasked; client frames must be masked. Continuation
# frames matter here because a serialized DOM easily exceeds one frame.

class _WS(object):
    def __init__(self, url, timeout=90):
        if not url.startswith("ws://"):
            raise ValueError("expected ws:// url, got %r" % url)
        rest = url[len("ws://"):]
        hostport, _, path = rest.partition("/")
        host, _, port = hostport.partition(":")
        self.sock = socket.create_connection((host, int(port or 80)), timeout=20)
        self.sock.settimeout(timeout)
        self.fh = self.sock.makefile("rb")

        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET /%s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n" % (path, hostport, key)
        )
        self.sock.sendall(req.encode())

        status = self.fh.readline().decode("latin-1").strip()
        if "101" not in status:
            raise RuntimeError("websocket handshake refused: %s" % status)
        while True:                      # drain the response headers
            line = self.fh.readline()
            if line in (b"\r\n", b"\n", b""):
                break

    def send(self, text):
        payload = text.encode("utf-8")
        header = bytearray()
        header.append(0x81)              # FIN + text frame
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        mask = os.urandom(4)
        header += mask
        masked = bytearray(payload)
        for i in range(n):
            masked[i] ^= mask[i & 3]
        self.sock.sendall(bytes(header) + bytes(masked))

    def _read_exact(self, n):
        buf = self.fh.read(n)
        if buf is None or len(buf) != n:
            raise ConnectionError("websocket closed mid frame")
        return buf

    def _frame(self):
        b0, b1 = self._read_exact(2)
        fin = bool(b0 & 0x80)
        opcode = b0 & 0x0F
        masked = bool(b1 & 0x80)
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read_exact(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read_exact(8))[0]
        mask = self._read_exact(4) if masked else None
        data = self._read_exact(n) if n else b""
        if mask:
            data = bytes(c ^ mask[i & 3] for i, c in enumerate(data))
        return fin, opcode, data

    def recv(self):
        chunks = []
        while True:
            fin, opcode, data = self._frame()
            if opcode == 0x8:                      # close
                raise ConnectionError("websocket closed by peer")
            if opcode == 0x9:                      # ping -> pong, keep reading
                self._pong(data)
                continue
            if opcode == 0xA:                      # pong, ignore
                continue
            chunks.append(data)
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def _pong(self, data):
        mask = os.urandom(4)
        payload = bytearray(data)
        for i in range(len(payload)):
            payload[i] ^= mask[i & 3]
        self.sock.sendall(bytes([0x8A, 0x80 | len(data)]) + mask + bytes(payload))

    def close(self):
        try:
            self.sock.sendall(b"\x88\x80" + os.urandom(4))
        except Exception:
            pass
        for f in (self.fh, self.sock):
            try:
                f.close()
            except Exception:
                pass


# -------------------------------------------------------------------- driver

def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Browser(object):
    """One throwaway headless Chrome, driven over CDP.

    The API is deliberately small: goto, js, send, shot, close. Gates that
    need anything else reach for send() and speak CDP directly, which keeps
    this file from growing a second personality as a test framework.
    """

    def __init__(self, width=1440, height=900, headful=False, mobile=False,
                 scale=1, touch=False):
        self.port = free_port()
        self.profile = os.path.join(
            os.environ.get("TMPDIR", "/tmp"), "wirebrowse-%d" % self.port)
        args = [
            chrome_bin(),
            "--disable-gpu", "--mute-audio", "--no-first-run",
            "--no-default-browser-check", "--disable-extensions",
            "--disable-background-networking", "--disable-sync",
            "--allow-file-access-from-files",
            "--remote-allow-origins=*",
            "--remote-debugging-port=%d" % self.port,
            "--user-data-dir=%s" % self.profile,
            "--window-size=%d,%d" % (width, height),
            "about:blank",
        ]
        if not headful:
            args.insert(1, "--headless=new")
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
        ws_url = None
        for _ in range(80):
            time.sleep(0.4)
            if self.proc.poll() is not None:
                raise NoBrowser("chrome exited immediately (code %s)"
                                % self.proc.returncode)
            try:
                tabs = json.load(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json/list" % self.port, timeout=5))
                pages = [t for t in tabs if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                continue
        if not ws_url:
            self.close()
            raise NoBrowser("chrome debug port never came up")
        self.ws = _WS(ws_url)
        self.i = 0
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Emulation.setDeviceMetricsOverride",
                  width=width, height=height, deviceScaleFactor=scale,
                  mobile=mobile)
        if touch:
            self.send("Emulation.setTouchEmulationEnabled",
                      enabled=True, maxTouchPoints=5)

    def send(self, method, **params):
        self.i += 1
        self.ws.send(json.dumps({"id": self.i, "method": method,
                                 "params": params}))
        deadline = time.time() + 90
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.i:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})
        raise TimeoutError(method)

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr,
                      returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            return None
        return r.get("result", {}).get("value")

    def emulate_media(self, features):
        """features: [{'name': 'prefers-reduced-motion', 'value': 'reduce'}]"""
        self.send("Emulation.setEmulatedMedia", features=features)

    def goto(self, url, wait=1.2):
        self.send("Page.navigate", url=url)
        for _ in range(60):
            time.sleep(0.15)
            if self.js("document.readyState") == "complete":
                break
        time.sleep(wait)
        return url

    def shot(self, path, full=False):
        params = {"format": "png"}     # type: dict
        if full:
            m = self.send("Page.getLayoutMetrics")
            cs = m.get("cssContentSize") or m.get("contentSize")
            self.send("Emulation.setDeviceMetricsOverride",
                      width=int(cs["width"]),
                      height=min(int(cs["height"]), 30000),
                      deviceScaleFactor=1, mobile=False)
            time.sleep(0.5)
            params["captureBeyondViewport"] = True
        r = self.send("Page.captureScreenshot", **params)
        with open(path, "wb") as fh:
            fh.write(base64.b64decode(r["data"]))
        return path

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        try:
            import shutil
            shutil.rmtree(self.profile, ignore_errors=True)
        except Exception:
            pass


def require_browser(width=1440, height=900, **kw):
    """Open a browser, or exit 3 with the reason. For gate top matter."""
    try:
        return Browser(width=width, height=height, **kw)
    except NoBrowser as exc:
        print("NO BROWSER: %s" % exc)
        sys.exit(NO_BROWSER_EXIT)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    mode, url = sys.argv[1], sys.argv[2]
    js = "document.title"
    if "--js" in sys.argv:
        js = sys.argv[sys.argv.index("--js") + 1]
    b = require_browser()
    try:
        b.goto(url)
        if mode == "text":
            print(b.js("document.body ? document.body.innerText : ''") or "")
        elif mode == "html":
            print(b.js("document.documentElement.outerHTML") or "")
        elif mode == "eval":
            print(json.dumps(b.js(js), indent=1, default=str))
        elif mode == "probe":
            print(json.dumps({
                "url": url,
                "title": b.js("document.title"),
                "scrollHeight": b.js("document.body.scrollHeight"),
                "text_len": len(b.js("document.body.innerText") or ""),
                "chrome": chrome_bin(),
            }, indent=1))
        else:
            print("modes: text, html, eval, probe")
            sys.exit(2)
    finally:
        b.close()
