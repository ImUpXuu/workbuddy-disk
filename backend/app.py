#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
简易网盘系统 —— 后端服务

功能：
  - 浏览目录（支持子目录导航）
  - 上传文件（小文件直传；大文件分片上传，绕过网关请求体限制）
  - 下载文件（大文件支持 Range 断点续传）
  - 删除文件 / 文件夹（支持批量）
  - 新建文件夹
  - 重命名

存储：所有文件位于 STORAGE_ROOT 目录下。
安全：所有路径均做「归一化 + 前缀校验」，防止目录穿越（../）攻击。

关于分片上传：
  线上网关（stgw）会把请求体限制在 50MB 左右，超出直接返回 413 且不会到达应用。
  因此大于阈值的文件由前端切成 CHUNK_SIZE 大小的分片逐片上传，服务端落盘暂存，
  最后在 complete 阶段按序合并为完整文件。
"""

import os
import re
import shutil
import time
import html
import json
import hmac
import base64
import hashlib
import secrets
import threading
from datetime import datetime
from pathlib import Path

from flask import (
    Flask, request, jsonify, send_file,
    render_template_string, abort, Response,
    redirect, make_response
)

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
STORAGE_ROOT = (BASE_DIR / "storage").resolve()
STORAGE_ROOT.mkdir(parents=True, exist_ok=True)

# 分片暂存目录（未完成合并的分片存放于此，不对外可见）
TMP_ROOT = (BASE_DIR / ".upload_tmp").resolve()
TMP_ROOT.mkdir(parents=True, exist_ok=True)

# 单文件大小上限（字节）。默认 2 GiB，防止异常大文件拖垮沙箱。
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024

# 前端分片大小：50MB。必须小于网关的请求体限制（实测网关约 50MB 就拒绝，
# 故取 48MB 留出 multipart 边界与表单字段的余量）。
CHUNK_SIZE = 48 * 1024 * 1024

# 超过此大小的文件走分片上传（前端判断，后端仅提供参考值）
CHUNK_THRESHOLD = 48 * 1024 * 1024

# 未完成的分片会话保留时长（秒），超时自动清理，避免磁盘堆积
UPLOAD_SESSION_TTL = 24 * 3600

# ---------------------------------------------------------------------------
# 鉴权配置
# ---------------------------------------------------------------------------
#
# 访问密钥从环境变量 NETDISK_KEY 读取，未设置时回退到默认值。
# 注意：默认值仅用于开箱可用，正式使用请通过环境变量覆盖。
#
ACCESS_KEY = os.environ.get("NETDISK_KEY", "change-me")

# 签名用随机盐：进程启动时生成。服务重启后所有旧会话失效（需重新登录），
# 这是有意的安全取舍——避免把密钥写进磁盘。
_SECRET_SALT = secrets.token_bytes(32)

# 会话有效期（秒），默认 7 天
SESSION_TTL = int(os.environ.get("NETDISK_SESSION_TTL", str(7 * 24 * 3600)))

# Cookie 名称
COOKIE_NAME = "netdisk_session"

# 免鉴权路径（登录页、登录接口本身）
#
# ⚠️ /api/whoami 刻意**不**放在这里。
#    它是探针接口，需要一个「未认证」的返回值来回答「凭证有效吗」，
#    但同时又必须在鉴权流程内跑一遍，才能拿到 kind / key_name。
#    所以它在 _auth_guard 里走完整流程，只在最终未通过时返回 200 + false。
PUBLIC_PATHS = {"/login", "/api/login", "/favicon.ico"}

# ---------------------------------------------------------------------------
# 跨域（CORS）配置
# ---------------------------------------------------------------------------
#
# 前端部署在 Vercel（pan.upxuu.com），后端在自有服务器，两者不同源，
# 因此所有请求都是跨域请求，必须显式放行。
#
# 三个必须处理点：
#   1. 预检（OPTIONS）必须在鉴权之前短路返回 2xx
#      —— 否则浏览器拿到 401 就直接判定跨域失败，根本不会发真正的请求
#   2. 实际响应要带 Access-Control-Allow-Origin
#   3. 若请求带凭证，还要 Allow-Credentials 且 Origin 不能为 *
#
# 白名单通过 NETDISK_CORS_ORIGINS 覆盖，逗号分隔；填 * 表示全部放行（不推荐）。
DEFAULT_CORS_ORIGINS = (
    "https://pan.upxuu.com",
    "https://www.pan.upxuu.com",
    "http://localhost:5173",   # vite dev
    "http://localhost:4173",   # vite preview
    "http://127.0.0.1:5173",
    "http://127.0.0.1:4173",
)

_cors_env = os.environ.get("NETDISK_CORS_ORIGINS", "").strip()
if _cors_env:
    CORS_ORIGINS = [o.strip().rstrip("/") for o in _cors_env.split(",") if o.strip()]
else:
    CORS_ORIGINS = list(DEFAULT_CORS_ORIGINS)

CORS_ALLOW_ALL = "*" in CORS_ORIGINS

# 预检结果缓存时间（秒）
CORS_MAX_AGE = 86400

# 允许的自定义请求头：X-API-Key 是前端主通道，必须列进去
CORS_ALLOW_HEADERS = "Content-Type, Authorization, X-API-Key, X-Requested-With, Range"

# 允许的请求方法
CORS_ALLOW_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"

# 允许浏览器读取的响应头（否则前端拿不到分片上传的校验值等信息）
CORS_EXPOSE_HEADERS = "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, ETag"

# Flask 单请求体上限：要容纳「一个分片 + 表单字段」，留出余量。
# 注意这是应用层上限，网关限制在其之前生效。
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = CHUNK_SIZE + 16 * 1024 * 1024

# 禁止上传的文件名（避免覆盖数据库等敏感文件）
FORBIDDEN_NAMES = {"", ".", ".."}


# ---------------------------------------------------------------------------
# 跨域工具
# ---------------------------------------------------------------------------

def cors_origin_for(req) -> str:
    """
    判断当前请求的 Origin 是否在白名单内，返回应回显的值。

    返回空字符串表示「不放行」，此时不注入任何 CORS 头，
    浏览器自然拦截 —— 这比返回 403 更符合规范，也让非浏览器客户端不受影响。
    """
    origin = req.headers.get("Origin", "").strip()
    if not origin:
        # 非跨域请求（如 curl、服务端直连、同源页面），无需处理
        return ""
    if CORS_ALLOW_ALL:
        return "*"
    if origin.rstrip("/") in CORS_ORIGINS:
        return origin
    return ""


def apply_cors(resp, origin: str):
    """
    把 CORS 响应头注入到响应对象上。

    幂等：已注入过就直接返回。预检分支已经注入过一次，
    之后 after_request 还会再走一遍，不防重会出现重复的 Vary 头。
    """
    if not origin:
        return resp
    if resp.headers.get("Access-Control-Allow-Origin"):
        return resp
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Methods"] = CORS_ALLOW_METHODS
    resp.headers["Access-Control-Allow-Headers"] = CORS_ALLOW_HEADERS
    resp.headers["Access-Control-Expose-Headers"] = CORS_EXPOSE_HEADERS
    resp.headers["Access-Control-Max-Age"] = str(CORS_MAX_AGE)
    if origin != "*":
        # 明确回显具体来源时，才允许携带凭证（Cookie）。
        # 使用 * 时规范禁止同时开启凭证，故此处不做无条件开启。
        resp.headers["Access-Control-Allow-Credentials"] = "true"
        # 多来源回显必须加 Vary，否则中间缓存可能把 A 域的响应喂给 B 域
        resp.headers["Vary"] = "Origin"
    return resp

# ---------------------------------------------------------------------------
# 配置目录（API Key、设置项）
# ---------------------------------------------------------------------------

CONFIG_DIR = (BASE_DIR / ".config").resolve()
CONFIG_DIR.mkdir(parents=True, exist_ok=True)
try:
    os.chmod(CONFIG_DIR, 0o700)
except OSError:
    pass

APIKEYS_FILE = CONFIG_DIR / "apikeys.json"
SETTINGS_FILE = CONFIG_DIR / "settings.json"

# 各类标识符的字符集（去掉易混淆的 0/O/1/l/I）
_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

# 默认设置项
DEFAULT_SETTINGS = {
    # 前端多文件并发上传数（1~10）
    "upload_concurrency": 3,
    # 危险操作开关：关闭后，API Key 调用 delete / rename / mkdir / abort 会被拒绝
    "allow_dangerous": True,
    # API Key 默认有效期（天）；0 表示永不过期
    "api_key_ttl_days": 0,
}

_SETTINGS_LOCK = threading.Lock()
_APIKEYS_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# 通用 JSON 读写（原子写 + 权限收紧）
# ---------------------------------------------------------------------------

def _json_read(path: Path, default):
    """读取 JSON 文件，不存在或损坏时返回 default。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def _json_write(path: Path, data) -> None:
    """原子写 JSON：先写临时文件再 rename，权限 600。"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)


def _coerce_settings(raw) -> dict:
    """把任意输入校正成合法设置 dict（不做 IO，供 load/save 共用）。"""
    if not isinstance(raw, dict):
        raw = {}
    cfg = dict(DEFAULT_SETTINGS)
    cfg.update({k: v for k, v in raw.items() if k in DEFAULT_SETTINGS})
    try:
        cfg["upload_concurrency"] = max(1, min(10, int(cfg["upload_concurrency"])))
    except (TypeError, ValueError):
        cfg["upload_concurrency"] = DEFAULT_SETTINGS["upload_concurrency"]
    cfg["allow_dangerous"] = bool(cfg["allow_dangerous"])
    try:
        cfg["api_key_ttl_days"] = max(0, int(cfg["api_key_ttl_days"]))
    except (TypeError, ValueError):
        cfg["api_key_ttl_days"] = 0
    return cfg


def load_settings() -> dict:
    """读取设置，缺项用默认值补齐（向前兼容）。"""
    with _SETTINGS_LOCK:
        raw = _json_read(SETTINGS_FILE, {})
    return _coerce_settings(raw)


def save_settings(patch: dict) -> dict:
    """合并写入设置，返回写入后的完整设置。"""
    with _SETTINGS_LOCK:
        cur = _coerce_settings(_json_read(SETTINGS_FILE, {}))
        cur.update({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
        cfg = _coerce_settings(cur)
        _json_write(SETTINGS_FILE, cfg)
    return cfg


# ---------------------------------------------------------------------------
# API Key 存储层
# ---------------------------------------------------------------------------
#
# 安全设计：
#   - 磁盘上**只存 SHA-256 哈希**，不存明文；明文仅在创建时返回一次。
#   - 验证用 hmac.compare_digest 做常数时间比对。
#   - Key 明文格式：ndk_<id>_<secret>，便于在日志里识别前缀归属。
#   - 文件权限 600。

def _rand_id(n: int = 10) -> str:
    """生成随机短 ID。"""
    return "".join(secrets.choice(_ID_ALPHABET) for _ in range(n))


def _hash_key(secret: str) -> str:
    """API Key 明文的 SHA-256（含固定域分隔，避免与其他哈希混用）。"""
    return hashlib.sha256(("netdisk-apikey:" + secret).encode()).hexdigest()


def load_apikeys() -> list:
    """读取全部 API Key 记录。"""
    with _APIKEYS_LOCK:
        data = _json_read(APIKEYS_FILE, [])
    return data if isinstance(data, list) else []


def _save_apikeys(items: list) -> None:
    with _APIKEYS_LOCK:
        _json_write(APIKEYS_FILE, items)


def create_apikey(name: str = "", ttl_days: int = 0, scope: str = "full") -> dict:
    """
    新建 API Key，返回包含**明文**的记录（明文只在此刻可见一次）。

    ttl_days = 0 表示永不过期。
    """
    items = load_apikeys()
    kid = _rand_id(10)
    secret = _rand_id(40)
    plain = f"ndk_{kid}_{secret}"
    now = int(time.time())
    rec = {
        "id": kid,
        "name": (name or "").strip()[:60] or f"Key-{kid[:4]}",
        "hash": _hash_key(secret),
        "prefix": plain[:12],          # 仅用于列表展示，不足以还原明文
        "enabled": True,
        "scope": scope if scope in ("full", "readonly") else "full",
        "created_at": now,
        "expires_at": (now + ttl_days * 86400) if ttl_days > 0 else 0,
        "last_used_at": 0,
        "use_count": 0,
    }
    items.append(rec)
    _save_apikeys(items)
    out = dict(rec)
    out["key"] = plain          # 明文，仅此一次返回
    return out


def find_apikey_by_plain(plain: str):
    """按明文找记录；找不到返回 None。"""
    if not plain or not plain.startswith("ndk_"):
        return None
    parts = plain.split("_")
    if len(parts) != 3:
        return None
    kid = parts[1]
    for rec in load_apikeys():
        if rec.get("id") == kid:
            return rec
    return None


def touch_apikey(kid: str) -> None:
    """记录 API Key 的最后使用时间与次数（失败静默，不影响主流程）。"""
    try:
        items = load_apikeys()
        changed = False
        for rec in items:
            if rec.get("id") == kid:
                rec["last_used_at"] = int(time.time())
                rec["use_count"] = int(rec.get("use_count", 0)) + 1
                changed = True
                break
        if changed:
            _save_apikeys(items)
    except Exception:  # noqa: BLE001
        pass


def verify_apikey(plain: str):
    """
    校验 API Key。通过返回记录 dict，失败返回 None。

    校验内容：存在性 → 启用状态 → 有效期 → 哈希比对（常数时间）。
    """
    rec = find_apikey_by_plain(plain)
    if not rec:
        return None
    if not rec.get("enabled", True):
        return None
    exp = int(rec.get("expires_at", 0) or 0)
    if exp and exp < int(time.time()):
        return None
    parts = plain.split("_")
    if len(parts) != 3:
        return None
    if not hmac.compare_digest(_hash_key(parts[2]), str(rec.get("hash", ""))):
        return None
    touch_apikey(rec["id"])
    return rec


def public_apikey_view(rec: dict) -> dict:
    """把记录转成可安全返回给前端的视图（剔除 hash）。"""
    now = int(time.time())
    exp = int(rec.get("expires_at", 0) or 0)
    return {
        "id": rec.get("id"),
        "name": rec.get("name"),
        "prefix": rec.get("prefix"),
        "enabled": bool(rec.get("enabled", True)),
        "scope": rec.get("scope", "full"),
        "created_at": rec.get("created_at", 0),
        "created_h": _fmt_ts(rec.get("created_at", 0)),
        "expires_at": exp,
        "expires_h": "永不过期" if not exp else _fmt_ts(exp),
        "expired": bool(exp and exp < now),
        "last_used_at": rec.get("last_used_at", 0),
        "last_used_h": _fmt_ts(rec.get("last_used_at", 0)) if rec.get("last_used_at") else "从未使用",
        "use_count": int(rec.get("use_count", 0)),
    }


def _fmt_ts(ts) -> str:
    """时间戳转可读字符串。"""
    try:
        ts = int(ts)
    except (TypeError, ValueError):
        return "-"
    if ts <= 0:
        return "-"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))



# ---------------------------------------------------------------------------
# 路径安全工具
# ---------------------------------------------------------------------------

def safe_path(rel: str) -> Path:
    """
    把用户传入的相对路径解析为 STORAGE_ROOT 下的绝对路径。

    安全策略：
      1. 拒绝包含空字节的路径
      2. 归一化后必须仍位于 STORAGE_ROOT 内（防 ../ 穿越）
      3. 拒绝绝对路径与盘符
    """
    if rel is None:
        rel = ""
    if "\x00" in rel:
        abort(400, "路径包含非法字符")

    rel = rel.strip().lstrip("/\\")

    # 归一化：resolve 会消解 ../ 和符号链接
    candidate = (STORAGE_ROOT / rel).resolve()

    # 前缀校验：必须在存储根目录内
    if candidate != STORAGE_ROOT and STORAGE_ROOT not in candidate.parents:
        abort(403, "非法路径")

    return candidate


def rel_of(path: Path) -> str:
    """把绝对路径转成相对 STORAGE_ROOT 的、以 / 分隔的相对路径。"""
    rel = path.relative_to(STORAGE_ROOT)
    return "" if str(rel) == "." else str(rel).replace(os.sep, "/")


def human_size(num: int) -> str:
    """字节数转人类可读格式。"""
    if num < 1024:
        return f"{num} B"
    for unit in ("KB", "MB", "GB", "TB"):
        num /= 1024.0
        if num < 1024:
            return f"{num:.1f} {unit}"
    return f"{num:.1f} PB"


def unique_name(parent: Path, name: str) -> str:
    """
    若目标已存在，自动加后缀 (1)(2)... 避免覆盖。
    返回可用的文件名。
    """
    target = parent / name
    if not target.exists():
        return name

    stem = Path(name).stem
    suffix = Path(name).suffix
    i = 1
    while True:
        cand = f"{stem} ({i}){suffix}"
        if not (parent / cand).exists():
            return cand
        i += 1


def entry_meta(p: Path) -> dict:
    """生成单个文件/目录的元信息。"""
    st = p.stat()
    is_dir = p.is_dir()
    return {
        "name": p.name,
        "path": rel_of(p),
        "is_dir": is_dir,
        "size": 0 if is_dir else st.st_size,
        "size_h": "" if is_dir else human_size(st.st_size),
        "mtime": int(st.st_mtime),
        "mtime_h": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
    }


# ---------------------------------------------------------------------------
# 鉴权
# ---------------------------------------------------------------------------
#
# 设计说明：
#   - 访问密钥来自环境变量 NETDISK_KEY，服务端只做「比对」，密钥本身不下发给前端。
#   - 登录成功后签发一枚签名 Token（HMAC-SHA256），存放在 HttpOnly Cookie 中；
#     同时也支持通过 Authorization: Bearer <token> 或 ?token=<token> 传递，
#     方便脚本 / curl 调用。
#   - Token 内嵌过期时间，服务端验证签名 + 有效期，无需存储会话。
#   - 签名盐在进程启动时随机生成，重启即失效所有旧 Token（安全性优先）。


def _b64d_pad(s: str) -> bytes:
    """base64url 解码，自动补齐 padding。"""
    s = s.strip()
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64e(data: bytes) -> str:
    """URL 安全的 base64 编码（去除 padding）。"""
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    """URL 安全的 base64 解码（自动补齐 padding）。"""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def make_token(ttl: int = SESSION_TTL) -> str:
    """
    签发会话 Token。

    格式：<expire_ts>.<hmac_sig>
      - expire_ts：过期时间戳（秒）
      - hmac_sig ：HMAC-SHA256(_SECRET_SALT, expire_ts) 的前 32 字节
    """
    expire = int(time.time()) + ttl
    payload = str(expire).encode()
    sig = hmac.new(_SECRET_SALT, payload, hashlib.sha256).digest()
    return f"{expire}.{_b64e(sig)}"


def verify_token(token: str) -> bool:
    """校验 Token 的签名与有效期。"""

    if not token or "." not in token:
        return False
    try:
        exp_str, sig_str = token.split(".", 1)
        expire = int(exp_str)
    except (ValueError, TypeError):
        return False

    now = int(time.time())
    if expire < now:
        return False

    try:
        expected = hmac.new(
            _SECRET_SALT, exp_str.encode(), hashlib.sha256
        ).digest()
        provided = _b64d(sig_str)
    except Exception as e:  # noqa: BLE001
        return False

    ok = hmac.compare_digest(expected, provided)
    return ok


def extract_token() -> str:
    """
    从 Cookie / 查询参数 / Authorization 头中提取 Token。

    ⚠️ 网关行为说明（线上实测）：
        1. 线上网关会用自签的 JWT **覆盖** Authorization 请求头
           （形如 `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`），
           因此 Authorization 在线上不可用于传递本应用凭证；
        2. `?token=` / `?apikey=` 查询参数**能原样到达**应用层，可用；
        3. Cookie 能原样透传，是浏览器场景最稳的通道。

    提取优先级：Cookie → 查询参数 → Authorization（本地调试用）。
    Authorization 中的网关 JWT 会被自动识别并跳过。
    """

    def _looks_like_gateway_jwt(v: str) -> bool:
        """识别网关注入的 JWT（三段式 base64url，且头部为 HS256 JWT）。"""
        if v.count(".") != 2:
            return False
        try:
            head = _b64d_pad(v.split(".")[0])
            return b'"alg"' in head or b'"typ"' in head
        except Exception:  # noqa: BLE001
            return False

    # 1) Cookie（浏览器主用，线上最可靠）
    t = request.cookies.get(COOKIE_NAME)
    if t:
        return t

    # 2) 查询参数（本地调试 / API 调用；线上实测可穿透网关）
    t = request.args.get("token", "") or ""
    if t:
        return t

    # 3) Authorization: Bearer <token>（仅本地/内网直连可用）
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        cand = auth[7:].strip()
        # 网关注入的 JWT 直接忽略，避免覆盖真实凭证
        if not _looks_like_gateway_jwt(cand):
            return cand

    return ""


def extract_apikey() -> str:
    """
    从请求中提取 API Key 明文。

    支持的通道（按优先级）：
      1. `?apikey=` 查询参数  —— 实测可穿透线上网关，是主要通道
      2. `X-API-Key` 请求头   —— 本地/内网直连可用（线上网关会剥离）
      3. `Authorization: Bearer ndk_...` —— 仅当值不是网关注入的 JWT 时
    """
    t = request.args.get("apikey", "") or ""
    if t:
        return t.strip()

    t = request.headers.get("X-API-Key", "") or ""
    if t:
        return t.strip()

    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        cand = auth[7:].strip()
        if cand.startswith("ndk_"):
            return cand

    return ""


# 当前请求的鉴权上下文：{kind: "session"|"apikey"|"none", "key": rec|None}
_AUTH_CTX = threading.local()


def current_auth() -> dict:
    """取当前请求的鉴权上下文（未鉴权时返回 none）。"""
    return getattr(_AUTH_CTX, "info", None) or {"kind": "none", "key": None}


def is_authenticated() -> bool:
    """
    当前请求是否已通过鉴权。

    两种通过方式：
      - 会话 Token（Cookie / ?token=，浏览器登录后使用）
      - API Key（?apikey= / X-API-Key，供程序调用）
    """
    info = getattr(_AUTH_CTX, "info", None)
    if info is not None:
        return info.get("kind") != "none"
    return verify_token(extract_token())


def check_key(provided: str) -> bool:
    """比对访问密钥（常数时间，防时序攻击）。"""
    if not provided:
        return False
    return hmac.compare_digest(str(provided), str(ACCESS_KEY))


# ---------------------------------------------------------------------------
# 危险操作控制
# ---------------------------------------------------------------------------

# 受「危险操作开关」约束的接口（关闭后即使是合法 API Key 也会被拒绝）
DANGEROUS_PATHS = {
    "/api/delete", "/api/rename", "/api/mkdir", "/api/upload/abort",
}


def dangerous_allowed() -> bool:
    """
    当前请求是否允许执行危险操作。

    规则：
      - 设置里 allow_dangerous 打开 → 一律允许
      - 关闭时：浏览器会话（Cookie/Token）仍允许（用户在界面上有二次确认）
                但 API Key 调用会被拒绝（防程序误删）
    """
    if load_settings()["allow_dangerous"]:
        return True
    return current_auth().get("kind") == "session"


@app.before_request
def _auth_guard():
    """
    全局鉴权网关。

    规则：
      - CORS 预检（OPTIONS）直接短路放行 —— 必须在鉴权之前，
        否则浏览器拿到 401 会判定跨域失败，真正的请求根本不会发出
      - 免鉴权路径（登录页 / 登录接口 / 收藏图标）直接放行
      - 其余所有请求都要求有效凭证，否则：
          · 页面请求 → 302 跳转登录页
          · API 请求 → 401 JSON
      - 危险操作开关关闭时，API Key 调用危险接口 → 403
    """
    path = request.path
    _AUTH_CTX.info = {"kind": "none", "key": None}

    # 0) CORS 预检：无条件放行，只回 CORS 头，不碰业务逻辑
    if request.method == "OPTIONS":
        resp = make_response("", 204)
        return apply_cors(resp, cors_origin_for(request))

    # 静态资源与免鉴权路径放行
    if path in PUBLIC_PATHS or path.startswith("/static/"):
        return None

    # 1) API Key 通道（程序调用）
    ak = extract_apikey()
    if ak:
        rec = verify_apikey(ak)
        if rec:
            _AUTH_CTX.info = {"kind": "apikey", "key": rec}
            resp = _dangerous_guard(path, "apikey")
            if resp is not None:
                return resp
            return None
        # Key 无效：若同时带了有效会话，则回退到会话（便于浏览器带参调试）
        if not verify_token(extract_token()):
            return jsonify({
                "ok": False, "error": "API Key 无效、已禁用或已过期"
            }), 401

    # 2) 会话 Token 通道（浏览器）
    if verify_token(extract_token()):
        _AUTH_CTX.info = {"kind": "session", "key": None}
        resp = _dangerous_guard(path, "session")
        if resp is not None:
            return resp
        return None

    # 未通过鉴权
    if path.startswith("/api/"):
        # whoami 是探测接口：它的职责就是回答「当前凭证有效吗」，
        # 所以未认证时必须返回 200 + authenticated:false，而不是 401 ——
        # 否则前端无法区分「没登录」和「后端挂了」。
        # 注意它仍在鉴权流程内（不放进 PUBLIC_PATHS），
        # 这样 _AUTH_CTX 会被正确填充，有效凭证能拿到 kind/key_name。
        if path == "/api/whoami":
            return jsonify({
                "ok": True, "authenticated": False, "kind": "none", "key_name": None,
            }), 200
        return jsonify({"ok": False, "error": "未登录或登录已过期", "auth_required": True}), 401

    # 页面请求：重定向到登录页
    return redirect("/login")


def _dangerous_guard(path: str, kind: str):
    """危险操作开关检查；不允许时返回 403 响应，否则返回 None。"""
    if path not in DANGEROUS_PATHS:
        return None
    if kind == "session":
        return None
    if load_settings()["allow_dangerous"]:
        return None
    return jsonify({
        "ok": False,
        "error": "危险操作开关已关闭，API Key 不能执行删除 / 重命名 / 新建 / 中止上传",
        "dangerous_blocked": True,
    }), 403


@app.after_request
def _cors_headers(resp):
    """
    统一注入 CORS 响应头。

    放在 after_request 而非每个路由里，是为了覆盖所有出口：
    正常响应、错误 JSON、重定向、文件流下载，一个都不漏。
    """
    return apply_cors(resp, cors_origin_for(request))


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.route("/api/list")
def api_list():
    """列出某个目录下的内容。目录在前，文件在后，各自按名称排序。"""
    rel = request.args.get("path", "")
    target = safe_path(rel)

    if not target.exists():
        return jsonify({"ok": False, "error": "目录不存在"}), 404
    if not target.is_dir():
        return jsonify({"ok": False, "error": "不是目录"}), 400

    dirs, files = [], []
    for child in target.iterdir():
        try:
            meta = entry_meta(child)
        except (OSError, PermissionError):
            continue
        (dirs if meta["is_dir"] else files).append(meta)

    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["name"].lower())

    # 计算路径面包屑
    crumbs = []
    acc = []
    for seg in [s for s in rel_of(target).split("/") if s]:
        acc.append(seg)
        crumbs.append({"name": seg, "path": "/".join(acc)})

    return jsonify({
        "ok": True,
        "path": rel_of(target),
        "crumbs": crumbs,
        "items": dirs + files,
        "total": len(dirs) + len(files),
        "max_file_size": MAX_FILE_SIZE,
        "chunk_size": CHUNK_SIZE,
        "chunk_threshold": CHUNK_THRESHOLD,
    })


@app.route("/api/upload", methods=["POST"])
def api_upload():
    """上传一个或多个文件到指定目录（字段名 files，多文件支持）。"""
    rel = request.form.get("path", "")
    target_dir = safe_path(rel)

    if not target_dir.exists() or not target_dir.is_dir():
        return jsonify({"ok": False, "error": "目标目录不存在"}), 404

    uploaded = request.files.getlist("files")
    if not uploaded:
        return jsonify({"ok": False, "error": "没有收到文件"}), 400

    results = []
    for f in uploaded:
        raw_name = os.path.basename(f.filename or "")
        if raw_name in FORBIDDEN_NAMES:
            results.append({"name": raw_name, "ok": False, "error": "非法文件名"})
            continue

        # 统一覆盖策略：不覆盖，自动改名
        name = unique_name(target_dir, raw_name)
        dest = target_dir / name

        try:
            f.save(str(dest))
            size = dest.stat().st_size
            results.append({
                "name": name, "ok": True,
                "size": size, "size_h": human_size(size)
            })
        except Exception as e:  # noqa: BLE001
            results.append({"name": raw_name, "ok": False, "error": str(e)})

    ok_count = sum(1 for r in results if r["ok"])
    return jsonify({
        "ok": ok_count > 0,
        "results": results,
        "uploaded": ok_count,
        "failed": len(results) - ok_count,
    })


# --------------------------- 分片上传 ---------------------------
#
# 流程：
#   1. POST /api/upload/init      —— 提交文件元信息，拿到 upload_id
#   2. POST /api/upload/chunk     —— 逐片上传（每片 <= CHUNK_SIZE）
#   3. POST /api/upload/complete  —— 所有分片到齐后合并为完整文件
#   4. POST /api/upload/abort     —— 主动放弃，清理临时分片
#
# 会话信息以 JSON 落盘（upload_id.meta），便于服务重启后仍可续传。


def _session_dir(upload_id: str) -> Path:
    """分片会话目录。upload_id 只允许十六进制，避免路径注入。"""
    if not re.fullmatch(r"[0-9a-f]{16,64}", upload_id or ""):
        abort(400, "upload_id 非法")
    return TMP_ROOT / upload_id


def _load_meta(upload_id: str) -> dict:
    d = _session_dir(upload_id)
    meta_file = d / "meta.json"
    if not meta_file.exists():
        abort(404, "上传会话不存在或已过期")
    try:
        return json.loads(meta_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        abort(500, "上传会话元数据损坏")


def _save_meta(upload_id: str, meta: dict) -> None:
    d = _session_dir(upload_id)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "meta.json.tmp"
    tmp.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
    tmp.replace(d / "meta.json")


def cleanup_stale_sessions() -> int:
    """清理超时未完成的分片会话，返回清理数量。"""
    removed = 0
    now = time.time()
    if not TMP_ROOT.exists():
        return 0
    for child in TMP_ROOT.iterdir():
        if not child.is_dir():
            continue
        try:
            if now - child.stat().st_mtime > UPLOAD_SESSION_TTL:
                shutil.rmtree(child, ignore_errors=True)
                removed += 1
        except OSError:
            pass
    return removed


@app.route("/api/upload/init", methods=["POST"])
def api_upload_init():
    """
    初始化分片上传会话。

    入参（JSON）：
      path     目标目录相对路径
      name     文件名
      size     文件总字节数
      chunk_size 分片大小（可选，用于计算总分片数）
    """
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    name = os.path.basename((data.get("name") or "").strip())
    size = data.get("size")
    chunk_size = int(data.get("chunk_size") or CHUNK_SIZE)

    if not name or name in FORBIDDEN_NAMES:
        return jsonify({"ok": False, "error": "文件名无效"}), 400
    if not isinstance(size, int) or size <= 0:
        return jsonify({"ok": False, "error": "文件大小无效"}), 400
    if size > MAX_FILE_SIZE:
        return jsonify({
            "ok": False,
            "error": f"文件过大，单文件上限 {human_size(MAX_FILE_SIZE)}"
        }), 413
    if chunk_size <= 0 or chunk_size > CHUNK_SIZE:
        chunk_size = CHUNK_SIZE

    target_dir = safe_path(rel)
    if not target_dir.exists() or not target_dir.is_dir():
        return jsonify({"ok": False, "error": "目标目录不存在"}), 404

    total_chunks = (size + chunk_size - 1) // chunk_size

    # 生成随机 upload_id（32 位十六进制）
    upload_id = hashlib.sha256(
        f"{time.time_ns()}-{os.urandom(16).hex()}".encode()
    ).hexdigest()[:32]

    meta = {
        "upload_id": upload_id,
        "path": rel_of(target_dir),
        "name": name,
        "size": size,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "created_at": time.time(),
        "received": [],          # 已收到的分片序号
    }
    d = _session_dir(upload_id)
    (d / "chunks").mkdir(parents=True, exist_ok=True)
    _save_meta(upload_id, meta)

    # 顺手清理过期会话
    try:
        cleanup_stale_sessions()
    except Exception:  # noqa: BLE001
        pass

    return jsonify({
        "ok": True,
        "upload_id": upload_id,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
    })


@app.route("/api/upload/chunk", methods=["POST"])
def api_upload_chunk():
    """
    接收单个分片。

    multipart 字段：
      upload_id  会话 ID
      index      分片序号（从 0 开始）
      chunk      分片数据
    """
    upload_id = request.form.get("upload_id", "")
    index_raw = request.form.get("index", "")
    d = _session_dir(upload_id)
    meta = _load_meta(upload_id)

    if not index_raw.isdigit():
        return jsonify({"ok": False, "error": "分片序号无效"}), 400
    index = int(index_raw)

    if index < 0 or index >= meta["total_chunks"]:
        return jsonify({"ok": False, "error": "分片序号越界"}), 400

    f = request.files.get("chunk")
    if f is None:
        return jsonify({"ok": False, "error": "没有收到分片数据"}), 400

    chunk_path = d / "chunks" / f"{index:08d}.part"
    try:
        # 先写临时文件再原子替换，避免半截分片被误判为已完成
        tmp_path = chunk_path.with_suffix(".part.tmp")
        f.save(str(tmp_path))
        tmp_path.replace(chunk_path)
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"分片写入失败: {e}"}), 500

    # 记录已收到的分片（去重）
    received = set(meta.get("received") or [])
    received.add(index)
    meta["received"] = sorted(received)
    _save_meta(upload_id, meta)

    return jsonify({
        "ok": True,
        "index": index,
        "received": len(meta["received"]),
        "total_chunks": meta["total_chunks"],
    })


@app.route("/api/upload/complete", methods=["POST"])
def api_upload_complete():
    """合并所有分片为完整文件，并校验大小。"""
    data = request.get_json(silent=True) or {}
    upload_id = data.get("upload_id", "")
    d = _session_dir(upload_id)
    meta = _load_meta(upload_id)

    total = meta["total_chunks"]
    received = set(meta.get("received") or [])
    missing = [i for i in range(total) if i not in received]
    if missing:
        return jsonify({
            "ok": False,
            "error": f"缺少 {len(missing)} 个分片，无法合并",
            "missing": missing[:50],
        }), 400

    target_dir = safe_path(meta["path"])
    if not target_dir.exists() or not target_dir.is_dir():
        return jsonify({"ok": False, "error": "目标目录不存在"}), 404

    # 合并目标：沿用「不覆盖、自动改名」策略
    final_name = unique_name(target_dir, meta["name"])
    dest = target_dir / final_name
    tmp_out = dest.with_name(dest.name + ".merging")

    try:
        with open(tmp_out, "wb") as out:
            for i in range(total):
                part = d / "chunks" / f"{i:08d}.part"
                if not part.exists():
                    raise FileNotFoundError(f"分片 {i} 丢失")
                with open(part, "rb") as pf:
                    shutil.copyfileobj(pf, out, length=1024 * 1024)
        actual = tmp_out.stat().st_size
        if actual != meta["size"]:
            tmp_out.unlink(missing_ok=True)
            return jsonify({
                "ok": False,
                "error": f"合并后大小不符：期望 {meta['size']}，实际 {actual}"
            }), 400
        tmp_out.replace(dest)
    except Exception as e:  # noqa: BLE001
        tmp_out.unlink(missing_ok=True)
        return jsonify({"ok": False, "error": f"合并失败: {e}"}), 500

    # 清理会话
    shutil.rmtree(d, ignore_errors=True)

    return jsonify({
        "ok": True,
        "name": final_name,
        "size": actual,
        "size_h": human_size(actual),
    })


@app.route("/api/upload/abort", methods=["POST"])
def api_upload_abort():
    """放弃上传，清理已落盘的分片。"""
    data = request.get_json(silent=True) or {}
    upload_id = data.get("upload_id", "")
    d = _session_dir(upload_id)
    shutil.rmtree(d, ignore_errors=True)
    return jsonify({"ok": True})


@app.route("/api/upload/status")
def api_upload_status():
    """查询会话已收到的分片，用于断点续传。"""
    upload_id = request.args.get("upload_id", "")
    meta = _load_meta(upload_id)
    return jsonify({
        "ok": True,
        "upload_id": upload_id,
        "received": meta.get("received") or [],
        "total_chunks": meta["total_chunks"],
        "size": meta["size"],
    })


@app.route("/api/download")
def api_download():
    """
    下载单个文件。

    开启 conditional=True 后 Flask 会处理 Range 请求头，
    大文件下载可断点续传（浏览器/下载器会自动利用）。
    """
    rel = request.args.get("path", "")
    target = safe_path(rel)

    if not target.exists() or not target.is_file():
        abort(404, "文件不存在")

    return send_file(
        str(target),
        as_attachment=True,
        download_name=target.name,
        conditional=True,   # 支持 Range / If-Range，实现断点续传
    )


@app.route("/api/delete", methods=["POST"])
def api_delete():
    """删除文件或目录（支持批量）。"""
    data = request.get_json(silent=True) or {}
    paths = data.get("paths") or []
    if not isinstance(paths, list) or not paths:
        return jsonify({"ok": False, "error": "未指定要删除的内容"}), 400

    results = []
    for rel in paths:
        try:
            target = safe_path(rel)
        except Exception:  # noqa: BLE001
            results.append({"path": rel, "ok": False, "error": "非法路径"})
            continue

        if target == STORAGE_ROOT:
            results.append({"path": rel, "ok": False, "error": "不能删除根目录"})
            continue
        if not target.exists():
            results.append({"path": rel, "ok": False, "error": "不存在"})
            continue

        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            results.append({"path": rel, "ok": True})
        except Exception as e:  # noqa: BLE001
            results.append({"path": rel, "ok": False, "error": str(e)})

    ok_count = sum(1 for r in results if r["ok"])
    return jsonify({"ok": ok_count > 0, "results": results, "deleted": ok_count})


@app.route("/api/mkdir", methods=["POST"])
def api_mkdir():
    """新建文件夹。"""
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    name = (data.get("name") or "").strip()

    if not name or name in FORBIDDEN_NAMES:
        return jsonify({"ok": False, "error": "文件夹名无效"}), 400
    # 禁止路径分隔符，避免创建嵌套结构
    if re.search(r"[/\\]", name):
        return jsonify({"ok": False, "error": "文件夹名不能包含 / 或 \\"}), 400

    parent = safe_path(rel)
    if not parent.exists() or not parent.is_dir():
        return jsonify({"ok": False, "error": "父目录不存在"}), 404

    final = unique_name(parent, name)
    try:
        (parent / final).mkdir()
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "name": final})


@app.route("/api/rename", methods=["POST"])
def api_rename():
    """重命名文件/文件夹。"""
    data = request.get_json(silent=True) or {}
    rel = data.get("path", "")
    new_name = (data.get("new_name") or "").strip()

    if not new_name or new_name in FORBIDDEN_NAMES:
        return jsonify({"ok": False, "error": "名称无效"}), 400
    if re.search(r"[/\\]", new_name):
        return jsonify({"ok": False, "error": "名称不能包含 / 或 \\"}), 400

    target = safe_path(rel)
    if not target.exists():
        return jsonify({"ok": False, "error": "目标不存在"}), 404
    if target == STORAGE_ROOT:
        return jsonify({"ok": False, "error": "不能重命名根目录"}), 400

    dest = target.parent / new_name
    if dest.exists():
        return jsonify({"ok": False, "error": "同名文件已存在"}), 409

    try:
        target.rename(dest)
    except Exception as e:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True, "new_path": rel_of(dest)})


@app.route("/api/stats")
def api_stats():
    """统计存储用量（文件数、总大小）。"""
    total_size = 0
    total_files = 0
    total_dirs = 0
    for root, dirs, files in os.walk(STORAGE_ROOT):
        total_dirs += len(dirs)
        for fn in files:
            fp = Path(root) / fn
            try:
                total_size += fp.stat().st_size
                total_files += 1
            except OSError:
                pass
    return jsonify({
        "ok": True,
        "files": total_files,
        "dirs": total_dirs,
        "size": total_size,
        "size_h": human_size(total_size),
    })


# ---------------------------------------------------------------------------
# 前端页面
# ---------------------------------------------------------------------------

@app.route("/login")
def login_page():
    """登录页面。已登录则直接跳回首页。"""
    if is_authenticated():
        return redirect("/")
    return render_template_string(LOGIN_HTML)


@app.route("/api/login", methods=["POST"])
def api_login():
    """
    校验访问密钥并签发会话 Cookie。

    入参（JSON）：{"key": "..."}
    成功：下发 HttpOnly Cookie 并返回 {"ok": true}
    失败：401
    """
    data = request.get_json(silent=True) or {}
    provided = (data.get("key") or "").strip()

    if not check_key(provided):
        # 刻意不区分「密钥错误」与「密钥为空」，避免给爆破者额外信息
        return jsonify({"ok": False, "error": "密钥错误"}), 401

    token = make_token()
    resp = make_response(jsonify({"ok": True, "token": token, "expires_in": SESSION_TTL}))
    resp.set_cookie(
        COOKIE_NAME,
        token,
        max_age=SESSION_TTL,
        httponly=True,        # 禁止 JS 读取，防 XSS 窃取
        samesite="Lax",       # 防 CSRF
        secure=request.is_secure,   # HTTPS 下才带 Secure 标记
        path="/",
    )
    return resp


@app.route("/api/logout", methods=["POST"])
def api_logout():
    """登出：清除服务端 Cookie。"""
    resp = make_response(jsonify({"ok": True}))
    resp.delete_cookie(COOKIE_NAME, path="/")
    return resp


@app.route("/api/whoami")
def api_whoami():
    """返回当前登录状态与鉴权方式，供前端判断。"""
    info = current_auth()
    return jsonify({
        "ok": True,
        "authenticated": is_authenticated(),
        "kind": info.get("kind", "none"),
        "key_name": (info.get("key") or {}).get("name"),
    })


# ---------------------------------------------------------------------------
# 设置与 API Key 管理 API
# ---------------------------------------------------------------------------

@app.route("/api/settings", methods=["GET"])
def api_settings_get():
    """读取设置项与运行时信息，供设置页展示。"""
    cfg = load_settings()
    return jsonify({
        "ok": True,
        "settings": cfg,
        "runtime": {
            "chunk_size": CHUNK_SIZE,
            "chunk_size_h": human_size(CHUNK_SIZE),
            "chunk_threshold": CHUNK_THRESHOLD,
            "max_file_size": MAX_FILE_SIZE,
            "max_file_size_h": human_size(MAX_FILE_SIZE),
            "session_ttl_h": f"{SESSION_TTL // 3600} 小时",
            "auth_mode": current_auth().get("kind", "none"),
            "key_source": "环境变量 NETDISK_KEY" if os.environ.get("NETDISK_KEY") else "内置默认值",
        },
        "defaults": DEFAULT_SETTINGS,
    })


@app.route("/api/settings", methods=["POST"])
def api_settings_post():
    """更新设置项（只接受白名单字段）。"""
    data = request.get_json(silent=True) or {}
    patch = {}

    if "upload_concurrency" in data:
        try:
            patch["upload_concurrency"] = max(1, min(10, int(data["upload_concurrency"])))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "并发数必须是 1~10 的整数"}), 400

    if "allow_dangerous" in data:
        patch["allow_dangerous"] = bool(data["allow_dangerous"])

    if "api_key_ttl_days" in data:
        try:
            patch["api_key_ttl_days"] = max(0, min(3650, int(data["api_key_ttl_days"])))
        except (TypeError, ValueError):
            return jsonify({"ok": False, "error": "有效期必须是 0~3650 的整数（天）"}), 400

    if not patch:
        return jsonify({"ok": False, "error": "没有可更新的字段"}), 400

    cfg = save_settings(patch)
    return jsonify({"ok": True, "settings": cfg})


@app.route("/api/apikeys", methods=["GET"])
def api_apikeys_list():
    """列出全部 API Key（不含明文与哈希）。"""
    items = [public_apikey_view(r) for r in load_apikeys()]
    items.sort(key=lambda x: x.get("created_at", 0), reverse=True)
    return jsonify({
        "ok": True,
        "items": items,
        "count": len(items),
        "active": sum(1 for i in items if i["enabled"] and not i["expired"]),
    })


@app.route("/api/apikeys", methods=["POST"])
def api_apikeys_create():
    """
    新建 API Key。

    明文只在本次响应中返回一次，之后服务端只保留哈希，无法再取回。
    """
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()

    # 有效期：请求体优先，其次取设置里的默认值
    cfg = load_settings()
    ttl = data.get("ttl_days", None)
    if ttl is None:
        ttl = cfg["api_key_ttl_days"]
    try:
        ttl = max(0, min(3650, int(ttl)))
    except (TypeError, ValueError):
        ttl = 0

    scope = data.get("scope", "full")
    rec = create_apikey(name=name, ttl_days=ttl, scope=scope)
    view = public_apikey_view(rec)
    return jsonify({
        "ok": True,
        "item": view,
        "key": rec["key"],           # ⚠️ 仅此一次返回明文
        "warning": "请立即复制保存，关闭后无法再次查看完整 Key。",
    })


@app.route("/api/apikeys/<kid>", methods=["PATCH"])
def api_apikeys_update(kid: str):
    """修改 API Key：启用/禁用、改备注。"""
    data = request.get_json(silent=True) or {}
    items = load_apikeys()

    for rec in items:
        if rec.get("id") != kid:
            continue
        if "enabled" in data:
            rec["enabled"] = bool(data["enabled"])
        if "name" in data:
            nm = (data["name"] or "").strip()[:60]
            if nm:
                rec["name"] = nm
        _save_apikeys(items)
        return jsonify({"ok": True, "item": public_apikey_view(rec)})

    return jsonify({"ok": False, "error": "API Key 不存在"}), 404


@app.route("/api/apikeys/<kid>", methods=["DELETE"])
def api_apikeys_delete(kid: str):
    """删除（撤销）API Key。"""
    items = load_apikeys()
    left = [r for r in items if r.get("id") != kid]
    if len(left) == len(items):
        return jsonify({"ok": False, "error": "API Key 不存在"}), 404

    # 不允许把当前正在使用的 Key 删掉（避免请求中途自断）
    cur = current_auth().get("key") or {}
    if cur.get("id") == kid:
        return jsonify({"ok": False, "error": "不能删除当前正在使用的 Key"}), 400

    _save_apikeys(left)
    return jsonify({"ok": True, "deleted": kid})


@app.route("/")
def index():
    return render_template_string(INDEX_HTML, max_file_size=MAX_FILE_SIZE)


@app.errorhandler(413)
def too_large(e):  # noqa: ARG001
    return jsonify({
        "ok": False,
        "error": f"文件过大，单文件上限 {human_size(MAX_FILE_SIZE)}"
    }), 413


LOGIN_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>登录 · 我的网盘</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --border: #e4e6eb;
    --text: #1f2328;
    --text-dim: #6b7280;
    --accent: #2f6feb;
    --accent-soft: #eaf0fd;
    --danger: #d9453d;
    --radius: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d;
      --card: #1e2127;
      --border: #2e323b;
      --text: #e6e8eb;
      --text-dim: #9aa1ac;
      --accent: #5b8def;
      --accent-soft: #23304a;
      --danger: #ef6b64;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; -webkit-font-smoothing: antialiased;
  }
  .box {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 34px 30px;
    width: 100%; max-width: 380px;
    box-shadow: 0 8px 28px rgba(16,24,40,.08);
  }
  .logo { font-size: 40px; text-align: center; margin-bottom: 12px; }
  h1 { font-size: 19px; font-weight: 650; text-align: center; margin-bottom: 6px; letter-spacing: -.02em; }
  .sub { font-size: 13.5px; color: var(--text-dim); text-align: center; margin-bottom: 26px; }
  label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 7px; }
  input {
    width: 100%; font: inherit; font-size: 15px; padding: 11px 13px;
    border: 1px solid var(--border); border-radius: 9px;
    background: var(--bg); color: var(--text); margin-bottom: 16px;
    transition: border-color .15s ease;
  }
  input:focus { outline: none; border-color: var(--accent); }
  button {
    width: 100%; font: inherit; font-size: 15px; font-weight: 550;
    padding: 11px; cursor: pointer;
    background: var(--accent); color: #fff;
    border: none; border-radius: 9px;
    transition: opacity .15s ease;
  }
  button:hover { opacity: .9; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .err {
    font-size: 13px; color: var(--danger); margin-bottom: 14px;
    min-height: 18px; text-align: center;
  }
  .err.show { animation: shake .3s ease; }
  @keyframes shake {
    0%,100% { transform: translateX(0); }
    25% { transform: translateX(-5px); }
    75% { transform: translateX(5px); }
  }
</style>
</head>
<body>
<div class="box">
  <div class="logo">🔒</div>
  <h1>我的网盘</h1>
  <div class="sub">请输入访问密钥以继续</div>

  <form id="f">
    <label for="key">访问密钥</label>
    <input id="key" type="password" placeholder="请输入密钥" autocomplete="current-password" autofocus>
    <div class="err" id="err"></div>
    <button type="submit" id="btn">进入</button>
  </form>
</div>

<script>
const $ = (id) => document.getElementById(id);

$("f").onsubmit = async (e) => {
  e.preventDefault();
  const key = $("key").value.trim();
  const err = $("err");
  err.textContent = "";
  err.classList.remove("show");

  if (!key) {
    err.textContent = "请输入密钥";
    err.classList.add("show");
    return;
  }

  $("btn").disabled = true;
  $("btn").textContent = "验证中…";

  try {
    const r = await fetch("api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key })
    });
    const d = await r.json();

    if (d.ok) {
      location.href = "/";
      return;
    }
    err.textContent = d.error || "密钥错误";
    err.classList.add("show");
    $("key").value = "";
    $("key").focus();
  } catch (ex) {
    err.textContent = "网络错误，请重试";
    err.classList.add("show");
  } finally {
    $("btn").disabled = false;
    $("btn").textContent = "进入";
  }
};
</script>
</body>
</html>
"""


INDEX_HTML = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>我的网盘</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card: #ffffff;
    --border: #e4e6eb;
    --text: #1f2328;
    --text-dim: #6b7280;
    --accent: #2f6feb;
    --accent-soft: #eaf0fd;
    --danger: #d9453d;
    --radius: 12px;
    --shadow: 0 1px 3px rgba(16,24,40,.06), 0 1px 2px rgba(16,24,40,.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d;
      --card: #1e2127;
      --border: #2e323b;
      --text: #e6e8eb;
      --text-dim: #9aa1ac;
      --accent: #5b8def;
      --accent-soft: #23304a;
      --danger: #ef6b64;
      --shadow: 0 1px 3px rgba(0,0,0,.4);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
                 "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    background: var(--bg); color: var(--text);
    min-height: 100vh; padding: 24px 16px 48px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 980px; margin: 0 auto; }

  header { display: flex; align-items: center; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  h1 { font-size: 21px; font-weight: 650; letter-spacing: -.02em; }
  .stats { font-size: 13px; color: var(--text-dim); margin-left: auto; }

  .card {
    background: var(--card); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow);
  }

  /* 上传区 */
  .drop {
    padding: 26px 20px; text-align: center; margin-bottom: 16px;
    border: 2px dashed var(--border); border-radius: var(--radius);
    background: var(--card); transition: all .18s ease; cursor: pointer;
  }
  .drop:hover { border-color: var(--accent); background: var(--accent-soft); }
  .drop.over { border-color: var(--accent); background: var(--accent-soft); transform: scale(1.005); }
  .drop-title { font-size: 15px; font-weight: 600; margin-bottom: 5px; }
  .drop-sub { font-size: 13px; color: var(--text-dim); }
  .drop input { display: none; }

  /* 工具栏 */
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .crumbs { font-size: 13.5px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .crumbs a { color: var(--accent); text-decoration: none; cursor: pointer; }
  .crumbs a:hover { text-decoration: underline; }
  .crumbs .sep { color: var(--text-dim); }
  .crumbs .cur { font-weight: 600; }
  .spacer { margin-left: auto; }

  button {
    font: inherit; font-size: 13px; padding: 6px 13px; cursor: pointer;
    background: var(--card); color: var(--text);
    border: 1px solid var(--border); border-radius: 7px;
    transition: all .15s ease; white-space: nowrap;
  }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.primary:hover { opacity: .9; color: #fff; }
  button.danger { color: var(--danger); }
  button.danger:hover { border-color: var(--danger); background: var(--danger); color: #fff; }
  button:disabled { opacity: .5; cursor: not-allowed; }

  /* 文件列表 */
  .list { }
  .row {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 14px; border-bottom: 1px solid var(--border);
    transition: background .12s ease;
  }
  .row:last-child { border-bottom: none; }
  .row:hover { background: var(--accent-soft); }
  .row .ico { font-size: 19px; width: 24px; text-align: center; flex-shrink: 0; }
  .row .nm {
    flex: 1; min-width: 0; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .row .nm.dir { cursor: pointer; font-weight: 550; }
  .row .nm.dir:hover { color: var(--accent); text-decoration: underline; }
  .row .sz { font-size: 12.5px; color: var(--text-dim); width: 78px; text-align: right; flex-shrink: 0; }
  .row .tm { font-size: 12.5px; color: var(--text-dim); width: 120px; text-align: right; flex-shrink: 0; }
  .row .acts { display: flex; gap: 5px; flex-shrink: 0; }
  .row .acts button { padding: 4px 9px; font-size: 12px; }
  @media (max-width: 640px) {
    .row .tm { display: none; }
    .row .sz { width: 60px; }
  }

  .empty { padding: 54px 20px; text-align: center; color: var(--text-dim); font-size: 14px; }
  .empty .big { font-size: 40px; margin-bottom: 10px; opacity: .5; }

  /* 进度条 */
  #progress { display: none; margin-bottom: 16px; padding: 14px 16px; }
  #progress .bar-bg {
    height: 7px; background: var(--border); border-radius: 4px; overflow: hidden; margin-top: 9px;
  }
  #progress .bar { height: 100%; width: 0; background: var(--accent); border-radius: 4px; transition: width .2s ease; }
  #progress .ptxt { font-size: 13px; color: var(--text-dim); display: flex; justify-content: space-between; }
  #pList { margin-top: 10px; max-height: 210px; overflow-y: auto; }
  .prow {
    display: flex; align-items: center; gap: 10px;
    font-size: 12.5px; padding: 5px 2px; border-top: 1px solid var(--border);
  }
  .prow:first-child { border-top: none; }
  .prow .pnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prow .pinfo { color: var(--text-dim); flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .prow .pstat { width: 92px; text-align: right; flex-shrink: 0; color: var(--text-dim); }
  .prow.ok .pstat { color: #1a8f4a; }
  .prow.err .pstat { color: var(--danger); }

  /* 提示 */
  #toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(20px);
    background: #222; color: #fff; padding: 11px 20px; border-radius: 9px;
    font-size: 13.5px; opacity: 0; pointer-events: none;
    transition: all .25s ease; z-index: 999; max-width: 90vw;
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #toast.err { background: var(--danger); }

  /* 弹窗 */
  .modal {
    position: fixed; inset: 0; background: rgba(0,0,0,.42);
    display: none; align-items: center; justify-content: center; z-index: 1000; padding: 20px;
  }
  .modal.show { display: flex; }
  .modal .box { background: var(--card); border-radius: var(--radius); padding: 22px; width: 100%; max-width: 360px; }
  .modal h3 { font-size: 15.5px; margin-bottom: 13px; }
  .modal input {
    width: 100%; font: inherit; font-size: 14px; padding: 9px 11px;
    border: 1px solid var(--border); border-radius: 7px;
    background: var(--bg); color: var(--text); margin-bottom: 15px;
  }
  .modal input:focus { outline: none; border-color: var(--accent); }
  .modal .btns { display: flex; gap: 8px; justify-content: flex-end; }
  .modal .msg { font-size: 14px; color: var(--text-dim); margin-bottom: 18px; line-height: 1.6; }

  /* ---------- 设置弹层 ---------- */
  .sheet {
    position: fixed; inset: 0; background: rgba(0,0,0,.42);
    display: none; align-items: flex-start; justify-content: center;
    z-index: 1000; padding: 4vh 16px; overflow-y: auto;
  }
  .sheet.show { display: flex; }
  .sheet .panel {
    background: var(--card); border-radius: var(--radius);
    width: 100%; max-width: 680px; box-shadow: 0 12px 40px rgba(0,0,0,.22);
    overflow: hidden;
  }
  .sheet .shead {
    display: flex; align-items: center; padding: 15px 18px;
    border-bottom: 1px solid var(--border); position: sticky; top: 0;
    background: var(--card); z-index: 2;
  }
  .sheet .shead h3 { font-size: 16px; font-weight: 650; }
  .sheet .shead button { margin-left: auto; }
  .sheet .sbody { padding: 4px 18px 20px; }

  .sec { padding: 16px 0; border-bottom: 1px solid var(--border); }
  .sec:last-child { border-bottom: none; }
  .sec > h4 {
    font-size: 13px; font-weight: 650; color: var(--text-dim);
    text-transform: uppercase; letter-spacing: .06em; margin-bottom: 12px;
  }

  .field { display: flex; align-items: center; gap: 12px; padding: 8px 0; }
  .field .fl { flex: 1; min-width: 0; }
  .field .fl .t { font-size: 14px; }
  .field .fl .d { font-size: 12.5px; color: var(--text-dim); margin-top: 2px; line-height: 1.5; }
  .field input[type="number"], .field select {
    font: inherit; font-size: 14px; padding: 6px 9px; width: 88px;
    border: 1px solid var(--border); border-radius: 7px;
    background: var(--bg); color: var(--text); text-align: center;
  }
  .field input:focus, .field select:focus { outline: none; border-color: var(--accent); }

  /* 开关 */
  .sw { position: relative; width: 44px; height: 25px; flex-shrink: 0; }
  .sw input { opacity: 0; width: 0; height: 0; }
  .sw .track {
    position: absolute; inset: 0; background: var(--border);
    border-radius: 13px; cursor: pointer; transition: background .2s ease;
  }
  .sw .track::before {
    content: ""; position: absolute; width: 19px; height: 19px; left: 3px; top: 3px;
    background: #fff; border-radius: 50%; transition: transform .2s ease;
    box-shadow: 0 1px 3px rgba(0,0,0,.28);
  }
  .sw input:checked + .track { background: var(--accent); }
  .sw input:checked + .track::before { transform: translateX(19px); }

  /* Key 列表 */
  .krow {
    display: flex; align-items: center; gap: 11px; padding: 11px 0;
    border-top: 1px solid var(--border);
  }
  .krow:first-child { border-top: none; }
  .krow .km { flex: 1; min-width: 0; }
  .krow .km .kn {
    font-size: 14px; font-weight: 550;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .krow .km .kd { font-size: 12px; color: var(--text-dim); margin-top: 3px; font-variant-numeric: tabular-nums; }
  .krow .km .kd code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--accent-soft); padding: 1px 5px; border-radius: 4px;
  }
  .krow .kacts { display: flex; gap: 5px; flex-shrink: 0; }
  .krow .kacts button { padding: 4px 9px; font-size: 12px; }
  .krow.off .km .kn { color: var(--text-dim); text-decoration: line-through; }

  .pill {
    display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 20px;
    background: var(--accent-soft); color: var(--accent); margin-left: 6px;
    vertical-align: 1px; font-weight: 600;
  }
  .pill.off { background: var(--border); color: var(--text-dim); }
  .pill.dead { background: rgba(217,69,61,.14); color: var(--danger); }

  /* 新建 Key 后的一次性展示 */
  .keybox {
    background: var(--bg); border: 1px dashed var(--accent);
    border-radius: 9px; padding: 13px; margin: 4px 0 14px;
  }
  .keybox .kv {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; word-break: break-all; line-height: 1.65;
    margin-bottom: 10px; user-select: all;
  }
  .keybox .kw { font-size: 12.5px; color: var(--danger); margin-bottom: 10px; }

  .hint { font-size: 12.5px; color: var(--text-dim); line-height: 1.65; }
  .hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--accent-soft); padding: 1px 5px; border-radius: 4px;
  }
  .empty-sm { font-size: 13px; color: var(--text-dim); padding: 10px 0; }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>📁 我的网盘</h1>
    <div class="stats" id="stats"></div>
  </header>

  <div class="drop" id="drop">
    <div class="drop-title">点击选择文件，或拖拽到此处上传</div>
    <div class="drop-sub" id="dropSub">支持多文件同时上传</div>
    <input type="file" id="fileInput" multiple>
  </div>

  <div class="card" id="progress">
    <div class="ptxt"><span id="pLabel">上传中…</span><span id="pPct">0%</span></div>
    <div class="bar-bg"><div class="bar" id="pBar"></div></div>
    <div id="pList"></div>
  </div>

  <div class="card">
    <div class="toolbar">
      <div class="crumbs" id="crumbs"></div>
      <div class="spacer"></div>
      <button id="btnMkdir">＋ 新建文件夹</button>
      <button id="btnRefresh">↻ 刷新</button>
      <button id="btnSettings">⚙ 设置</button>
      <button id="btnLogout">退出</button>
    </div>
    <div class="list" id="list"></div>
  </div>

</div>

<div id="toast"></div>

<!-- 通用输入弹窗 -->
<div class="modal" id="modalInput">
  <div class="box">
    <h3 id="miTitle">新建文件夹</h3>
    <input id="miInput" type="text" placeholder="请输入名称">
    <div class="btns">
      <button id="miCancel">取消</button>
      <button class="primary" id="miOk">确定</button>
    </div>
  </div>
</div>

<!-- 确认弹窗 -->
<div class="modal" id="modalConfirm">
  <div class="box">
    <h3 id="mcTitle">确认操作</h3>
    <div class="msg" id="mcMsg"></div>
    <div class="btns">
      <button id="mcCancel">取消</button>
      <button class="danger" id="mcOk">确认删除</button>
    </div>
  </div>
</div>

<!-- 设置面板 -->
<div class="sheet" id="sheetSettings">
  <div class="panel">
    <div class="shead">
      <h3>⚙ 设置</h3>
      <button id="setClose">关闭</button>
    </div>
    <div class="sbody">

      <!-- 上传设置 -->
      <div class="sec">
        <h4>上传</h4>
        <div class="field">
          <div class="fl">
            <div class="t">上传并发数</div>
            <div class="d">同时上传几个文件（1~10）。每个文件内部的分片仍是顺序传输。</div>
          </div>
          <input type="number" id="setConc" min="1" max="10" value="3">
          <button id="setConcSave">保存</button>
        </div>
      </div>

      <!-- 安全设置 -->
      <div class="sec">
        <h4>安全</h4>
        <div class="field">
          <div class="fl">
            <div class="t">允许 API Key 执行危险操作</div>
            <div class="d">关闭后，通过 API Key 调用的删除 / 重命名 / 新建文件夹会被拒绝；网页端操作不受影响。</div>
          </div>
          <label class="sw">
            <input type="checkbox" id="setDanger">
            <span class="track"></span>
          </label>
        </div>
        <div class="field">
          <div class="fl">
            <div class="t">新建 Key 的默认有效期</div>
            <div class="d">单位：天。填 0 表示永不过期。</div>
          </div>
          <input type="number" id="setTtl" min="0" max="3650" value="0">
          <button id="setTtlSave">保存</button>
        </div>
      </div>

      <!-- API Key 管理 -->
      <div class="sec">
        <h4>API Key</h4>
        <div class="hint" style="margin-bottom:12px">
          用 API Key 可直接调用本网盘的全部接口。调用时把 Key 拼在链接后面即可：<br>
          <code>GET /api/list?apikey=你的KEY</code>　或　请求头 <code>X-API-Key: 你的KEY</code>
        </div>
        <div id="keyNewBox"></div>
        <div class="field" style="padding-bottom:12px">
          <div class="fl">
            <input type="text" id="keyName" placeholder="给这个 Key 起个名字，比如：备份脚本"
                   style="width:100%;font:inherit;font-size:14px;padding:8px 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text)">
          </div>
          <button class="primary" id="keyCreate">＋ 新建 Key</button>
        </div>
        <div id="keyList"></div>
      </div>

      <!-- 运行时信息 -->
      <div class="sec">
        <h4>运行信息</h4>
        <div id="setRuntime" class="hint"></div>
      </div>

    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let CUR = "";              // 当前目录相对路径
let ITEMS = [];            // 当前目录内容
const MAX_UPLOAD = {{ max_file_size }};

/* ---------- 工具 ---------- */
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(t._tid);
  t._tid = setTimeout(() => { t.className = ""; }, 2600);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function iconOf(item) {
  if (item.is_dir) return "📁";
  const n = item.name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(n)) return "🖼️";
  if (/\.(mp4|mov|avi|mkv|webm)$/.test(n)) return "🎬";
  if (/\.(mp3|wav|flac|aac|ogg|m4a)$/.test(n)) return "🎵";
  if (/\.(zip|rar|7z|tar|gz|bz2|xz)$/.test(n)) return "🗜️";
  if (/\.(pdf)$/.test(n)) return "📕";
  if (/\.(docx?|rtf)$/.test(n)) return "📘";
  if (/\.(xlsx?|csv)$/.test(n)) return "📗";
  if (/\.(pptx?)$/.test(n)) return "📙";
  if (/\.(txt|md|log|json|xml|yml|yaml)$/.test(n)) return "📄";
  if (/\.(py|js|ts|java|c|cpp|go|rs|sh|html|css)$/.test(n)) return "⌨️";
  if (/\.(exe|msi|dmg|apk)$/.test(n)) return "⚙️";
  return "📄";
}

/* ---------- 渲染 ---------- */
function renderCrumbs(crumbs) {
  let h = `<a data-path="">🏠 根目录</a>`;
  crumbs.forEach(c => {
    h += ` <span class="sep">/</span> <a data-path="${esc(c.path)}">${esc(c.name)}</a>`;
  });
  // 最后一个面包屑作为当前目录（不可点）
  if (crumbs.length) {
    const last = crumbs[crumbs.length - 1];
    h = h.replace(
      `<a data-path="${esc(last.path)}">${esc(last.name)}</a>`,
      `<span class="cur">${esc(last.name)}</span>`
    );
  }
  $("crumbs").innerHTML = h;
  $("crumbs").querySelectorAll("a").forEach(a => {
    a.onclick = () => load(a.dataset.path);
  });
}

function renderList(items) {
  if (!items.length) {
    $("list").innerHTML = `<div class="empty"><div class="big">📂</div>这里还是空的，上传点东西吧</div>`;
    return;
  }
  const rows = items.map(it => {
    const nmCls = it.is_dir ? "nm dir" : "nm";
    const dl = it.is_dir
      ? ""
      : `<button data-act="download" data-path="${esc(it.path)}">下载</button>`;
    const open = it.is_dir
      ? `<button data-act="open" data-path="${esc(it.path)}">打开</button>`
      : "";
    return `<div class="row">
      <div class="ico">${iconOf(it)}</div>
      <div class="${nmCls}" data-act="${it.is_dir ? 'open' : 'download'}" data-path="${esc(it.path)}" title="${esc(it.name)}">${esc(it.name)}</div>
      <div class="sz">${it.is_dir ? "—" : esc(it.size_h)}</div>
      <div class="tm">${esc(it.mtime_h)}</div>
      <div class="acts">
        ${open}${dl}
        <button data-act="rename" data-path="${esc(it.path)}" data-name="${esc(it.name)}">重命名</button>
        <button class="danger" data-act="delete" data-path="${esc(it.path)}" data-name="${esc(it.name)}">删除</button>
      </div>
    </div>`;
  }).join("");
  $("list").innerHTML = rows;

  $("list").querySelectorAll("[data-act]").forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      const act = el.dataset.act, p = el.dataset.path;
      if (act === "open") load(p);
      else if (act === "download") download(p);
      else if (act === "rename") askRename(p, el.dataset.name);
      else if (act === "delete") askDelete(p, el.dataset.name);
    };
  });
}

/* ---------- 数据加载 ---------- */
async function load(path) {
  try {
    const r = await fetch(`api/list?path=${encodeURIComponent(path || "")}`);
    const d = await r.json();
    if (!d.ok) { toast(d.error || "加载失败", true); return; }
    CUR = d.path;
    ITEMS = d.items;
    // 同步后端的分片配置（保持前后端一致）
    if (d.chunk_size) CHUNK_SIZE = d.chunk_size;
    if (d.chunk_threshold) CHUNK_THRESHOLD = d.chunk_threshold;
    renderCrumbs(d.crumbs);
    renderList(d.items);
    updateDropHint();
  } catch (e) {
    toast("网络错误：" + e.message, true);
  }
  refreshStats();
}

function updateDropHint() {
  $("dropSub").textContent =
    `单文件上限 ${(MAX_UPLOAD / 1024 / 1024 / 1024).toFixed(0)} GB，` +
    `超过 ${Math.round(CHUNK_THRESHOLD / 1024 / 1024)}MB 自动分片上传`;
}

async function refreshStats() {
  try {
    const r = await fetch("api/stats");
    const d = await r.json();
    if (d.ok) $("stats").textContent = `${d.files} 个文件 · 占用 ${d.size_h}`;
  } catch (e) { /* 忽略 */ }
}

function download(path) {
  /* 下载走浏览器原生跳转（便于大文件的流式下载与断点续传），
     因此不经过 fetch 包装；先探一次接口确认会话有效，避免落到 401 白页。 */
  fetch(`api/whoami`)
    .then(r => r.json())
    .then(d => {
      if (!d.authenticated) { handleAuthExpired(); return; }
      window.location.href = `api/download?path=${encodeURIComponent(path)}`;
    })
    .catch(() => { toast("网络错误", true); });
}

/* ---------- 上传 ---------- */
/* ---------- 上传（小文件直传 / 大文件分片 / 多文件并发） ---------- */

/* 分片大小与阈值由后端下发，页面加载时更新 */
let CHUNK_SIZE = 48 * 1024 * 1024;
let CHUNK_THRESHOLD = 48 * 1024 * 1024;

/* 上传并发数（多文件并行；每个文件内部仍是顺序传分片） */
let CONCURRENCY = 3;

/* 上传任务表：id -> {name, size, loaded, status, error} */
let TASKS = new Map();
let TASK_SEQ = 0;
let UPLOADING = false;

function fmtSize(n) {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + " " + u[i];
}

/* 渲染上传进度面板（支持多文件并行展示） */
function renderProgress() {
  const box = $("progress");
  const list = $("pList");
  if (!TASKS.size) { box.style.display = "none"; return; }
  box.style.display = "block";

  let total = 0, loaded = 0, done = 0, failed = 0;
  const rows = [];
  TASKS.forEach((t) => {
    total += t.size; loaded += t.loaded;
    if (t.status === "done") done++;
    if (t.status === "error") failed++;
    const pct = t.size > 0 ? Math.min(100, Math.round(t.loaded / t.size * 100)) : 0;
    let st, cls = "";
    if (t.status === "done") { st = "✅ 完成"; cls = "ok"; }
    else if (t.status === "error") { st = "❌ " + (t.error || "失败"); cls = "err"; }
    else if (t.status === "pending") st = "⏳ 排队中";
    else st = pct + "%";
    rows.push(`<div class="prow ${cls}">
      <div class="pnm" title="${esc(t.name)}">${esc(t.name)}</div>
      <div class="pinfo">${fmtSize(t.loaded)} / ${fmtSize(t.size)}</div>
      <div class="pstat">${esc(String(st))}</div>
    </div>`);
  });

  list.innerHTML = rows.join("");
  const pct = total > 0 ? Math.min(100, Math.round(loaded / total * 100)) : 0;
  $("pBar").style.width = pct + "%";
  $("pPct").textContent = pct + "%";
  const running = [...TASKS.values()].filter(t => t.status === "uploading").length;
  $("pLabel").textContent =
    `上传中 ${running} 个 · 并发 ${CONCURRENCY} · 完成 ${done}/${TASKS.size}` +
    (failed ? ` · 失败 ${failed}` : "");
}

function hideProgress() {
  $("progress").style.display = "none";
  TASKS.clear();
  renderProgress();
}

/* 带进度的 XHR 封装：返回 Promise，resolve 为响应文本 */
function xhrSend(method, url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.ontimeout = () => reject(new Error("请求超时"));
    xhr.send(formData);
  });
}

/* 小文件：一次性直传 */
async function uploadDirect(file, path, task) {
  const fd = new FormData();
  fd.append("path", path);
  fd.append("files", file);
  const r = await xhrSend("POST", "api/upload", fd, (loaded) => {
    task.loaded = loaded;
    renderProgress();
  });
  let d;
  try { d = JSON.parse(r.text); } catch (e) { throw new Error("响应异常"); }
  if (r.status === 413) throw new Error("文件被网关拒绝（超过单次请求上限）");
  if (r.status === 401) { handleAuthExpired(); throw new Error("登录已过期"); }
  if (!d.ok) throw new Error(d.error || "上传失败");
  return d;
}

/* 大文件：分片上传
 *
 * 流程：init 建会话 -> 逐片上传 -> complete 合并
 * 每片重试 3 次；失败则 abort 清理会话。
 * 注意：单个文件内部始终顺序传分片，并发发生在「文件之间」。
 */
async function uploadChunked(file, path, task) {
  // 1) 初始化会话
  const initResp = await fetch("api/upload/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: path,
      name: file.name,
      size: file.size,
      chunk_size: CHUNK_SIZE
    })
  });
  const init = await initResp.json();
  if (!init.ok) throw new Error(init.error || "初始化上传失败");

  const uploadId = init.upload_id;
  const chunkSize = init.chunk_size;
  const totalChunks = init.total_chunks;

  // 2) 逐片上传
  let uploadedBytes = 0;
  try {
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, file.size);
      const blob = file.slice(start, end);

      let ok = false, lastErr = null;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const fd = new FormData();
          fd.append("upload_id", uploadId);
          fd.append("index", i);
          fd.append("chunk", blob, "chunk");

          const r = await xhrSend("POST", "api/upload/chunk", fd, (loaded) => {
            task.loaded = Math.min(uploadedBytes + loaded, file.size);
            renderProgress();
          });
          let d = null;
          try { d = JSON.parse(r.text); } catch (e) { /* 保持 d 为 null */ }
          if (r.status === 401) { handleAuthExpired(); throw new Error("登录已过期"); }
          if (r.status === 200 && d && d.ok) { ok = true; }
          else { lastErr = new Error((d && d.error) || `HTTP ${r.status}`); }
        } catch (e) {
          lastErr = e;
        }
        if (!ok && attempt < 3) {
          await new Promise(res => setTimeout(res, 1000 * attempt));
        }
      }
      if (!ok) throw lastErr || new Error(`第 ${i + 1} 片上传失败`);

      uploadedBytes = end;
      task.loaded = uploadedBytes;
      renderProgress();
    }

    // 3) 合并
    const doneResp = await fetch("api/upload/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ upload_id: uploadId })
    });
    const done = await doneResp.json();
    if (!done.ok) throw new Error(done.error || "合并失败");
    task.loaded = file.size;
    return done;

  } catch (err) {
    // 失败时清理服务端临时分片，避免占空间
    try {
      await fetch("api/upload/abort", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: uploadId })
      });
    } catch (e) { /* 忽略清理失败 */ }
    throw err;
  }
}

/* 并发上传调度器
 *
 * - 同时最多 CONCURRENCY 个文件在传（每个文件内部顺序传分片）
 * - 单个文件失败不影响其他文件（错误隔离）
 * - 全部结束后统一刷新列表
 */
async function uploadFiles(files) {
  files = Array.from(files || []);
  if (!files.length) return;

  if (UPLOADING) { toast("已有上传任务在进行，请稍候", true); return; }

  // 前端预检大小
  const tooBig = files.filter(f => f.size > MAX_UPLOAD);
  if (tooBig.length) {
    toast(`以下文件超过大小上限，已跳过：${tooBig.map(f => f.name).join("、")}`, true);
    files = files.filter(f => f.size <= MAX_UPLOAD);
    if (!files.length) return;
  }

  // 建任务表
  TASKS.clear();
  files.forEach((f) => {
    TASKS.set(++TASK_SEQ, { name: f.name, size: f.size, loaded: 0, status: "pending", error: null });
  });
  const queue = files.map((f, i) => ({ file: f, task: [...TASKS.values()][i] }));
  UPLOADING = true;
  renderProgress();

  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const { file, task } = item;
      task.status = "uploading";
      renderProgress();
      try {
        if (file.size > CHUNK_THRESHOLD) await uploadChunked(file, CUR, task);
        else await uploadDirect(file, CUR, task);
        task.status = "done";
        task.loaded = file.size;
      } catch (e) {
        task.status = "error";
        task.error = e.message;
        console.error("上传失败:", file.name, e);
      }
      renderProgress();
    }
  }

  const n = Math.max(1, Math.min(CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: n }, () => worker()));

  UPLOADING = false;
  const vals = [...TASKS.values()];
  const okCount = vals.filter(t => t.status === "done").length;
  const failCount = vals.filter(t => t.status === "error").length;

  if (failCount === 0) {
    toast(`上传成功 ${okCount} 个文件`);
    setTimeout(hideProgress, 900);
  } else {
    toast(`成功 ${okCount} 个，失败 ${failCount} 个`, true);
    // 保留面板让用户能看到是哪些失败了
  }
  load(CUR);
}

/* ---------- 弹窗 ---------- */
function askInput(title, placeholder, defaultValue, onOk) {
  $("miTitle").textContent = title;
  $("miInput").placeholder = placeholder;
  $("miInput").value = defaultValue || "";
  $("modalInput").classList.add("show");
  setTimeout(() => $("miInput").focus(), 50);

  const close = () => $("modalInput").classList.remove("show");
  $("miCancel").onclick = close;
  $("miOk").onclick = () => {
    const v = $("miInput").value.trim();
    if (!v) { toast("请输入名称", true); return; }
    close();
    onOk(v);
  };
  $("miInput").onkeydown = (e) => { if (e.key === "Enter") $("miOk").click(); };
}

function askConfirm(title, msg, onOk) {
  $("mcTitle").textContent = title;
  $("mcMsg").innerHTML = msg;
  $("modalConfirm").classList.add("show");

  const close = () => $("modalConfirm").classList.remove("show");
  $("mcCancel").onclick = close;
  $("mcOk").onclick = () => { close(); onOk(); };
}

function askRename(path, name) {
  askInput("重命名", "新名称", name, async (v) => {
    if (v === name) return;
    const r = await fetch("api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, new_name: v })
    });
    const d = await r.json();
    if (d.ok) { toast("已重命名"); load(CUR); }
    else toast(d.error || "重命名失败", true);
  });
}

function askDelete(path, name) {
  askConfirm("确认删除", `确定要删除 <b>${esc(name)}</b> 吗？<br>文件夹内的所有内容都会一并删除，此操作不可恢复。`, async () => {
    const r = await fetch("api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path] })
    });
    const d = await r.json();
    if (d.ok) { toast("已删除"); load(CUR); }
    else toast((d.results && d.results[0] && d.results[0].error) || "删除失败", true);
  });
}

/* ---------- 设置面板 ---------- */

function openSettings() {
  $("sheetSettings").classList.add("show");
  $("keyNewBox").innerHTML = "";
  loadSettings();
  loadKeys();
}

function closeSettings() {
  $("sheetSettings").classList.remove("show");
  /* 关闭时清掉一次性 Key 展示（防止别人凑近看到屏幕） */
  $("keyNewBox").innerHTML = "";
}

async function loadSettings() {
  try {
    const r = await fetch("api/settings");
    const d = await r.json();
    if (!d.ok) return;
    const s = d.settings;
    $("setConc").value = s.upload_concurrency;
    $("setDanger").checked = !!s.allow_dangerous;
    $("setTtl").value = s.api_key_ttl_days;
    /* 同步给上传调度器 */
    CONCURRENCY = s.upload_concurrency;

    const rt = d.runtime;
    const modeMap = { session: "网页会话", apikey: "API Key", none: "未鉴权" };
    $("setRuntime").innerHTML = [
      `鉴权方式：<b>${esc(modeMap[rt.auth_mode] || rt.auth_mode)}</b>`,
      `分片大小：${esc(rt.chunk_size_h)}`,
      `分片阈值：超过 ${esc(rt.chunk_size_h)} 的文件自动分片`,
      `单文件上限：${esc(rt.max_file_size_h)}`,
      `登录有效期：${esc(rt.session_ttl_h)}`,
      `访问密钥来源：${esc(rt.key_source)}`,
    ].map(x => `<div style="padding:2px 0">· ${x}</div>`).join("");
  } catch (e) {
    toast("读取设置失败：" + e.message, true);
  }
}

async function patchSetting(body, okMsg) {
  try {
    const r = await fetch("api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || "保存失败", true); return false; }
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast("保存失败：" + e.message, true);
    return false;
  }
}

async function loadKeys() {
  try {
    const r = await fetch("api/apikeys");
    const d = await r.json();
    if (!d.ok) { toast(d.error || "读取 Key 失败", true); return; }
    renderKeys(d.items);
  } catch (e) {
    toast("读取 Key 失败：" + e.message, true);
  }
}

function renderKeys(items) {
  if (!items.length) {
    $("keyList").innerHTML = `<div class="empty-sm">还没有任何 API Key。新建一个就能用程序调用接口了。</div>`;
    return;
  }
  $("keyList").innerHTML = items.map(k => {
    let pill = `<span class="pill">启用中</span>`;
    if (k.expired) pill = `<span class="pill dead">已过期</span>`;
    else if (!k.enabled) pill = `<span class="pill off">已停用</span>`;
    return `<div class="krow ${k.enabled && !k.expired ? "" : "off"}">
      <div class="km">
        <div class="kn">${esc(k.name)}${pill}</div>
        <div class="kd">
          <code>${esc(k.prefix)}…</code> ·
          创建 ${esc(k.created_h)} ·
          过期 ${esc(k.expires_h)} ·
          用过 ${k.use_count} 次 · 最近 ${esc(k.last_used_h)}
        </div>
      </div>
      <div class="kacts">
        <button data-k="${esc(k.id)}" data-a="toggle">${k.enabled ? "停用" : "启用"}</button>
        <button data-k="${esc(k.id)}" data-a="rename">改名</button>
        <button class="danger" data-k="${esc(k.id)}" data-a="del" data-n="${esc(k.name)}">删除</button>
      </div>
    </div>`;
  }).join("");

  $("keyList").querySelectorAll("[data-k]").forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.k, a = btn.dataset.a;
      if (a === "toggle") keyToggle(id, btn.textContent.trim() === "停用");
      else if (a === "rename") keyRename(id);
      else if (a === "del") keyDelete(id, btn.dataset.n);
    };
  });
}

async function keyCreate() {
  const name = $("keyName").value.trim();
  try {
    const r = await fetch("api/apikeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || "创建失败", true); return; }
    $("keyName").value = "";
    /* 一次性展示明文 */
    $("keyNewBox").innerHTML = `<div class="keybox">
      <div class="kw">⚠️ 这个 Key 只会显示这一次，请立即复制保存。关闭后无法再查看。</div>
      <div class="kv" id="newKeyVal">${esc(d.key)}</div>
      <div class="btns" style="display:flex;gap:8px">
        <button class="primary" id="newKeyCopy">复制 Key</button>
      </div>
    </div>`;
    $("newKeyCopy").onclick = async () => {
      const v = $("newKeyVal").textContent;
      try {
        await navigator.clipboard.writeText(v);
        toast("已复制到剪贴板");
      } catch (e) {
        /* 非 HTTPS 或权限受限时降级为选中 */
        const rng = document.createRange();
        rng.selectNodeContents($("newKeyVal"));
        const sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(rng);
        toast("已选中，请手动复制");
      }
    };
    toast("已创建 API Key");
    loadKeys();
  } catch (e) {
    toast("创建失败：" + e.message, true);
  }
}

async function keyToggle(id, disable) {
  try {
    const r = await fetch(`api/apikeys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !disable })
    });
    const d = await r.json();
    if (!d.ok) { toast(d.error || "操作失败", true); return; }
    toast(disable ? "已停用" : "已启用");
    loadKeys();
  } catch (e) {
    toast("操作失败：" + e.message, true);
  }
}

function keyRename(id) {
  askInput("重命名 API Key", "新名称", "", async (v) => {
    try {
      const r = await fetch(`api/apikeys/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v })
      });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "改名失败", true); return; }
      toast("已改名");
      loadKeys();
      $("sheetSettings").classList.add("show");   /* askInput 关闭后要把设置面板恢复 */
    } catch (e) {
      toast("改名失败：" + e.message, true);
    }
  });
  $("sheetSettings").classList.remove("show");
}

function keyDelete(id, name) {
  $("sheetSettings").classList.remove("show");
  askConfirm("删除 API Key",
    `确定要删除 <b>${esc(name)}</b> 吗？<br>删除后用它调用的程序会立即失效，此操作不可恢复。`,
    async () => {
      try {
        const r = await fetch(`api/apikeys/${encodeURIComponent(id)}`, { method: "DELETE" });
        const d = await r.json();
        if (!d.ok) { toast(d.error || "删除失败", true); return; }
        toast("已删除");
        loadKeys();
      } catch (e) {
        toast("删除失败：" + e.message, true);
      }
    });
}

/* ---------- 事件绑定 ---------- */
$("drop").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => {
  uploadFiles(e.target.files);
  e.target.value = "";
};

["dragenter", "dragover"].forEach(ev =>
  $("drop").addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    $("drop").classList.add("over");
  })
);
["dragleave", "drop"].forEach(ev =>
  $("drop").addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    $("drop").classList.remove("over");
  })
);
$("drop").addEventListener("drop", (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) uploadFiles(files);
});

// 页面级拖拽兜底
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("btnMkdir").onclick = () => {
  askInput("新建文件夹", "文件夹名称", "", async (v) => {
    const r = await fetch("api/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: CUR, name: v })
    });
    const d = await r.json();
    if (d.ok) { toast("已创建"); load(CUR); }
    else toast(d.error || "创建失败", true);
  });
};

$("btnRefresh").onclick = () => { load(CUR); toast("已刷新"); };

/* ---------- 设置面板事件 ---------- */
$("btnSettings").onclick = openSettings;
$("setClose").onclick = closeSettings;

/* 点击遮罩关闭 */
$("sheetSettings").onclick = (e) => {
  if (e.target === $("sheetSettings")) closeSettings();
};

$("setConcSave").onclick = async () => {
  const v = parseInt($("setConc").value, 10);
  if (!(v >= 1 && v <= 10)) { toast("并发数需在 1~10 之间", true); return; }
  if (await patchSetting({ upload_concurrency: v }, `并发数已设为 ${v}`)) {
    CONCURRENCY = v;
    loadSettings();
  }
};

$("setDanger").onchange = async (e) => {
  const on = e.target.checked;
  if (await patchSetting({ allow_dangerous: on },
      on ? "API Key 现可执行危险操作" : "已禁止 API Key 执行危险操作")) {
    loadSettings();
  } else {
    e.target.checked = !on;   /* 失败回滚 */
  }
};

$("setTtlSave").onclick = async () => {
  const v = parseInt($("setTtl").value, 10);
  if (!(v >= 0 && v <= 3650)) { toast("有效期需在 0~3650 之间", true); return; }
  if (await patchSetting({ api_key_ttl_days: v },
      v === 0 ? "新 Key 默认永不过期" : `新 Key 默认有效期 ${v} 天`)) {
    loadSettings();
  }
};

$("keyCreate").onclick = keyCreate;
$("keyName").onkeydown = (e) => { if (e.key === "Enter") keyCreate(); };

/* ---------- 登出 ---------- */
$("btnLogout").onclick = () => {
  askConfirm("退出登录", "确定要退出吗？下次访问需要重新输入密钥。", async () => {
    try {
      await fetch("api/logout", { method: "POST" });
    } catch (e) { /* 忽略 */ }
    location.href = "/login";
  });
};

/* ---------- 鉴权失效统一处理 ---------- */
/* 任何接口返回 401 都视为会话过期，直接跳登录页 */
function handleAuthExpired() {
  if (handleAuthExpired._busy) return;
  handleAuthExpired._busy = true;
  toast("登录已过期，正在跳转…", true);
  setTimeout(() => { location.href = "/login"; }, 800);
}

/* 包装 fetch：自动识别 401 */
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const resp = await _origFetch(...args);
  if (resp.status === 401) {
    handleAuthExpired();
  }
  return resp;
};

/* ---------- 启动 ---------- */
updateDropHint();
load("");
</script>
</body>
</html>
"""


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    # 绑定 0.0.0.0 以便被反向代理访问
    app.run(host="0.0.0.0", port=port, threaded=True)
