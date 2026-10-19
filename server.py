import http.server
import socketserver
import json
import os
import re
import subprocess
import threading
import time
from email.parser import BytesParser
from email.policy import default

BLENDER = r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
BASE = r"C:\Users\user\Desktop\bake"
VIEWER = os.path.join(BASE, "bake_viewer")
WEB = os.path.join(VIEWER, "web")
UPLOADS = os.path.join(VIEWER, "uploads")
BAKE_SCRIPT = os.path.join(VIEWER, "bake_web.py")
EXPORT_SCRIPT = os.path.join(VIEWER, "export_fbx.py")
DECIMATE_SCRIPT = os.path.join(VIEWER, "decimate.py")
OUT_TEX = os.path.join(BASE, "l_basecolor.png")
OUT_GLB = os.path.join(WEB, "model.glb")
PORT = int(os.environ.get("BAKE_PORT", "8765"))

bake_lock = threading.Lock()
export_lock = threading.Lock()
decimate_lock = threading.Lock()
os.makedirs(UPLOADS, exist_ok=True)


def parse_multipart(body, boundary):
    raw = b"Content-Type: multipart/form-data; boundary=" + boundary.encode() + b"\r\n\r\n" + body
    msg = BytesParser(policy=default).parsebytes(raw)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        out[name] = {
            "filename": part.get_filename(),
            "data": part.get_payload(decode=True),
        }
    return out


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(name or "file"))


def save_upload(field, dest_dir):
    if not field or not field.get("data"):
        return None
    fn = safe_name(field.get("filename") or "upload.bin")
    path = os.path.join(dest_dir, fn)
    with open(path, "wb") as f:
        f.write(field["data"])
    return path


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=WEB, **k)

    def log_message(self, *a):
        pass

    def guess_type(self, path):
        t = super().guess_type(path)
        if t.startswith("text/") or t in ("application/javascript", "application/json"):
            t += "; charset=utf-8"
        return t

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/texture.png":
            return self.serve_file(OUT_TEX, "image/png")
        if path == "/decimated.glb":
            return self.serve_file(os.path.join(UPLOADS, "_decimate.glb"), "model/gltf-binary")
        if path == "/decimated.obj":
            return self.serve_file(os.path.join(UPLOADS, "_decimate.obj"), "text/plain; charset=utf-8")
        return super().do_GET()

    def serve_file(self, path, ctype):
        if not os.path.exists(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/bake":
            return self.do_bake()
        if path == "/save-texture":
            return self.do_save_texture()
        if path == "/export-fbx":
            return self.do_export_fbx()
        if path == "/decimate":
            return self.do_decimate()
        if path == "/shutdown":
            return self.do_shutdown()
        if path == "/heartbeat":
            return self.do_heartbeat()
        self.send_error(404)

    def do_heartbeat(self):
        self.reply(200, {"ok": True})

    def do_shutdown(self):
        self.reply(200, {"ok": True})
        # shutdown after response sent
        threading.Thread(target=lambda: (time.sleep(0.5), os._exit(0))).start()

    def do_export_fbx(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        if len(body) < 20:
            return self.reply(400, {"ok": False, "error": "пустое тело (нужен GLB)"})
        if not export_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "конвертация уже выполняется"})
        try:
            in_path = os.path.join(UPLOADS, "_export_tmp.glb")
            out_path = os.path.join(UPLOADS, "_export_tmp.fbx")
            with open(in_path, "wb") as f:
                f.write(body)
            cfg = {"in": in_path, "out": out_path}
            p = subprocess.run(
                [BLENDER, "--background", "--python", EXPORT_SCRIPT, "--", json.dumps(cfg)],
                capture_output=True, text=True,
            )
            if "FBX_OK" not in p.stdout or not os.path.exists(out_path):
                log = (p.stdout + p.stderr)[-4000:]
                return self.reply(500, {"ok": False, "error": "Blender: конвертация не удалась", "log": log})
            with open(out_path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", 'attachment; filename="model.fbx"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        finally:
            export_lock.release()

    def do_decimate(self):
        ctype = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if "multipart/form-data" not in ctype:
            return self.reply(400, {"ok": False, "error": "expected multipart/form-data"})

        if not decimate_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "децимация уже выполняется"})
        try:
            m = re.search(r"boundary=([^;]+)", ctype)
            boundary = m.group(1).strip().strip('"')
            parts = parse_multipart(body, boundary)

            src = save_upload(parts.get("mesh"), UPLOADS)
            if not src:
                return self.reply(400, {"ok": False, "error": "нужен файл меша"})

            def field(name, default):
                p = parts.get(name)
                if not p or not p.get("data"):
                    return default
                return p["data"].decode("utf-8", "ignore").strip()

            out_glb = os.path.join(UPLOADS, "_decimate.glb")
            out_obj = os.path.join(UPLOADS, "_decimate.obj")
            cfg = {
                "in": src,
                "mode": field("mode", "COLLAPSE"),
                "ratio": float(field("ratio", 0.5)),
                "iterations": int(float(field("iterations", 1))),
                "angle": float(field("angle", 5.0)),
                "out_glb": out_glb,
                "out_obj": out_obj,
            }

            t0 = time.time()
            p = subprocess.run(
                [BLENDER, "--background", "--python", DECIMATE_SCRIPT, "--", json.dumps(cfg)],
                capture_output=True, text=True,
            )
            if "DECIMATE_OK" not in p.stdout or not os.path.exists(out_glb):
                log = (p.stdout + p.stderr)[-4000:]
                return self.reply(500, {"ok": False, "error": "Blender: децимация не удалась", "log": log})

            info = {}
            for line in p.stdout.splitlines():
                if line.startswith("RESULT "):
                    try:
                        info = json.loads(line[len("RESULT "):])
                    except Exception:
                        pass
            info["seconds"] = round(time.time() - t0, 1)

            with open(out_glb, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "model/gltf-binary")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Decimate-Info", json.dumps(info))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        finally:
            decimate_lock.release()

    def do_save_texture(self):
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length) if length else b""
        if not data:
            return self.reply(400, {"ok": False, "error": "empty body"})
        with open(OUT_TEX, "wb") as f:
            f.write(data)
        self.reply(200, {"ok": True, "bytes": len(data)})

    def do_bake(self):
        ctype = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if "multipart/form-data" not in ctype:
            return self.reply(400, {"ok": False, "error": "expected multipart/form-data"})

        if not bake_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "bake already running"})
        try:
            m = re.search(r"boundary=([^;]+)", ctype)
            boundary = m.group(1).strip().strip('"')
            parts = parse_multipart(body, boundary)

            low = save_upload(parts.get("low"), UPLOADS)
            high = save_upload(parts.get("high"), UPLOADS)
            texture = save_upload(parts.get("texture"), UPLOADS)

            if not low or not high:
                return self.reply(400, {"ok": False, "error": "нужны файлы low и high"})

            def field(name, default):
                p = parts.get(name)
                if not p or not p.get("data"):
                    return default
                return p["data"].decode("utf-8", "ignore").strip()

            cfg = {
                "low": low,
                "high": high,
                "texture": texture,
                "cage_extrusion": float(field("cage_extrusion", 0.008)),
                "max_ray_distance": float(field("max_ray_distance", 0.012)),
                "margin": int(float(field("margin", 32))),
                "resolution": int(float(field("resolution", 4096))),
                "out_png": OUT_TEX,
                "out_glb": OUT_GLB,
            }

            t0 = time.time()
            p = subprocess.run(
                [BLENDER, "--background", "--python", BAKE_SCRIPT, "--", json.dumps(cfg)],
                capture_output=True, text=True,
            )
            ok = "BAKE_OK" in p.stdout
            log = (p.stdout + p.stderr)[-4000:]
            info = {}
            for line in p.stdout.splitlines():
                if line.startswith("RESULT "):
                    try:
                        info = json.loads(line[len("RESULT "):])
                    except Exception:
                        pass
            resp = {
                "ok": ok,
                "seconds": round(time.time() - t0, 1),
                "info": info,
                "log": log,
            }
            self.reply(200 if ok else 500, resp)
        finally:
            bake_lock.release()

    def reply(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    os.chdir(WEB)
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print("Bake viewer: http://127.0.0.1:%d" % PORT)
        httpd.serve_forever()
