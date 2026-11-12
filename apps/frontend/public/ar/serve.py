"""Dev server for GLB AR Lab.

  python serve.py            HTTPS on :8443 with a self-signed cert (phone on same Wi-Fi)
  python serve.py --http     plain HTTP on :8000 (use with chrome://inspect USB port forwarding -> localhost)

Extras over http.server:
  * gzip for .glb/.js/.json/.wasm (cached in memory), like a real CDN would do
  * POST /api/log     -> prints the phone's log + live stat lines in this terminal
  * POST /api/report  -> saves benchmark/report JSON into ./reports/
"""
import argparse
import gzip
import http.server
import json
import shutil
import socket
import ssl
import subprocess
import threading
import time
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
CERT_DIR = ROOT / ".cert"
REPORTS = ROOT / "reports"
GZIP_EXT = {".glb", ".gltf", ".bin", ".js", ".mjs", ".json", ".wasm", ".html", ".css"}
GZIP_MAX = 400 * 1024 * 1024

_gz_cache = {}
_gz_lock = threading.Lock()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def find_openssl():
    # Git for Windows ships a working openssl; conda/other copies often lack openssl.cnf.
    for c in (r"C:\Program Files\Git\mingw64\bin\openssl.exe",
              r"C:\Program Files\Git\usr\bin\openssl.exe",
              shutil.which("openssl")):
        if c and Path(c).exists():
            return c
    raise SystemExit("No way to make a cert: pip install cryptography, install OpenSSL, or run with --http")


def make_cert_cryptography(ip, cert, key):
    import datetime
    import ipaddress
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    pk = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "glb-ar-lab")])
    now = datetime.datetime.now(datetime.timezone.utc)
    san = x509.SubjectAlternativeName([
        x509.IPAddress(ipaddress.ip_address(ip)),
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
        x509.DNSName("localhost"),
    ])
    c = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(pk.public_key())
         .serial_number(x509.random_serial_number())
         .not_valid_before(now - datetime.timedelta(days=1))
         .not_valid_after(now + datetime.timedelta(days=825))
         .add_extension(san, critical=False)
         .sign(pk, hashes.SHA256()))
    key.write_bytes(pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                     serialization.NoEncryption()))
    cert.write_bytes(c.public_bytes(serialization.Encoding.PEM))


def ensure_cert(ip):
    cert, key = CERT_DIR / "cert.pem", CERT_DIR / "key.pem"
    marker = CERT_DIR / "ip.txt"
    if cert.exists() and key.exists() and marker.exists() and marker.read_text() == ip:
        return cert, key
    CERT_DIR.mkdir(exist_ok=True)
    try:
        make_cert_cryptography(ip, cert, key)
    except ImportError:
        subprocess.run([
            find_openssl(), "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "825",
            "-subj", "/CN=glb-ar-lab",
            "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
        ], check=True)
    marker.write_text(ip)
    print(f"Generated self-signed cert for {ip} in .cert/")
    return cert, key


def gzipped(path: Path):
    st = path.stat()
    k = (str(path), st.st_mtime_ns, st.st_size)
    with _gz_lock:
        if k in _gz_cache:
            return _gz_cache[k]
    t = time.time()
    data = gzip.compress(path.read_bytes(), compresslevel=6)
    with _gz_lock:
        _gz_cache[k] = data
    print(f"  gzip {path.name}: {st.st_size/1e6:.1f} MB -> {len(data)/1e6:.1f} MB ({time.time()-t:.1f}s, cached)")
    return data


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".wasm": "application/wasm",
        ".js": "text/javascript", ".mjs": "text/javascript", ".ktx2": "image/ktx2", ".json": "application/json",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):
        if self.command == "POST":
            return
        print(f"  {self.address_string()} {fmt % args}")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / "index.html"
        if (path.is_file() and path.suffix.lower() in GZIP_EXT and path.stat().st_size <= GZIP_MAX
                and "gzip" in self.headers.get("Accept-Encoding", "")):
            data = gzipped(path)
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Decoded-Length", str(path.stat().st_size))
            self.send_header("Access-Control-Expose-Headers", "X-Decoded-Length")
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def _json_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"null")

    def _reply(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            if self.path.endswith("/api/log"):
                for e in self._json_body() or []:
                    tag = {"stat": "\033[36mSTAT\033[0m", "warn": "\033[33mWARN\033[0m", "error": "\033[31mERR \033[0m"}.get(e.get("level"), "LOG ")
                    print(f"[phone {e.get('t', 0):>7}s] {tag} {e.get('msg')}")
                return self._reply({"ok": True})
            if self.path.endswith("/api/report"):
                report = self._json_body()
                REPORTS.mkdir(exist_ok=True)
                name = f"report-{time.strftime('%Y%m%d-%H%M%S')}.json"
                (REPORTS / name).write_text(json.dumps(report, indent=2))
                b = (report.get("benchmarks") or [None])[-1]
                print(f"\033[32m  report saved: reports/{name}\033[0m" + (f"  last bench: {b['fpsAvg']} fps avg, 1% low {b['fps1Low']}, p95 {b['msP95']} ms" if b else ""))
                return self._reply({"ok": True, "file": f"reports/{name}"})
            self._reply({"error": "not found"}, 404)
        except Exception as ex:  # noqa: BLE001
            self._reply({"error": str(ex)}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--http", action="store_true", help="plain HTTP (for USB port forwarding / localhost)")
    ap.add_argument("--port", type=int)
    args = ap.parse_args()

    ip = lan_ip()
    port = args.port or (8000 if args.http else 8443)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    if args.http:
        print(f"Serving http://localhost:{port}/")
        print("  Phone via USB: chrome://inspect -> Port forwarding -> {port} -> localhost:{port}".replace("{port}", str(port)))
    else:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f"Serving https://{ip}:{port}/   (self-signed: tap Advanced -> Proceed on the phone)")
        print(f"        https://localhost:{port}/")
    print("Phone logs and live stats will stream here.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
