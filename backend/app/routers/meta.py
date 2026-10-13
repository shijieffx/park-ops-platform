"""元数据：菜单树、角色、数据字典、派单人员、操作日志"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends, Request

from ..deps import count, current_user, get_db, require_perms, rows_to_dicts, write_log
from ..errors import ApiError, success
from ..utils import now_text

router = APIRouter(prefix="/api/meta", tags=["元数据"])

# 权限依赖在模块顶部实例化：装饰器在函数定义时就会求值，必须先有名字
require_role = require_perms("system:role")
require_log = require_perms("system:log")

# 非管理员不可见的系统管理类权限点
SYSTEM_PERMS = ["system:view", "system:user", "system:role", "system:dict", "system:log"]


@router.get("/menus", summary="菜单树（按角色过滤）")
def menus(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    rows = rows_to_dicts(conn.execute("SELECT * FROM menus ORDER BY sort ASC, id ASC").fetchall())
    hidden = [] if user.get("role_code") == "admin" else SYSTEM_PERMS
    visible = [m for m in rows if m.get("perm") not in hidden]

    tree = []
    for menu in visible:
        if menu["parent_id"] != 0:
            continue
        item = dict(menu)
        item["children"] = [c for c in visible if c["parent_id"] == menu["id"]]
        tree.append(item)
    return success(tree)


@router.get("/roles", summary="角色列表")
def roles(
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    rows = conn.execute(
        "SELECT id, name, code, data_scope, remark FROM roles ORDER BY id"
    ).fetchall()
    return success(rows_to_dicts(rows))


@router.post("/roles", summary="新增 / 编辑角色", dependencies=[Depends(require_role)])
def save_role(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    name, code = d.get("name"), d.get("code")
    if not name or not code:
        raise ApiError(400, "角色名称与编码必填")

    if d.get("id"):
        conn.execute(
            "UPDATE roles SET name=?, code=?, data_scope=?, remark=? WHERE id=?",
            [name, code, d.get("dataScope") or "ALL", d.get("remark") or "", d["id"]],
        )
    else:
        exists = conn.execute("SELECT id FROM roles WHERE code = ?", [code]).fetchone()
        if exists:
            raise ApiError(400, "角色编码已存在")
        conn.execute(
            "INSERT INTO roles (name, code, data_scope, remark, created_at) VALUES (?,?,?,?,?)",
            [name, code, d.get("dataScope") or "ALL", d.get("remark") or "", now_text()],
        )

    write_log(conn, user["username"], "角色维护", f"{'编辑' if d.get('id') else '新增'}角色 {name}")
    return success(message="保存成功")


@router.delete("/roles/{role_id}", summary="删除角色", dependencies=[Depends(require_role)])
def delete_role(
    role_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    used = count(
        conn,
        "SELECT COUNT(*) FROM users WHERE role_code = (SELECT code FROM roles WHERE id = ?)",
        [role_id],
    )
    if used > 0:
        raise ApiError(400, "该角色下仍有用户，不能删除")
    conn.execute("DELETE FROM roles WHERE id = ?", [role_id])
    write_log(conn, user["username"], "角色维护", f"删除角色 #{role_id}")
    return success(message="删除成功")


@router.get("/dicts", summary="数据字典")
def dicts(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    dict_type = request.query_params.get("type")
    if dict_type:
        rows = conn.execute(
            "SELECT * FROM dicts WHERE type = ? ORDER BY sort, id", [dict_type]
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM dicts ORDER BY type, sort, id").fetchall()
    return success(rows_to_dicts(rows))


@router.get("/staff", summary="可派单人员（按姓名去重）")
def staff(
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    rows = conn.execute(
        """
        SELECT real_name AS realName, role_code AS roleCode
        FROM users WHERE status = 1 AND real_name != ''
        GROUP BY real_name
        ORDER BY CASE role_code WHEN 'manager' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, real_name
        """
    ).fetchall()
    return success(rows_to_dicts(rows))


@router.get("/logs", summary="操作日志", dependencies=[Depends(require_log)])
def logs(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    query = request.query_params
    keyword = str(query.get("keyword") or "").strip()[:50]
    username = query.get("username") or ""

    where, params = ["1=1"], []
    if keyword:
        where.append("(action LIKE ? OR detail LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%"]
    if username:
        where.append("username = ?")
        params.append(username)
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM logs WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT * FROM logs WHERE {cond} ORDER BY id DESC LIMIT 300", params
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total})
