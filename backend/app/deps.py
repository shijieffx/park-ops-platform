"""
依赖注入层：数据库连接、当前登录人、权限校验、数据范围过滤。

这一层是「接口层」与「基础设施层」之间的桥：
路由只声明自己需要什么（``user`` / ``conn`` / 权限点），
鉴权与数据权限的实现细节全部收敛在这里，避免每个接口重复写过滤条件。
"""

from __future__ import annotations

import sqlite3
from typing import Any, Callable, Iterator, Mapping, Sequence

from fastapi import Depends, Request

from .config import API_DEBUG
from .db import connect
from .errors import ApiError
from .permissions import perms_of, scope_of
from .security import resolve_token
from .utils import now_text


def get_db() -> Iterator[sqlite3.Connection]:
    """按请求提供数据库连接（SQLite 连接很轻，用完即关，配合 WAL 并发读）"""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def current_user(request: Request) -> dict[str, Any]:
    """
    解析并校验访问令牌 → 当前登录人。

    优先读取自定义头 ``X-Auth-Token``：实测某些部署环境会替换 ``Authorization``
    （客户端发出的 253 字符令牌，服务端实际收到的是另一串内容），
    自定义头不经过那层处理，可稳定送达；``Authorization`` 作为兼容回退保留。
    """
    custom = request.headers.get("x-auth-token")
    source = f"Bearer {custom}" if custom else request.headers.get("authorization")

    payload, token, error, candidates = resolve_token(source)

    if token is None and not candidates:
        raise ApiError(401, "未登录")
    if token is None:
        # 默认只回统一提示，不外泄内部错误；API_DEBUG=1 启动时把原因写进日志
        if API_DEBUG:
            print(f"[auth] token 校验失败：{error}")
        raise ApiError(401, "登录已过期，请重新登录")

    user = dict(payload)
    user["perms"] = perms_of(user.get("role_code", ""))
    user["scope"] = scope_of(user.get("role_code", ""))
    return user


def require_perms(*need: str) -> Callable[..., dict[str, Any]]:
    """权限点校验：``dependencies=[Depends(require_perms('device:edit'))]``"""

    def _dep(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
        if not all(p in user["perms"] for p in need):
            raise ApiError(403, "当前角色无此操作权限")
        return user

    return _dep


# ---------------------------------------------------------------- 数据范围

def scope_filter(table: str, user: Mapping[str, Any]) -> tuple[str, list[Any]]:
    """
    按角色生成数据过滤条件 → ``(sql, params)``。

    过滤发生在 SQL 层而不是取回后再筛，因此分页总数与列表数据天然一致。
    """
    scope = user.get("scope")

    if scope == "ALL":
        return "1=1", []

    if scope == "REGION":
        region = user.get("region")
        return ("region = ?", [region]) if region else ("1=1", [])

    # SELF：工单看处理人，设备看负责人，巡检看巡检人，告警看本区域
    real_name = user.get("real_name")
    if table == "work_orders":
        return "handler = ?", [real_name]
    if table == "devices":
        return "owner = ?", [real_name]
    if table == "inspection_tasks":
        return "inspector = ?", [real_name]
    if table == "alarms":
        region = user.get("region")
        return ("region = ?", [region]) if region else ("1=1", [])
    return "1=1", []


def find_visible(
    conn: sqlite3.Connection,
    table: str,
    row_id: Any,
    user: Mapping[str, Any],
    fields: str = "*",
) -> sqlite3.Row | None:
    """
    在「当前用户数据权限范围内」取单条记录。

    越权访问与记录不存在返回同一结果（None），由调用方统一回 404，
    避免通过状态码差异探测出资源是否存在。
    """
    sql, params = scope_filter(table, user)
    return conn.execute(
        f"SELECT {fields} FROM {table} WHERE id = ? AND {sql}", [row_id, *params]
    ).fetchone()


# ---------------------------------------------------------------- 通用小工具

def rows_to_dicts(rows: Sequence[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in rows]


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def scalar(conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()) -> Any:
    row = conn.execute(sql, list(params)).fetchone()
    return None if row is None else row[0]


def count(conn: sqlite3.Connection, sql: str, params: Sequence[Any] = ()) -> int:
    """取 COUNT(*) 结果，空结果按 0 处理"""
    row = conn.execute(sql, list(params)).fetchone()
    if row is None or row[0] is None:
        return 0
    return int(row[0])


def write_log(conn: sqlite3.Connection, username: str, action: str, detail: str) -> None:
    """记录操作日志（失败不影响主流程）"""
    try:
        conn.execute(
            "INSERT INTO logs (username, action, detail, created_at) VALUES (?,?,?,?)",
            (username, action, detail, now_text()),
        )
    except sqlite3.Error:
        pass
