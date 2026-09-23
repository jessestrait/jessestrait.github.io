#!/usr/bin/env python3
"""A static server that answers HTTP Range requests.

`python3 -m http.server` does not. It ignores the Range header and returns
200 with the whole file, which for a 45 MB PMTiles archive means MapLibre's
pmtiles protocol gets a body far larger than it asked for and fails with
"Server returned no content-length header or content-length exceeding
request" — a message that sounds like the archive is broken when the
archive is fine. GitHub Pages serves ranges correctly (206, accept-ranges:
bytes, verified), so this exists only so local development matches
production.

    python3 tools/serve_range.py [port] [--directory DIR]
"""

import argparse
import http.server
import os
import re
import socketserver


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Range support is worth nothing if the client cannot discover it.
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_head(self):
        rng = self.headers.get("Range")
        if not rng:
            return super().send_head()
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m:
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        size = os.fstat(f.fileno()).st_size
        first, last = m.group(1), m.group(2)
        if first == "":
            # A suffix range: the last N bytes. PMTiles does not use this,
            # but a correct server answers it and it costs three lines.
            length = min(int(last or 0), size)
            start, end = size - length, size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            f.close()
            return None
        end = min(end, size - 1)
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        # SimpleHTTPRequestHandler copies to the end of the file, so the
        # slice is handed over as its own limited reader.
        return _Slice(f, end - start + 1)


class _Slice:
    def __init__(self, f, n):
        self.f, self.left = f, n

    def read(self, n=-1):
        if self.left <= 0:
            return b""
        if n < 0 or n > self.left:
            n = self.left
        b = self.f.read(n)
        self.left -= len(b)
        return b

    def close(self):
        self.f.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8777)
    ap.add_argument("--directory", default=".")
    a = ap.parse_args()
    os.chdir(a.directory)
    with Server(("", a.port), RangeHandler) as httpd:
        print("serving %s on :%d with byte ranges" % (os.getcwd(), a.port))
        httpd.serve_forever()
