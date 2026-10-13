"""告警中心：列表、处置、等级分布与趋势"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends, Request

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
from ..utils import parse_paging, to_keyword

router = APIRouter(prefix="/api/alarms", tags=["告警中心"])

require_order_edit = require_perms("order:edit")

FIELDS = "id, device_code, device_name, level, content, status, region, created_at"
LEVEL_ORDER = ["紧急", "重要", "次要", "提示"]


@router.get("/stats/summary", summary="等级分布")
def level_summary(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("alarms", user)
    rows = rows_to_dicts(conn.execute(
        f"SELECT level AS name, COUNT(*) AS value FROM alarms WHERE {sc_sql} GROUP BY level",
        params,
    ).fetchall())
    rows.sort(key=lambda r: LEVEL_ORDER.index(r["name"]) if r["name"] in LEVEL_ORDER else 99)
    return success(rows)


@router.get("/stats/trend", summary="近 30 天告警趋势")
def level_trend(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = scope_filter("alarms", user)
    rows = rows_to_dicts(conn.execute(
        f"""
        SELECT substr(created_at,1,10) AS date, COUNT(*) AS value
        FROM alarms WHERE {sc_sql} GROUP BY date ORDER BY date DESC LIMIT 30
        """,
        params,
    ).fetchall())
    rows.reverse()
    return success(rows)


@router.get("", summary="告警列表")
def list_alarms(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    query = request.query_params
    level = str(query.get("level") or "")
    status = str(query.get("status") or "")
    keyword = to_keyword(query.get("keyword"))
    page, page_size, offset = parse_paging(query)

    sc_sql, params = scope_filter("alarms", user)
    where = [sc_sql]
    if level:
        where.append("level = ?")
        params.append(level)
    if status:
        where.append("status = ?")
        params.append(status)
    if keyword:
        where.append("(device_code LIKE ? OR content LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%"]
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM alarms WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT {FIELDS} FROM alarms WHERE {cond} ORDER BY id DESC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total, "page": page, "pageSize": page_size})


@router.put("/{alarm_id}/close", summary="标记已处理", dependencies=[Depends(require_order_edit)])
def close_alarm(
    alarm_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    exists = find_visible(conn, "alarms", alarm_id, user, "id")
    if exists is None:
        raise ApiError(404, "告警不存在或无权访问")

    conn.execute("UPDATE alarms SET status = ? WHERE id = ?", ["已处理", alarm_id])
    write_log(conn, user["username"], "告警处理", f"处理告警 #{alarm_id}")
    return success(message="已标记为已处理")
