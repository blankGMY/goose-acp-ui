#!/usr/bin/env python3
"""Goose web gateway for the Pi hub.

Serves the ACP UI web build behind a login gate and relays its WebSocket
(/acp) to the local goose-serve, injecting the goose secret server-side so
the browser never holds it.

- Login password = the goose-serve secret itself (the user already has it).
  A successful login sets a gate cookie = sha256(salt + secret); the secret
  itself is never stored in any page or client-side config.
- Static ACP UI files are served from WEB_ROOT with SPA fallback.
- The /acp WebSocket is relayed byte-for-byte to goose-serve after two
  independent handshakes (client<->gateway, gateway<->goose-serve). The
  gateway presents an already-allowed Origin upstream.

Standard library only.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import parse_qs, unquote

try:
    import yaml  # PyYAML, present on the Pi; only the /api endpoints need it
except ImportError:  # the chat gateway itself must never depend on it
    yaml = None

HOST = "0.0.0.0"
PORT = 8083
WEB_ROOT = os.path.expanduser("~/acp-ui-web-patched")
SECRET_FILE = os.path.expanduser("~/goose/goose-serve-secret.txt")
SALT_FILE = os.path.expanduser("~/goose-web/gate.salt")
UPSTREAM_HOST = "127.0.0.1"
UPSTREAM_PORT = 3284
# The Origin the gateway presents to goose-serve. It must exactly match
# one of goose-serve's --allowed-origin values. Deployments override it
# via the environment (the Pi's systemd unit sets the Tailscale origin).
UPSTREAM_ORIGIN = os.environ.get("GOOSE_WEB_UPSTREAM_ORIGIN", "http://127.0.0.1:8081")
COOKIE_NAME = "goose_gate"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
    ".txt": "text/plain; charset=utf-8",
}


def read_secret():
    with open(SECRET_FILE, "rb") as f:
        raw = f.read()
    return raw.decode("utf-8", "replace").lstrip("﻿").strip()


def load_salt():
    if not os.path.exists(SALT_FILE):
        os.makedirs(os.path.dirname(SALT_FILE), exist_ok=True)
        salt = base64.b16encode(os.urandom(16)).decode()
        with open(SALT_FILE, "w") as f:
            f.write(salt)
        os.chmod(SALT_FILE, 0o600)
        return salt
    with open(SALT_FILE) as f:
        return f.read().strip()


SECRET = read_secret()
SALT = load_salt()
GATE_VALUE = hashlib.sha256((SALT + SECRET).encode()).hexdigest()


def gate_hash(candidate):
    return hashlib.sha256((SALT + candidate).encode()).hexdigest()


class Conn:
    """Buffered socket reader so header parsing never swallows body/frame bytes."""

    def __init__(self, sock):
        self.sock = sock
        self.buf = b""

    def read_until(self, delim, limit=131072):
        while delim not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed while reading headers")
            self.buf += chunk
            if len(self.buf) > limit:
                raise ValueError("header block too large")
        idx = self.buf.index(delim) + len(delim)
        out, self.buf = self.buf[:idx], self.buf[idx:]
        return out

    def read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("closed while reading body")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def take_buffer(self):
        b, self.buf = self.buf, b""
        return b


def parse_request(head_bytes):
    text = head_bytes.decode("iso-8859-1")
    lines = text.split("\r\n")
    parts = lines[0].split(" ")
    method = parts[0]
    target = parts[1] if len(parts) > 1 else "/"
    headers = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        headers[k.strip().lower()] = v.strip()
    path = target.split("?", 1)[0]
    return method, target, path, headers


def cookie_ok(headers):
    raw = headers.get("cookie", "")
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            if k == COOKIE_NAME and v == GATE_VALUE:
                return True
    return False


def http_response(sock, status, body=b"", content_type="text/html; charset=utf-8",
                  extra_headers=None):
    reasons = {200: "OK", 302: "Found", 400: "Bad Request", 403: "Forbidden",
               404: "Not Found", 502: "Bad Gateway"}
    if isinstance(body, str):
        body = body.encode("utf-8")
    lines = [f"HTTP/1.1 {status} {reasons.get(status, '')}",
             f"Content-Type: {content_type}",
             f"Content-Length: {len(body)}",
             "Connection: close"]
    if extra_headers:
        lines += extra_headers
    head = ("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1")
    sock.sendall(head + body)


LOGIN_PAGE = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b3d40">
<title>Goose</title>
<style>
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif;
background:#0b3d40;color:#f4f6f5;margin:0;min-height:100vh;min-height:100dvh;
display:flex;align-items:center;justify-content:center;padding:24px}
.wrap{width:min(92vw,360px)}
.wordmark{font-size:64px;font-weight:800;letter-spacing:-0.03em;line-height:1;margin:0}
.sub{color:#9fbfb9;font-size:15px;line-height:1.6;margin:14px 0 28px}
.err{color:#f2a49c;font-size:13px;min-height:18px;margin-bottom:6px}
input{width:100%;padding:14px 16px;border:0;border-radius:12px;background:#f4f6f5;
color:#17201e;font-size:16px}
input::placeholder{color:#84938e}
input:focus{outline:3px solid rgba(69,176,170,.55);outline-offset:1px}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:12px;
background:#45b0aa;color:#062a2c;font-size:16px;font-weight:600;cursor:pointer}
button:active{background:#57bcb7}
.foot{color:#6e8a85;font-size:12px;margin-top:22px}
</style></head><body><div class="wrap">
<h1 class="wordmark">Goose</h1>
<p class="sub">你的个人智能体，住在树莓派上。<br>输入访问密钥，回到你的会话。</p>
<div class="err">__ERR__</div>
<form method="POST" action="/login">
<input type="password" name="password" placeholder="访问密钥" autocomplete="current-password" autofocus>
<button type="submit">进入</button>
</form>
<p class="foot">登录状态保留 30 天，连接经加密隧道传输。</p>
</div></body></html>"""


def serve_login(sock, err=""):
    http_response(sock, 200, LOGIN_PAGE.replace("__ERR__", err))


def serve_static(sock, path):
    rel = unquote(path).lstrip("/")
    if rel == "":
        rel = "index.html"
    full = os.path.normpath(os.path.join(WEB_ROOT, rel))
    if not full.startswith(os.path.normpath(WEB_ROOT)) or not os.path.isfile(full):
        full = os.path.join(WEB_ROOT, "index.html")
    ext = os.path.splitext(full)[1].lower()
    ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
    with open(full, "rb") as f:
        data = f.read()
    extra = []
    if ext == ".html":
        extra.append("Cache-Control: no-cache")
    http_response(sock, 200, data, content_type=ctype, extra_headers=extra)


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle_ws(client_sock, client_conn, headers):
    if not cookie_ok(headers):
        http_response(client_sock, 403, "login required")
        return
    key = headers.get("sec-websocket-key")
    if not key:
        http_response(client_sock, 400, "missing websocket key")
        return
    accept = base64.b64encode(
        hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
    requested_proto = headers.get("sec-websocket-protocol", "")
    first_proto = requested_proto.split(",")[0].strip() if requested_proto else ""

    # Upstream handshake to goose-serve, injecting the secret.
    up = socket.create_connection((UPSTREAM_HOST, UPSTREAM_PORT), timeout=10)
    up_conn = Conn(up)
    my_key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET /acp?token={SECRET} HTTP/1.1\r\n"
           f"Host: {UPSTREAM_HOST}:{UPSTREAM_PORT}\r\n"
           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {my_key}\r\nSec-WebSocket-Version: 13\r\n"
           f"Origin: {UPSTREAM_ORIGIN}\r\n\r\n")
    up.sendall(req.encode())
    resp_head = up_conn.read_until(b"\r\n\r\n")
    status_line = resp_head.split(b"\r\n", 1)[0].decode("iso-8859-1", "replace")
    if "101" not in status_line:
        http_response(client_sock, 502, "upstream refused websocket")
        up.close()
        return

    # Client 101.
    lines = ["HTTP/1.1 101 Switching Protocols",
             "Upgrade: websocket", "Connection: Upgrade",
             f"Sec-WebSocket-Accept: {accept}"]
    if first_proto:
        lines.append(f"Sec-WebSocket-Protocol: {first_proto}")
    client_sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("iso-8859-1"))

    # Flush any bytes that arrived buffered with either handshake.
    up_leftover = up_conn.take_buffer()
    if up_leftover:
        client_sock.sendall(up_leftover)
    cl_leftover = client_conn.take_buffer()
    if cl_leftover:
        up.sendall(cl_leftover)

    client_sock.settimeout(None)
    up.settimeout(None)
    t1 = threading.Thread(target=pipe, args=(client_sock, up), daemon=True)
    t2 = threading.Thread(target=pipe, args=(up, client_sock), daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()
    for s in (client_sock, up):
        try:
            s.close()
        except OSError:
            pass



# ---------------------------------------------------------------------------
# Management API (/api/*) - the Goose Desktop parity layer.
#
# goose-serve exposes no REST API for configuration, so the gateway (which
# already lives on the Pi next to Goose's files) manages them directly:
#   * extensions  -> surgical line edits of ~/.config/goose/config.yaml
#                    (the rest of the file is preserved byte-for-byte;
#                    every write is backed up and re-validated as YAML)
#   * recipes     -> YAML files in ~/.config/goose/recipes, validated
#                    with `goose recipe validate` before they are kept
#   * schedules   -> the `goose schedule` CLI (add / list / remove / run-now)
# All endpoints sit behind the same login gate as the rest of the site.
# Secret values (extension headers / env) are never returned by the API.
# ---------------------------------------------------------------------------

CONFIG_PATH = os.path.expanduser("~/.config/goose/config.yaml")
CONFIG_BACKUP = CONFIG_PATH + ".gwbak"
RECIPES_DIR = os.path.expanduser("~/.config/goose/recipes")
SKILLS_DIR = os.path.expanduser("~/.agents/skills")
GOOSE_BIN = os.path.expanduser("~/goose/goose")


def json_response(sock, status, obj):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    http_response(sock, status, body, content_type="application/json; charset=utf-8")


def _read_config():
    if yaml is None:
        raise RuntimeError("PyYAML is not available on the Pi")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _config_lines():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return f.read().splitlines(keepends=True)


def _write_config(lines):
    """Back up, write, and re-validate config.yaml; restore on failure."""
    shutil.copyfile(CONFIG_PATH, CONFIG_BACKUP)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        f.writelines(lines)
    try:
        _read_config()
    except Exception:
        shutil.copyfile(CONFIG_BACKUP, CONFIG_PATH)
        raise RuntimeError("edit produced invalid YAML; rolled back")


def _extensions_span(lines):
    """(start, end) line indexes of the top-level `extensions:` section."""
    start = None
    for i, ln in enumerate(lines):
        if re.match(r"^extensions:\s*$", ln):
            start = i
            break
    if start is None:
        raise RuntimeError("no extensions section in config.yaml")
    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln.strip() and not ln.startswith((" ", "#")):
            end = j
            break
    return start, end


def _extension_blocks(lines, start, end):
    """Map extension key -> [block_start, block_end) within the section."""
    starts = []
    for i in range(start + 1, end):
        m = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", lines[i])
        if m:
            starts.append((m.group(1), i))
    blocks = {}
    for idx, (key, s) in enumerate(starts):
        e = starts[idx + 1][1] if idx + 1 < len(starts) else end
        blocks[key] = (s, e)
    return blocks


def api_extensions_list(sock):
    cfg = _read_config()
    exts = cfg.get("extensions") or {}
    out = []
    for key, ext in exts.items():
        if not isinstance(ext, dict):
            continue
        headers = ext.get("headers") or {}
        summary = ext.get("uri") or ""
        if not summary and ext.get("cmd"):
            summary = str(ext["cmd"]) + " " + " ".join(
                str(a) for a in (ext.get("args") or []))
        out.append({
            "key": key,
            "name": ext.get("display_name") or ext.get("name") or key,
            "description": ext.get("description") or "",
            "type": ext.get("type") or "",
            "enabled": bool(ext.get("enabled")),
            "bundled": bool(ext.get("bundled")),
            "summary": summary.strip(),
            "hasAuth": any(str(k).lower() == "authorization" for k in headers),
        })
    json_response(sock, 200, {"extensions": out})


def api_extensions_toggle(sock, payload):
    name = str(payload.get("name") or "")
    enabled = bool(payload.get("enabled"))
    lines = _config_lines()
    start, end = _extensions_span(lines)
    blocks = _extension_blocks(lines, start, end)
    if name not in blocks:
        return json_response(sock, 404, {"error": f"extension not found: {name}"})
    bs, be = blocks[name]
    target = f"    enabled: {'true' if enabled else 'false'}\n"
    for i in range(bs + 1, be):
        if re.match(r"^    enabled:\s*(true|false)\s*$", lines[i]):
            lines[i] = target
            break
    else:
        lines.insert(bs + 1, target)
    _write_config(lines)
    json_response(sock, 200, {"ok": True})


def api_extensions_add(sock, payload):
    name = str(payload.get("name") or "").strip()
    etype = str(payload.get("type") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
        return json_response(sock, 400, {"error": "name must be letters, digits, - or _"})
    if etype not in ("streamable_http", "stdio"):
        return json_response(sock, 400, {"error": "type must be streamable_http or stdio"})
    cfg = _read_config()
    if name in (cfg.get("extensions") or {}):
        return json_response(sock, 400, {"error": f"extension already exists: {name}"})
    ext = {
        "enabled": True,
        "type": etype,
        "name": name,
        "description": str(payload.get("description") or ""),
    }
    if etype == "streamable_http":
        uri = str(payload.get("uri") or "").strip()
        if not uri.startswith(("http://", "https://")):
            return json_response(sock, 400, {"error": "uri must start with http:// or https://"})
        ext["uri"] = uri
        auth = str(payload.get("auth") or "").strip()
        if auth:
            ext["headers"] = {"Authorization": auth}
        ext["timeout"] = 300
    else:
        cmd = str(payload.get("cmd") or "").strip()
        if not cmd:
            return json_response(sock, 400, {"error": "cmd is required for stdio extensions"})
        ext["cmd"] = cmd
        args = payload.get("args") or []
        ext["args"] = [str(a) for a in args]
        ext["envs"] = {}
        ext["timeout"] = 300
    block = yaml.safe_dump({name: ext}, sort_keys=False, allow_unicode=True)
    block_lines = ["  " + ln for ln in block.splitlines(keepends=True)]
    lines = _config_lines()
    start, end = _extensions_span(lines)
    lines[end:end] = block_lines
    _write_config(lines)
    json_response(sock, 200, {"ok": True})


def api_extensions_remove(sock, payload):
    name = str(payload.get("name") or "")
    cfg = _read_config()
    ext = (cfg.get("extensions") or {}).get(name)
    if ext is None:
        return json_response(sock, 404, {"error": f"extension not found: {name}"})
    if ext.get("bundled") or ext.get("type") in ("platform", "builtin"):
        return json_response(sock, 400, {
            "error": "built-in extensions can be disabled but not removed"})
    lines = _config_lines()
    start, end = _extensions_span(lines)
    blocks = _extension_blocks(lines, start, end)
    if name not in blocks:
        return json_response(sock, 404, {"error": f"extension not found: {name}"})
    bs, be = blocks[name]
    del lines[bs:be]
    _write_config(lines)
    json_response(sock, 200, {"ok": True})


def _recipe_files():
    if not os.path.isdir(RECIPES_DIR):
        return []
    return [fn for fn in sorted(os.listdir(RECIPES_DIR))
            if fn.endswith((".yaml", ".yml", ".json"))]


def api_recipes_list(sock):
    if yaml is None:
        raise RuntimeError("PyYAML is not available on the Pi")
    out = []
    for fn in _recipe_files():
        data = {}
        try:
            with open(os.path.join(RECIPES_DIR, fn), encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception:
            data = {}
        out.append({
            "file": fn,
            "title": data.get("title") or fn,
            "description": data.get("description") or "",
            "instructions": data.get("instructions") or "",
            "prompt": data.get("prompt") or "",
            "parameters": [
                {
                    "key": p.get("key") or p.get("name") or "",
                    "description": p.get("description") or "",
                    "requirement": p.get("requirement") or "",
                    "default": "" if p.get("default") is None else str(p.get("default")),
                }
                for p in (data.get("parameters") or [])
                if isinstance(p, dict) and (p.get("key") or p.get("name"))
            ],
        })
    json_response(sock, 200, {"recipes": out})


def api_recipes_create(sock, payload):
    if yaml is None:
        raise RuntimeError("PyYAML is not available on the Pi")
    title = str(payload.get("title") or "").strip()
    instructions = str(payload.get("instructions") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not title:
        return json_response(sock, 400, {"error": "title is required"})
    if not instructions and not prompt:
        return json_response(sock, 400, {"error": "instructions or prompt is required"})
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "recipe"
    os.makedirs(RECIPES_DIR, exist_ok=True)
    fn = slug + ".yaml"
    n = 2
    while os.path.exists(os.path.join(RECIPES_DIR, fn)):
        fn = f"{slug}-{n}.yaml"
        n += 1
    path = os.path.join(RECIPES_DIR, fn)
    doc = {"version": "1.0.0", "title": title,
           "description": str(payload.get("description") or "")}
    if instructions:
        doc["instructions"] = instructions
    if prompt:
        doc["prompt"] = prompt
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(doc, f, sort_keys=False, allow_unicode=True)
    # Keep the file only if Goose itself accepts it as a recipe.
    try:
        r = subprocess.run([GOOSE_BIN, "recipe", "validate", path],
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            os.unlink(path)
            msg = (r.stdout + r.stderr).strip().splitlines()
            return json_response(sock, 400, {
                "error": "goose rejected the recipe: " + (msg[-1] if msg else "invalid")})
    except subprocess.TimeoutExpired:
        pass  # validation is best-effort; the file itself is well-formed YAML
    json_response(sock, 200, {"ok": True, "file": fn})

# ---------------------------------------------------------------------------
# Skills: one directory per skill under ~/.agents/skills, each holding a
# SKILL.md with YAML frontmatter (name + description). `goose skills list`
# is read-only, so create / edit / delete are plain file operations here.
# Builtin skills (builtin:// locations) are listed but cannot be modified.
# ---------------------------------------------------------------------------

_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


def _skill_path(name):
    """Resolve a skill name to its directory, or None if unsafe/unknown."""
    if not name or not _SKILL_NAME_RE.match(name) or ".." in name:
        return None
    base = os.path.realpath(SKILLS_DIR)
    path = os.path.realpath(os.path.join(base, name))
    if os.path.dirname(path) != base:
        return None
    return path


def _skill_frontmatter(text):
    """Parse the leading --- YAML block of a SKILL.md, or {} if absent."""
    m = re.match(r"^---\s*\n(.*?)\n---", text or "", re.DOTALL)
    if not m or yaml is None:
        return {}
    try:
        data = yaml.safe_load(m.group(1)) or {}
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _validate_skill_content(sock, content):
    """Return an error response if content is not a usable SKILL.md."""
    fm = _skill_frontmatter(content)
    if not fm.get("name") or not fm.get("description"):
        json_response(sock, 400, {
            "error": "SKILL.md must start with a --- frontmatter block "
                     "containing name and description"})
        return False
    return True


def api_skills_list(sock):
    out = []
    if os.path.isdir(SKILLS_DIR):
        for name in sorted(os.listdir(SKILLS_DIR)):
            path = os.path.join(SKILLS_DIR, name)
            md = os.path.join(path, "SKILL.md")
            if not os.path.isdir(path) or not os.path.isfile(md):
                continue
            try:
                with open(md, encoding="utf-8") as f:
                    fm = _skill_frontmatter(f.read())
            except Exception:
                fm = {}
            files = []
            for root, _dirs, fns in os.walk(path):
                for fn in fns:
                    files.append(os.path.relpath(os.path.join(root, fn), path))
            out.append({
                "name": name,
                "description": str(fm.get("description") or ""),
                "files": sorted(files)[:50],
                "builtin": False,
            })
    # Builtin skills are only visible through the CLI list; show them
    # read-only so the page matches what the agent can actually use.
    try:
        r = subprocess.run([GOOSE_BIN, "skills", "list"],
                           capture_output=True, text=True, timeout=30)
        for line in (r.stdout or "").splitlines():
            parts = [p.strip() for p in line.split("|")]
            # Columns: Name | Description | Desc tokens | Content tokens | Location
            if len(parts) >= 5 and parts[-1].startswith("builtin://"):
                out.append({"name": parts[0], "description": parts[1],
                            "files": [], "builtin": True})
    except Exception:
        pass
    json_response(sock, 200, {"skills": out})


def api_skills_content(sock, payload):
    path = _skill_path(str(payload.get("name") or ""))
    if path is None or not os.path.isfile(os.path.join(path, "SKILL.md")):
        return json_response(sock, 404, {"error": "skill not found"})
    with open(os.path.join(path, "SKILL.md"), encoding="utf-8") as f:
        content = f.read()
    json_response(sock, 200, {"name": os.path.basename(path), "content": content})


def api_skills_save(sock, payload):
    path = _skill_path(str(payload.get("name") or ""))
    if path is None or not os.path.isfile(os.path.join(path, "SKILL.md")):
        return json_response(sock, 404, {"error": "skill not found"})
    content = str(payload.get("content") or "")
    if not _validate_skill_content(sock, content):
        return
    md = os.path.join(path, "SKILL.md")
    shutil.copyfile(md, md + ".gwbak")
    with open(md, "w", encoding="utf-8") as f:
        f.write(content)
    json_response(sock, 200, {"ok": True})


def api_skills_create(sock, payload):
    name = str(payload.get("name") or "").strip()
    path = _skill_path(name)
    if path is None:
        return json_response(sock, 400, {"error": "invalid skill name"})
    if os.path.exists(path):
        return json_response(sock, 400, {"error": "a skill with this name already exists"})
    content = str(payload.get("content") or "")
    if not _validate_skill_content(sock, content):
        return
    os.makedirs(path)
    with open(os.path.join(path, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write(content)
    json_response(sock, 200, {"ok": True, "name": name})


def api_skills_delete(sock, payload):
    path = _skill_path(str(payload.get("name") or ""))
    if path is None or not os.path.isdir(path):
        return json_response(sock, 404, {"error": "skill not found"})
    shutil.rmtree(path)
    json_response(sock, 200, {"ok": True})


def _goose_cli(*args, timeout=40):
    r = subprocess.run([GOOSE_BIN] + list(args),
                       capture_output=True, text=True, timeout=timeout)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def api_schedules_list(sock):
    code, out = _goose_cli("schedule", "list")
    if code != 0:
        return json_response(sock, 502, {"error": out.strip()[-300:]})
    if "No scheduled jobs found" in out:
        return json_response(sock, 200, {"schedules": []})
    # CLI format (verified against goose 1.60.1):
    #   Scheduled Jobs:
    #   - ID: <id>
    #     Status: <emoji> <STATE>
    #     Cron: <expr>
    #     Recipe Source (in store): <path>
    #     Last Run: <when|Never>
    schedules = []
    current = None
    for line in out.splitlines():
        m = re.match(r"^- ID:\s*(\S+)\s*$", line)
        if m:
            current = {"id": m.group(1), "status": "", "cron": "",
                       "recipeSource": "", "lastRun": ""}
            schedules.append(current)
            continue
        if current is None:
            continue
        m = re.match(r"^\s+(Status|Cron|Recipe Source \(in store\)|Last Run):\s*(.*)$", line)
        if m:
            key = {"Status": "status", "Cron": "cron",
                   "Recipe Source (in store)": "recipeSource",
                   "Last Run": "lastRun"}[m.group(1)]
            value = m.group(2).strip()
            if key == "status":  # strip the leading status emoji/symbol
                value = re.sub(r"^[^A-Za-z]+", "", value).strip()
            current[key] = value
    json_response(sock, 200, {"schedules": schedules})


def api_schedules_add(sock, payload):
    sid = str(payload.get("id") or "").strip()
    cron = str(payload.get("cron") or "").strip()
    recipe_file = str(payload.get("recipeFile") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]+", sid):
        return json_response(sock, 400, {"error": "id must be letters, digits, - or _"})
    if not (re.fullmatch(r"@\w+", cron) or len(cron.split()) == 5):
        return json_response(sock, 400, {"error": "cron must be a 5-field expression or @daily etc."})
    if recipe_file not in _recipe_files():
        return json_response(sock, 400, {"error": "choose an existing recipe file"})
    code, out = _goose_cli("schedule", "add", "--schedule-id", sid,
                           "--cron", cron, "--recipe-source",
                           os.path.join(RECIPES_DIR, recipe_file))
    if code != 0:
        return json_response(sock, 502, {"error": out.strip()[-300:]})
    json_response(sock, 200, {"ok": True})


def api_schedules_remove(sock, payload):
    sid = str(payload.get("id") or "").strip()
    code, out = _goose_cli("schedule", "remove", "--schedule-id", sid)
    if code != 0:
        return json_response(sock, 502, {"error": out.strip()[-300:]})
    json_response(sock, 200, {"ok": True})


def api_schedules_run_now(sock, payload):
    sid = str(payload.get("id") or "").strip()
    code, out = _goose_cli("schedule", "run-now", "--schedule-id", sid, timeout=60)
    if code != 0:
        return json_response(sock, 502, {"error": out.strip()[-300:]})
    json_response(sock, 200, {"ok": True})


# ChatGPT (Codex) subscription quota, via chatgpt.com's wham/usage
# endpoint. The browser never sees the login token: the gateway reads
# Goose's own Codex token cache on the Pi and calls the endpoint through
# the local Mihomo proxy. Cached for 2 minutes; only the plan name and
# the two window percentages are returned to the client.
CODEX_TOKENS_FILE = os.path.expanduser("~/.config/goose/chatgpt_codex/tokens.json")
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_USAGE_TTL = 120
_codex_usage_cache = {"at": 0.0, "data": None}


def api_codex_usage(sock):
    now = time.time()
    if (_codex_usage_cache["data"] is not None
            and now - _codex_usage_cache["at"] < CODEX_USAGE_TTL):
        return json_response(sock, 200, _codex_usage_cache["data"])
    try:
        with open(CODEX_TOKENS_FILE) as f:
            tok = json.load(f)
    except Exception:
        return json_response(sock, 502, {"error": "cannot read codex tokens"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(
        {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}))
    req = urllib.request.Request(CODEX_USAGE_URL, headers={
        "Authorization": "Bearer " + tok["access_token"],
        "ChatGPT-Account-Id": tok.get("account_id") or "",
        "User-Agent": "codex-cli/0.1.0"})
    try:
        with opener.open(req, timeout=25) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return json_response(sock, 502, {"error": "codex token invalid or revoked"})
        return json_response(sock, 502, {"error": f"wham/usage HTTP {e.code}"})
    except Exception as e:
        return json_response(sock, 502, {"error": f"{type(e).__name__}: {e}"})
    rl = body.get("rate_limit") or {}

    def _win(name):
        w = rl.get(name) or {}
        return {"used_percent": w.get("used_percent"),
                "window_seconds": w.get("limit_window_seconds"),
                "reset_at": w.get("reset_at")}

    data = {"ok": True, "plan_type": body.get("plan_type"),
            "primary": _win("primary_window"),
            "secondary": _win("secondary_window")}
    _codex_usage_cache.update({"at": now, "data": data})
    json_response(sock, 200, data)


API_ROUTES = {
    ("GET", "/api/extensions"): api_extensions_list,
    ("POST", "/api/extensions/toggle"): api_extensions_toggle,
    ("POST", "/api/extensions/add"): api_extensions_add,
    ("POST", "/api/extensions/remove"): api_extensions_remove,
    ("GET", "/api/recipes"): api_recipes_list,
    ("GET", "/api/skills"): api_skills_list,
    ("POST", "/api/skills/content"): api_skills_content,
    ("POST", "/api/skills/save"): api_skills_save,
    ("POST", "/api/skills/create"): api_skills_create,
    ("POST", "/api/skills/delete"): api_skills_delete,
    ("POST", "/api/recipes/create"): api_recipes_create,
    ("GET", "/api/schedules"): api_schedules_list,
    ("POST", "/api/schedules/add"): api_schedules_add,
    ("POST", "/api/schedules/remove"): api_schedules_remove,
    ("POST", "/api/schedules/run-now"): api_schedules_run_now,
    ("GET", "/api/codex-usage"): api_codex_usage,
}


def handle_api(sock, method, path, body):
    handler = API_ROUTES.get((method, path))
    if handler is None:
        return json_response(sock, 404, {"error": "unknown api route"})
    try:
        if method == "POST":
            payload = json.loads(body.decode("utf-8") or "{}")
            handler(sock, payload)
        else:
            handler(sock)
    except Exception as e:  # never take the gateway down over an API error
        try:
            json_response(sock, 500, {"error": f"{type(e).__name__}: {e}"})
        except Exception:
            pass


def handle(sock):
    conn = Conn(sock)
    try:
        sock.settimeout(30)
        head = conn.read_until(b"\r\n\r\n")
        method, target, path, headers = parse_request(head)
        body = b""
        if method == "POST":
            n = int(headers.get("content-length", "0") or "0")
            if n > 0:
                body = conn.read_exact(n)

        if path == "/acp" and headers.get("upgrade", "").lower() == "websocket":
            handle_ws(sock, conn, headers)
            return

        if path == "/login" and method == "GET":
            serve_login(sock)
            return
        if path == "/login" and method == "POST":
            form = parse_qs(body.decode("utf-8", "replace"))
            candidate = (form.get("password") or [""])[0]
            if gate_hash(candidate) == GATE_VALUE:
                cookie = (f"{COOKIE_NAME}={GATE_VALUE}; Path=/; HttpOnly; "
                          "SameSite=Lax; Max-Age=2592000")
                http_response(sock, 302, b"", extra_headers=[
                    "Location: /", f"Set-Cookie: {cookie}"])
            else:
                serve_login(sock, "密钥不对，再试一次。")
            return
        if path == "/logout":
            cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0"
            http_response(sock, 302, b"", extra_headers=[
                "Location: /login", f"Set-Cookie: {cookie}"])
            return

        # Everything else requires the gate cookie.
        if not cookie_ok(headers):
            http_response(sock, 302, b"", extra_headers=["Location: /login"])
            return
        if path.startswith("/api/"):
            handle_api(sock, method, path, body)
            return
        if method != "GET":
            http_response(sock, 404, "not found")
            return
        serve_static(sock, path)
    except Exception:
        try:
            sock.close()
        except OSError:
            pass
    finally:
        try:
            sock.close()
        except OSError:
            pass


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(64)
    print(f"goose-web gateway on {HOST}:{PORT}, root={WEB_ROOT}", flush=True)
    while True:
        try:
            client, _ = srv.accept()
        except OSError:
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
