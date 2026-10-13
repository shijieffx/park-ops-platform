"""认证：登录与当前登录人信息"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends

from ..deps import current_user, get_db, write_log
from ..errors import ApiError, success
from ..permissions import perms_of
from ..security import sign_token, verify_password

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/login", summary="登录")
def login(
    conn: sqlite3.Connection = Depends(get_db),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    username = d.get("username")
    password = d.get("password")
    if not username or not password:
        raise ApiError(400, "请输入账号与密码")

    user = conn.execute("SELECT * FROM users WHERE username = ?", [username]).fetchone()
    if user is None:
        raise ApiError(401, "账号不存在")
    if not verify_password(str(password), user["password"]):
        raise ApiError(401, "密码错误")
    if not user["status"]:
        raise ApiError(403, "账号已停用")

    write_log(conn, user["username"], "登录", f"{user['real_name']} 登录系统")
    return success({
        "token": sign_token(user),
        "user": {
            "id": user["id"],
            "username": user["username"],
            "realName": user["real_name"],
            "roleCode": user["role_code"],
            "region": user["region"],
            "perms": perms_of(user["role_code"]),
        },
    })


@router.get("/profile", summary="当前登录人信息")
def profile(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    row = conn.execute(
        "SELECT id, username, real_name, phone, role_code, region, status FROM users WHERE id = ?",
        [user["id"]],
    ).fetchone()
    if row is None:
        raise ApiError(401, "账号不存在")
    return success({
        "id": row["id"],
        "username": row["username"],
        "realName": row["real_name"],
        "phone": row["phone"],
        "roleCode": row["role_code"],
        "region": row["region"],
        "perms": perms_of(row["role_code"]),
    })
