"""用户管理"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends, Request

from ..deps import count, current_user, get_db, require_perms, rows_to_dicts, write_log
from ..errors import ApiError, success
from ..security import hash_password
from ..utils import now_text, parse_paging, to_keyword

router = APIRouter(prefix="/api/users", tags=["用户管理"])

require_user_admin = require_perms("system:user")

DEFAULT_PASSWORD = "123456"


@router.get("", summary="用户列表", dependencies=[Depends(require_user_admin)])
def list_users(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    query = request.query_params
    keyword = to_keyword(query.get("keyword"))
    role_code = str(query.get("roleCode") or "")
    page, page_size, offset = parse_paging(query)

    where, params = ["1=1"], []
    if keyword:
        where.append("(username LIKE ? OR real_name LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%"]
    if role_code:
        where.append("role_code = ?")
        params.append(role_code)
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM users WHERE {cond}", params)
    rows = conn.execute(
        "SELECT id, username, real_name, phone, role_code, region, status, created_at"
        f" FROM users WHERE {cond} ORDER BY id ASC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total, "page": page, "pageSize": page_size})


@router.post("", summary="新增 / 编辑用户", dependencies=[Depends(require_user_admin)])
def save_user(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    username, real_name = d.get("username"), d.get("realName")
    if not username or not real_name:
        raise ApiError(400, "账号与姓名必填")

    if d.get("id"):
        conn.execute(
            "UPDATE users SET real_name=?, phone=?, role_code=?, region=?, status=? WHERE id=?",
            [
                real_name, d.get("phone") or "", d.get("roleCode"), d.get("region") or "",
                1 if d.get("status") is None else d.get("status"), d["id"],
            ],
        )
    else:
        exists = conn.execute("SELECT id FROM users WHERE username = ?", [username]).fetchone()
        if exists:
            raise ApiError(400, "账号已存在")
        conn.execute(
            "INSERT INTO users (username, password, real_name, phone, role_code, region, status,"
            " created_at) VALUES (?,?,?,?,?,?,?,?)",
            [
                username, hash_password(str(d.get("password") or DEFAULT_PASSWORD)), real_name,
                d.get("phone") or "", d.get("roleCode") or "operator", d.get("region") or "", 1,
                now_text(),
            ],
        )

    write_log(conn, user["username"], "用户维护", f"{'编辑' if d.get('id') else '新增'}用户 {username}")
    return success(message="保存成功")


@router.put("/{user_id}/reset", summary="重置密码", dependencies=[Depends(require_user_admin)])
def reset_password(
    user_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    conn.execute(
        "UPDATE users SET password = ? WHERE id = ?", [hash_password(DEFAULT_PASSWORD), user_id]
    )
    write_log(conn, user["username"], "用户维护", f"重置用户 #{user_id} 密码")
    return success(message=f"密码已重置为 {DEFAULT_PASSWORD}")


@router.put("/{user_id}/status", summary="启用 / 停用", dependencies=[Depends(require_user_admin)])
def toggle_status(
    user_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    payload: dict | None = Body(default=None),
):
    conn.execute("UPDATE users SET status = ? WHERE id = ?", [1 if (payload or {}).get("status") else 0, user_id])
    return success(message="状态已更新")


@router.delete("/{user_id}", summary="删除用户", dependencies=[Depends(require_user_admin)])
def delete_user(
    user_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    if int(user_id) == int(user["id"]):
        raise ApiError(400, "不能删除当前登录账号")
    conn.execute("DELETE FROM users WHERE id = ?", [user_id])
    write_log(conn, user["username"], "用户维护", f"删除用户 #{user_id}")
    return success(message="删除成功")
