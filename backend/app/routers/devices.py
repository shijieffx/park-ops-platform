"""设备台账：CRUD、分布统计、保养到期"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends, Request

from ..deps import (
    count,
    current_user,
    find_visible,
    get_db,
    require_perms,
    row_to_dict,
    rows_to_dicts,
    scope_filter,
    write_log,
)
from ..errors import ApiError, success
from ..utils import date_offset_text, now_text, parse_paging, to_int, to_keyword

router = APIRouter(prefix="/api/devices", tags=["设备台账"])

require_edit = require_perms("device:edit")

FIELDS = (
    "id, code, name, category, region, status, vendor, install_date, owner, remark,"
    " maintain_cycle, next_maintain_date"
)


@router.get("", summary="设备列表（组合筛选 + 分页）")
def list_devices(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    query = request.query_params
    keyword = to_keyword(query.get("keyword"))
    category = str(query.get("category") or "")
    region = str(query.get("region") or "")
    status = str(query.get("status") or "")
    page, page_size, offset = parse_paging(query)

    sc_sql, params = scope_filter("devices", user)
    where = [sc_sql]
    if keyword:
        where.append("(code LIKE ? OR name LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%"]
    if category:
        where.append("category = ?")
        params.append(category)
    if region:
        where.append("region = ?")
        params.append(region)
    if status:
        where.append("status = ?")
        params.append(status)
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM devices WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT {FIELDS} FROM devices WHERE {cond} ORDER BY id DESC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total, "page": page, "pageSize": page_size})


@router.get("/all", summary="精简全量（导出用，受数据权限约束）")
def all_devices(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("devices", user)
    rows = conn.execute(
        f"SELECT {FIELDS} FROM devices WHERE {sc_sql} ORDER BY id ASC", params
    ).fetchall()
    return success(rows_to_dicts(rows))


@router.get("/stats/maintain", summary="保养到期 / 即将到期设备")
def maintain_stats(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    raw_days = to_int(request.query_params.get("days"), 7)
    # 与 Node 版 `Number(v) || 7` 对齐：传 0 / 非数字都回退到默认 7 天
    days = min(max(raw_days or 7, 1), 365)
    today = date_offset_text(0)
    deadline = date_offset_text(days)
    sc_sql, params = scope_filter("devices", user)

    rows = conn.execute(
        f"""
        SELECT id, code, name, category, region, status, owner, maintain_cycle, next_maintain_date
        FROM devices
        WHERE {sc_sql} AND next_maintain_date != '' AND next_maintain_date IS NOT NULL
              AND next_maintain_date <= ?
        ORDER BY next_maintain_date ASC LIMIT 50
        """,
        [*params, deadline],
    ).fetchall()
    total = count(
        conn,
        f"""
        SELECT COUNT(*) FROM devices
        WHERE {sc_sql} AND next_maintain_date != '' AND next_maintain_date IS NOT NULL
              AND next_maintain_date <= ?
        """,
        [*params, deadline],
    )

    items = [
        {**dict(r), "overdue": (r["next_maintain_date"] or "") < today}
        for r in rows
    ]
    return success({
        "days": days,
        "total": total,
        "overdue": sum(1 for i in items if i["overdue"]),
        "list": items,
    })


@router.get("/stats/summary", summary="区域 / 类型 / 状态分布")
def device_stats(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("devices", user)

    def by(column: str) -> list[dict]:
        return rows_to_dicts(conn.execute(
            f"SELECT {column} AS name, COUNT(*) AS value FROM devices WHERE {sc_sql}"
            f" GROUP BY {column} ORDER BY value DESC",
            params,
        ).fetchall())

    return success({
        "total": count(conn, f"SELECT COUNT(*) FROM devices WHERE {sc_sql}", params),
        "byRegion": by("region"),
        "byCategory": by("category"),
        "byStatus": by("status"),
    })


@router.get("/{device_id}", summary="设备详情（叠加数据范围）")
def device_detail(
    device_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    row = find_visible(conn, "devices", device_id, user, FIELDS)
    if row is None:
        raise ApiError(404, "设备不存在或无权访问")
    return success(dict(row))


@router.post("", summary="新增设备", dependencies=[Depends(require_edit)])
def create_device(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    if not d.get("code") or not d.get("name"):
        raise ApiError(400, "设备编号与名称必填")
    exists = conn.execute("SELECT id FROM devices WHERE code = ?", [d["code"]]).fetchone()
    if exists:
        raise ApiError(400, "设备编号已存在")

    conn.execute(
        "INSERT INTO devices (code, name, category, region, status, vendor, install_date, owner,"
        " remark, maintain_cycle, next_maintain_date, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            d["code"], d["name"], d.get("category") or "未分类", d.get("region") or "",
            d.get("status") or "运行中", d.get("vendor") or "", d.get("installDate") or "",
            d.get("owner") or "", d.get("remark") or "",
            _to_positive_int(d.get("maintainCycle"), 90), d.get("nextMaintainDate") or "",
            now_text(),
        ],
    )
    write_log(conn, user["username"], "设备新增", f"新增设备 {d['code']}")
    return success(message="新增成功")


@router.put("/{device_id}", summary="编辑设备", dependencies=[Depends(require_edit)])
def update_device(
    device_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    exists = find_visible(conn, "devices", device_id, user, "id")
    if exists is None:
        raise ApiError(404, "设备不存在或无权访问")

    d = payload or {}
    if not d.get("name"):
        raise ApiError(400, "设备名称必填")
    conn.execute(
        "UPDATE devices SET name=?, category=?, region=?, status=?, vendor=?, install_date=?,"
        " owner=?, remark=?, maintain_cycle=?, next_maintain_date=? WHERE id=?",
        [
            d.get("name"), d.get("category"), d.get("region"), d.get("status"), d.get("vendor"),
            d.get("installDate"), d.get("owner"), d.get("remark"),
            _to_positive_int(d.get("maintainCycle"), 90), d.get("nextMaintainDate") or "",
            device_id,
        ],
    )
    write_log(conn, user["username"], "设备编辑", f"编辑设备 #{device_id}")
    return success(message="保存成功")


@router.delete("/{device_id}", summary="删除设备", dependencies=[Depends(require_edit)])
def delete_device(
    device_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    exists = find_visible(conn, "devices", device_id, user, "id")
    if exists is None:
        raise ApiError(404, "设备不存在或无权访问")
    conn.execute("DELETE FROM devices WHERE id = ?", [device_id])
    write_log(conn, user["username"], "设备删除", f"删除设备 #{device_id}")
    return success(message="删除成功")


def _to_positive_int(value: object, fallback: int) -> int:
    """与 Node 版的 `Number(v) || fallback` 对齐：0 / 非数字都回退到默认值"""
    try:
        num = int(float(str(value)))
    except (TypeError, ValueError):
        return fallback
    return num or fallback
