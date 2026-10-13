"""工单中心：状态机流转、派单转派、SLA 时效"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends, Request

from ..db import transaction
from ..deps import (
    count,
    current_user,
    find_visible,
    get_db,
    require_perms,
    rows_to_dicts,
    scope_filter,
    write_log,
)
from ..errors import ApiError, success
from ..utils import calc_deadlines, hours_left, is_overdue, now_text, parse_paging, to_keyword

router = APIRouter(prefix="/api/orders", tags=["工单中心"])

require_edit = require_perms("order:edit")

# 状态机：定义允许的流转
FLOW: dict[str, list[str]] = {
    "PENDING": ["PROCESSING"],
    "PROCESSING": ["CHECKING"],
    "CHECKING": ["CLOSED", "PROCESSING"],
    "CLOSED": [],
}
STATUS_TEXT = {"PENDING": "待受理", "PROCESSING": "处理中", "CHECKING": "待验收", "CLOSED": "已闭环"}

FIELDS = (
    "id, code, title, type, priority, status, device_code, creator, handler, region,"
    " response_deadline, resolve_deadline, responded_at, created_at, updated_at"
)

OVERDUE_COND = "status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?"


@router.get("/stats/sla", summary="SLA 时效统计")
def sla_stats(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("work_orders", user)
    ts = now_text()

    overdue = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {sc_sql} AND {OVERDUE_COND}", [*params, ts]
    )
    response_overdue = count(
        conn,
        f"""SELECT COUNT(*) FROM work_orders
            WHERE {sc_sql} AND responded_at != '' AND response_deadline != ''
                  AND responded_at > response_deadline""",
        params,
    )
    open_total = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {sc_sql} AND status != 'CLOSED'", params
    )
    pending = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {sc_sql} AND status = 'PENDING'", params
    )
    processing = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {sc_sql} AND status = 'PROCESSING'", params
    )
    by_priority = rows_to_dicts(conn.execute(
        f"""SELECT priority AS name, COUNT(*) AS value FROM work_orders
            WHERE {sc_sql} AND {OVERDUE_COND} GROUP BY priority""",
        [*params, ts],
    ).fetchall())

    return success({
        "overdue": overdue,
        "responseOverdue": response_overdue,
        "openTotal": open_total,
        "pending": pending,
        "processing": processing,
        "onTimeRate": round((open_total - overdue) / open_total * 100, 1) if open_total else 100,
        "byPriority": by_priority,
    })


@router.get("/stats/summary", summary="状态分布")
def status_summary(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("work_orders", user)
    rows = conn.execute(
        f"SELECT status, COUNT(*) AS c FROM work_orders WHERE {sc_sql} GROUP BY status", params
    ).fetchall()
    by_status = {r["status"]: r["c"] for r in rows}
    return success([
        {"name": STATUS_TEXT[s], "value": by_status.get(s, 0)} for s in STATUS_TEXT
    ])


@router.get("", summary="工单列表（含实时超时判定，超时置顶）")
def list_orders(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    query = request.query_params
    status = str(query.get("status") or "")
    order_type = str(query.get("type") or "")
    priority = str(query.get("priority") or "")
    only_overdue = str(query.get("overdue") or "")
    keyword = to_keyword(query.get("keyword"))
    page, page_size, offset = parse_paging(query)

    sc_sql, params = scope_filter("work_orders", user)
    where = [sc_sql]
    if status:
        where.append("status = ?")
        params.append(status)
    if order_type:
        where.append("type = ?")
        params.append(order_type)
    if priority:
        where.append("priority = ?")
        params.append(priority)
    if keyword:
        where.append("(code LIKE ? OR title LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%"]

    ts = now_text()
    # 超时筛选口径与看板保持一致：未闭环 且 已过处理时限
    if only_overdue == "1":
        where.append(OVERDUE_COND)
        params.append(ts)

    cond = " AND ".join(where)
    total = count(conn, f"SELECT COUNT(*) FROM work_orders WHERE {cond}", params)
    rows = conn.execute(
        f"""SELECT {FIELDS} FROM work_orders WHERE {cond}
            ORDER BY CASE WHEN {OVERDUE_COND} THEN 0 ELSE 1 END, id DESC
            LIMIT ? OFFSET ?""",
        [*params, ts, page_size, offset],
    ).fetchall()

    # overdue / 剩余时限实时计算：库里的标记会随时间失真
    items = [
        {
            **dict(r),
            "overdue": is_overdue(r["status"], r["resolve_deadline"], ts),
            "hoursLeft": hours_left(r["resolve_deadline"], ts),
        }
        for r in rows
    ]
    return success({"list": items, "total": total, "page": page, "pageSize": page_size})


@router.post("", summary="新建工单", dependencies=[Depends(require_edit)])
def create_order(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    if not d.get("title"):
        raise ApiError(400, "工单标题必填")

    seq = count(conn, "SELECT COUNT(*) FROM work_orders") + 1
    code = f"WO{seq:05d}"
    ts = now_text()
    priority = d.get("priority") or "中"
    response_deadline, resolve_deadline = calc_deadlines(priority, ts)

    with transaction(conn):
        cur = conn.execute(
            "INSERT INTO work_orders (code, title, type, priority, status, device_code, creator,"
            " handler, region, response_deadline, resolve_deadline, responded_at, overdue,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                code, d["title"], d.get("type") or "故障报修", priority, "PENDING",
                d.get("deviceCode") or "", user.get("real_name") or "", "", d.get("region") or "",
                response_deadline, resolve_deadline, "", 0, ts, ts,
            ],
        )
        conn.execute(
            "INSERT INTO wo_timeline (order_id, action, operator, note, created_at)"
            " VALUES (?,?,?,?,?)",
            [cur.lastrowid, "创建工单", user.get("real_name") or "", d.get("remark") or "", ts],
        )

    write_log(conn, user["username"], "工单创建", f"创建工单 {code}")
    return success({"id": cur.lastrowid, "code": code}, message="创建成功")


@router.post("/{order_id}/flow", summary="状态流转", dependencies=[Depends(require_edit)])
def flow_order(
    order_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    target = d.get("to")
    order = find_visible(conn, "work_orders", order_id, user, "*")
    if order is None:
        raise ApiError(404, "工单不存在或无权访问")

    allowed = FLOW.get(order["status"], [])
    if target not in allowed:
        raise ApiError(
            400,
            f"不允许从「{STATUS_TEXT.get(order['status'], order['status'])}」"
            f"流转到「{STATUS_TEXT.get(target, target)}」",
        )

    ts = now_text()
    action_text = {"PROCESSING": "受理派单", "CHECKING": "处理完成", "CLOSED": "验收闭环"}.get(target, "流转")
    # 首次受理即记录响应时间，用于统计响应时效
    responded_at = order["responded_at"] or ts

    with transaction(conn):
        conn.execute(
            "UPDATE work_orders SET status=?, handler=?, responded_at=?, updated_at=? WHERE id=?",
            [
                target, d.get("handler") or order["handler"] or user.get("real_name") or "",
                responded_at, ts, order_id,
            ],
        )
        conn.execute(
            "INSERT INTO wo_timeline (order_id, action, operator, note, created_at)"
            " VALUES (?,?,?,?,?)",
            [order_id, action_text, user.get("real_name") or "", d.get("note") or "", ts],
        )

    write_log(conn, user["username"], "工单流转", f"{order['code']} → {STATUS_TEXT.get(target, target)}")
    return success(message=f"已流转至「{STATUS_TEXT.get(target, target)}」")


@router.post("/{order_id}/assign", summary="派单 / 转派", dependencies=[Depends(require_edit)])
def assign_order(
    order_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    order = find_visible(conn, "work_orders", order_id, user, "*")
    if order is None:
        raise ApiError(404, "工单不存在或无权访问")
    if order["status"] == "CLOSED":
        raise ApiError(400, "已闭环的工单不能派单")

    d = payload or {}
    handler = d.get("handler")
    if not handler:
        raise ApiError(400, "请指定处理人")
    staff = conn.execute(
        "SELECT real_name FROM users WHERE real_name = ? AND status = 1", [handler]
    ).fetchone()
    if staff is None:
        raise ApiError(400, "处理人不存在或账号已停用")

    ts = now_text()
    is_transfer = bool(order["handler"]) and order["handler"] != handler

    with transaction(conn):
        conn.execute(
            "UPDATE work_orders SET handler = ?, responded_at = ?, updated_at = ? WHERE id = ?",
            [handler, order["responded_at"] or ts, ts, order["id"]],
        )
        conn.execute(
            "INSERT INTO wo_timeline (order_id, action, operator, note, created_at)"
            " VALUES (?,?,?,?,?)",
            [
                order["id"], "转派" if is_transfer else "派单", user.get("real_name") or "",
                f"指派给 {handler}" + (f"：{d['note']}" if d.get("note") else ""), ts,
            ],
        )

    write_log(conn, user["username"], "工单派单", f"{order['code']} → {handler}")
    return success(message=f"已{'转派' if is_transfer else '派单'}给 {handler}")


@router.get("/{order_id}", summary="工单详情（含时间轴与已领用备件）")
def order_detail(
    order_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    order = find_visible(conn, "work_orders", order_id, user, FIELDS)
    if order is None:
        raise ApiError(404, "工单不存在或无权访问")

    timeline = rows_to_dicts(conn.execute(
        "SELECT id, action, operator, note, created_at FROM wo_timeline WHERE order_id = ? ORDER BY id ASC",
        [order_id],
    ).fetchall())
    # 该工单已领用的备件（与备件模块联动）
    parts_used = rows_to_dicts(conn.execute(
        "SELECT part_code, part_name, qty, operator, created_at FROM part_records"
        " WHERE order_code = ? AND type = 'OUT' ORDER BY id ASC",
        [order["code"]],
    ).fetchall())

    ts = now_text()
    return success({
        **dict(order),
        "statusText": STATUS_TEXT.get(order["status"], order["status"]),
        "overdue": is_overdue(order["status"], order["resolve_deadline"], ts),
        "hoursLeft": hours_left(order["resolve_deadline"], ts),
        "timeline": timeline,
        "partsUsed": parts_used,
    })
