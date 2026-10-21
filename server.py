import glob
import http.server
import json
import logging
import os
import re
import socketserver
import subprocess
import threading
import time
from email.parser import BytesParser
from email.policy import default
from typing import Any, TypedDict, cast


class MultipartPart(TypedDict, total=False):
    filename: str | None
    data: bytes | None


class MeshStats(TypedDict):
    verts: int
    tris: int
    polys: int


class BakeCfg(TypedDict):
    low: str
    high: str
    texture: str | None
    maps: list[str]
    textures: dict[str, str | None]
    cage_extrusion: float
    max_ray_distance: float
    margin: int
    resolution: int
    out_png: str
    out_pngs: dict[str, str]
    out_glb: str


class DecimateCfg(TypedDict):
    in_: str
    mode: str
    ratio: float
    iterations: int
    angle: float
    out_glb: str
    out_obj: str


class ExportCfg(TypedDict):
    in_: str
    out: str


logger = logging.getLogger(__name__)

BLENDER_FALLBACK = r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe"
BASE = r"C:\Users\user\Desktop\bake"
VIEWER = os.path.join(BASE, "bake_viewer")
WEB = os.path.join(VIEWER, "web")
UPLOADS = os.path.join(VIEWER, "uploads")
BAKE_SCRIPT = os.path.join(VIEWER, "bake_web.py")
EXPORT_SCRIPT = os.path.join(VIEWER, "export_fbx.py")
DECIMATE_SCRIPT = os.path.join(VIEWER, "decimate.py")
OUT_TEX = os.path.join(BASE, "l_basecolor.png")
MAP_IDS = ("basecolor", "normal", "ao", "roughness", "metallic", "height")
OUT_MAPS = {mid: os.path.join(BASE, f"l_{mid}.png") for mid in MAP_IDS}
OUT_GLB = os.path.join(WEB, "model.glb")
PORT = int(os.environ.get("BAKE_PORT", "8765"))

bake_lock = threading.Lock()
export_lock = threading.Lock()
decimate_lock = threading.Lock()
os.makedirs(UPLOADS, exist_ok=True)

HEARTBEAT_TIMEOUT = 30.0
_last_beat = time.monotonic()
_beats_seen = False


def _blender_version(exe: str) -> tuple[int, ...]:
    digits = re.findall(r"\d+", os.path.basename(os.path.dirname(exe)))
    return tuple(int(d) for d in digits) or (0,)


def resolve_blender() -> str:
    """Путь к blender.exe: env BLENDER_EXE > свежая установка > fallback.

    Папка с конкретной версией может исчезнуть после обновления Blender
    (так 5.0 заменился на 5.2) — поэтому ищем динамически.
    """
    env = os.environ.get("BLENDER_EXE", "")
    if env and os.path.isfile(env):
        return env
    try:
        candidates = [
            os.path.join(d, "blender.exe")
            for d in glob.glob(r"C:\Program Files\Blender Foundation\Blender *")
            if os.path.isfile(os.path.join(d, "blender.exe"))
        ]
        if candidates:
            return max(candidates, key=_blender_version)
    except OSError:
        logger.exception("поиск blender.exe не удался")
    logger.error("blender.exe не найден, используется fallback: %s", BLENDER_FALLBACK)
    return BLENDER_FALLBACK


BLENDER = resolve_blender()


def parse_multipart(body: bytes, boundary: str) -> dict[str, MultipartPart]:
    raw = b"Content-Type: multipart/form-data; boundary=" + boundary.encode() + b"\r\n\r\n" + body
    msg = BytesParser(policy=default).parsebytes(raw)
    out: dict[str, MultipartPart] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True)
        out[str(name)] = {
            "filename": part.get_filename(),
            "data": data if isinstance(data, bytes) else None,
        }
    return out


def safe_name(name: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(name or "file"))


def save_upload(field: MultipartPart | None, dest_dir: str, prefix: str = "") -> str | None:
    if not field or not field.get("data"):
        return None
    data = field["data"]
    if data is None:
        return None
    fn = safe_name(field.get("filename") or "upload.bin")
    path = os.path.join(dest_dir, prefix + fn)
    with open(path, "wb") as f:
        f.write(data)
    return path


def part_field(parts: dict[str, MultipartPart], name: str, default: str) -> str:
    p = parts.get(name)
    if not p or not p.get("data"):
        return default
    return cast(bytes, p["data"]).decode("utf-8", "ignore").strip()


def extract_result_info(stdout: str) -> dict[str, Any]:
    for line in stdout.splitlines():
        if line.startswith("RESULT "):
            try:
                return cast(dict[str, Any], json.loads(line[len("RESULT "):]))
            except Exception:
                pass
    return {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a: Any, **k: Any) -> None:
        super().__init__(*a, directory=WEB, **k)

    def log_message(self, *a: Any) -> None:
        pass

    def guess_type(self, path: str | os.PathLike[str]) -> str:
        t = super().guess_type(path)
        if t.startswith("text/") or t in ("application/javascript", "application/json"):
            t += "; charset=utf-8"
        return t

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        if path == "/texture.png":
            return self.serve_file(OUT_TEX, "image/png")
        if path.startswith("/texture/"):
            name = path[len("/texture/"):]
            if name.endswith(".png"):
                name = name[:-4]
            if name not in OUT_MAPS:
                return self.send_error(404)
            return self.serve_file(OUT_MAPS[name], "image/png")
        if path == "/decimated.glb":
            return self.serve_file(os.path.join(UPLOADS, "_decimate.glb"), "model/gltf-binary")
        if path == "/decimated.obj":
            return self.serve_file(os.path.join(UPLOADS, "_decimate.obj"), "text/plain; charset=utf-8")
        super().do_GET()

    def serve_file(self, path: str, ctype: str) -> None:
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

    def do_POST(self) -> None:
        path = self.path.split("?")[0]
        routes: dict[str, Any] = {
            "/bake": self.do_bake,
            "/save-texture": self.do_save_texture,
            "/export-fbx": self.do_export_fbx,
            "/decimate": self.do_decimate,
            "/shutdown": self.do_shutdown,
            "/heartbeat": self.do_heartbeat,
        }
        handler = routes.get(path)
        if not handler:
            return self.send_error(404)
        try:
            handler()
        except Exception as exc:
            # Без guard исключение в потоке закрывало сокет без ответа —
            # браузер получал net::ERR_EMPTY_RESPONSE вместо ошибки
            logger.exception("POST %s: необработанное исключение", path)
            try:
                self.reply(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            except OSError:
                pass  # клиент уже отключился

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def do_heartbeat(self) -> None:
        global _last_beat, _beats_seen
        _last_beat = time.monotonic()
        _beats_seen = True
        self.reply(200, {"ok": True})

    def do_shutdown(self) -> None:
        self.reply(200, {"ok": True})

        def _exit() -> None:
            time.sleep(0.5)
            os._exit(0)

        # shutdown after response sent
        threading.Thread(target=_exit).start()

    def do_export_fbx(self) -> None:
        body = self.read_body()
        if len(body) < 20:
            return self.reply(400, {"ok": False, "error": "пустое тело (нужен GLB)"})
        if not export_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "конвертация уже выполняется"})
        try:
            self.run_blender_export(body)
        finally:
            export_lock.release()

    def run_blender_export(self, body: bytes) -> None:
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

    def do_decimate(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        body = self.read_body()
        if "multipart/form-data" not in ctype:
            return self.reply(400, {"ok": False, "error": "expected multipart/form-data"})
        if not decimate_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "децимация уже выполняется"})
        try:
            self.run_decimate(body, ctype)
        finally:
            decimate_lock.release()

    def run_decimate(self, body: bytes, ctype: str) -> None:
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            return self.reply(400, {"ok": False, "error": "no boundary"})
        boundary = m.group(1).strip().strip('"')
        parts = parse_multipart(body, boundary)

        src = save_upload(parts.get("mesh"), UPLOADS)
        if not src:
            return self.reply(400, {"ok": False, "error": "нужен файл меша"})

        out_glb = os.path.join(UPLOADS, "_decimate.glb")
        out_obj = os.path.join(UPLOADS, "_decimate.obj")
        cfg = {
            "in": src,
            "mode": part_field(parts, "mode", "COLLAPSE"),
            "ratio": float(part_field(parts, "ratio", "0.5")),
            "iterations": int(float(part_field(parts, "iterations", "1"))),
            "angle": float(part_field(parts, "angle", "5.0")),
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

        info = extract_result_info(p.stdout)
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

    def do_save_texture(self) -> None:
        data = self.read_body()
        if not data:
            return self.reply(400, {"ok": False, "error": "empty body"})
        with open(OUT_TEX, "wb") as f:
            f.write(data)
        self.reply(200, {"ok": True, "bytes": len(data)})

    def do_bake(self) -> None:
        ctype = self.headers.get("Content-Type", "")
        body = self.read_body()
        if "multipart/form-data" not in ctype:
            return self.reply(400, {"ok": False, "error": "expected multipart/form-data"})
        if not bake_lock.acquire(blocking=False):
            return self.reply(409, {"ok": False, "error": "bake already running"})
        try:
            self.run_bake(body, ctype)
        finally:
            bake_lock.release()

    def collect_map_textures(self, parts: dict[str, MultipartPart],
                             maps: list[str]) -> dict[str, str | None]:
        """Файлы карт: tex_<id> на каждую карту (префикс — чтобы имена не слипались)."""
        out: dict[str, str | None] = {}
        for mid in maps:
            path = save_upload(parts.get("tex_" + mid), UPLOADS, prefix=f"map_{mid}_")
            if path is None and mid == "basecolor":
                path = save_upload(parts.get("texture"), UPLOADS)
            out[mid] = path
        return out

    def run_bake(self, body: bytes, ctype: str) -> None:
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            return self.reply(400, {"ok": False, "error": "no boundary"})
        boundary = m.group(1).strip().strip('"')
        parts = parse_multipart(body, boundary)

        low = save_upload(parts.get("low"), UPLOADS)
        high = save_upload(parts.get("high"), UPLOADS)

        if not low or not high:
            return self.reply(400, {"ok": False, "error": "нужны файлы low и high"})

        maps = [m.strip() for m in part_field(parts, "maps", "").split(",") if m.strip() in MAP_IDS]
        if not maps:
            maps = ["basecolor"]
        textures = self.collect_map_textures(parts, maps)

        cfg: BakeCfg = {
            "low": low,
            "high": high,
            "texture": textures.get("basecolor"),
            "maps": maps,
            "textures": textures,
            "cage_extrusion": float(part_field(parts, "cage_extrusion", "0.008")),
            "max_ray_distance": float(part_field(parts, "max_ray_distance", "0.012")),
            "margin": int(float(part_field(parts, "margin", "32"))),
            "resolution": int(float(part_field(parts, "resolution", "4096"))),
            "out_png": OUT_TEX,
            "out_pngs": {mid: OUT_MAPS[mid] for mid in maps},
            "out_glb": OUT_GLB,
        }

        t0 = time.time()
        p = subprocess.run(
            [BLENDER, "--background", "--python", BAKE_SCRIPT, "--", json.dumps(cfg)],
            capture_output=True, text=True,
        )
        ok = "BAKE_OK" in p.stdout
        log = (p.stdout + p.stderr)[-4000:]
        info = extract_result_info(p.stdout)
        resp = {
            "ok": ok,
            "seconds": round(time.time() - t0, 1),
            "info": info,
            "log": log,
        }
        self.reply(200 if ok else 500, resp)

    def reply(self, code: int, obj: dict[str, Any]) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def watchdog() -> None:
    """Выход через HEARTBEAT_TIMEOUT молчания после первого heartbeat.

    Отсчёт стартует только после первого ответа фронта: пока никто не
    подключался, сервер живёт бессрочно (запуск из start.bat).
    """
    while True:
        time.sleep(5.0)
        if _beats_seen and time.monotonic() - _last_beat > HEARTBEAT_TIMEOUT:
            print("Bake viewer: нет heartbeat %.0fs — выход" % HEARTBEAT_TIMEOUT)
            os._exit(0)


if __name__ == "__main__":
    os.chdir(WEB)
    threading.Thread(target=watchdog, daemon=True).start()
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print("Bake viewer: http://127.0.0.1:%d" % PORT)
        print("Blender: %s" % BLENDER)
        httpd.serve_forever()
