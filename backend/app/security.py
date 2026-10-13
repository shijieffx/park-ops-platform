"""
鉴权基础设施：密码哈希、JWT 签发与解析。

与 Node 版的互通性（这是「两套后端共用一份数据」的前提）：
* 密码哈希统一用 bcrypt（``$2a$``/``$2b$``），bcryptjs 与 bcrypt 库可以互相校验；
* JWT 同为 HS256，payload 字段名一致（``id`` / ``username`` / ``role_code`` / ``real_name`` / ``region``），
  因此一边签发的 token 另一边也能验签通过。
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

import bcrypt
import jwt

from .config import API_DEBUG, JWT_SECRET, TOKEN_TTL_HOURS

# JWT 的外形特征：三段 base64url，用点分隔
JWT_SHAPE = re.compile(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    if not password or not hashed:
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def sign_token(user: Mapping[str, Any]) -> str:
    """
    签发访问令牌。region 必须写进 payload —— 数据范围过滤依赖它。

    入参可以是 dict，也可以是 sqlite3.Row（后者没有 ``get``），统一按字段名取值。
    """
    def field(key: str) -> Any:
        try:
            return user[key]
        except (KeyError, IndexError):
            return None

    now = datetime.now(timezone.utc)
    payload = {
        "id": field("id"),
        "username": field("username"),
        "role_code": field("role_code"),
        "real_name": field("real_name"),
        "region": field("region"),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=TOKEN_TTL_HOURS)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def verify_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])


def resolve_token(raw_header: str | None) -> tuple[dict | None, str | None, Exception | None, int]:
    """
    从请求头中取出本服务可用的 token。

    标准写法是 ``Bearer <token>``，但某些部署环境会把**自己的凭证**追加到同一个头里
    （实测线上收到的头比客户端发出的多 126 个字符），此时简单地按空格切分会拿到
    拼接后的脏数据，验签必然失败。因此这里改为：扫描头中所有形似 JWT 的片段，
    逐个用本服务的密钥验签，取第一个通过的 —— 头里只有本服务的 token 时行为完全一致。

    返回 ``(payload, token, error, candidates)``。
    """
    raw = str(raw_header or "")
    candidates = JWT_SHAPE.findall(raw)

    if not candidates:
        fallback = raw[7:].strip() if raw.startswith("Bearer ") else raw.strip()
        if fallback:
            candidates = [fallback]

    last_error: Exception | None = None
    for candidate in candidates:
        try:
            return verify_token(candidate), candidate, None, len(candidates)
        except Exception as exc:  # noqa: BLE001 —— 逐个候选尝试，失败原因只用于排查
            last_error = exc

    return None, None, last_error, len(candidates)


def auth_debug_enabled() -> bool:
    return API_DEBUG
