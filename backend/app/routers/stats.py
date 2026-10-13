"""
首页看板聚合统计。

所有统计均受角色数据范围约束：admin 全量 / manager 本区域 / operator 仅本人。
切换账号后同一张图上的数据量会明显不同 —— 这是 RBAC 数据范围权限的直接体现。
"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Depends

from ..deps import count, current_user, get_db, rows_to_dicts, scope_filter
from ..errors import success
from ..utils import date_offset_text, now_text

router = APIRouter(prefix="/api/stats", tags=["看板统计"])


@router.get("/dashboard", summary="看板聚合数据")
def dashboard(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    d_sql, d_params = scope_filter("devices", user)
    o_sql, o_params = scope_filter("work_orders", user)
    a_sql, a_params = scope_filter("alarms", user)
    i_sql, i_params = scope_filter("inspection_tasks", user)

    ts = now_text()
    today = ts[:10]

    device_total = count(conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql}", d_params)
    device_alarm = count(
        conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql} AND status = '告警'", d_params
    )
    device_maintain = count(
        conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql} AND status = '检修中'", d_params
    )

    order_pending = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status = 'PENDING'", o_params
    )
    order_processing = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status = 'PROCESSING'", o_params
    )
    order_closed = count(
        conn, f"SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status = 'CLOSED'", o_params
    )

    alarm_open = count(
        conn, f"SELECT COUNT(*) FROM alarms WHERE {a_sql} AND status = '未处理'", a_params
    )
    alarm_p1 = count(
        conn,
        f"SELECT COUNT(*) FROM alarms WHERE {a_sql} AND level = '紧急' AND status = '未处理'",
        a_params,
    )

    # ---------- 巡检 / 备件 / 保养 / 时效 ----------
    inspect_pending = count(
        conn, f"SELECT COUNT(*) FROM inspection_tasks WHERE {i_sql} AND status = 'PENDING'", i_params
    )
    inspect_overdue = count(
        conn,
        f"""SELECT COUNT(*) FROM inspection_tasks
            WHERE {i_sql} AND status = 'PENDING' AND plan_date < ?""",
        [*i_params, today],
    )
    # 工单处理超时（未闭环且已过处理时限）
    order_overdue = count(
        conn,
        f"""SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status != 'CLOSED'
            AND resolve_deadline != '' AND resolve_deadline < ?""",
        [*o_params, ts],
    )
    low_parts = count(conn, "SELECT COUNT(*) FROM parts WHERE stock < safety_stock")
    # 7 天内需保养的设备
    maintain_due = count(
        conn,
        f"""SELECT COUNT(*) FROM devices WHERE {d_sql} AND next_maintain_date != ''
            AND next_maintain_date <= ?""",
        [*d_params, date_offset_text(7)],
    )

    status_text = {"PENDING": "待受理", "PROCESSING": "处理中", "CHECKING": "待验收", "CLOSED": "已闭环"}
    order_rows = conn.execute(
        f"SELECT status, COUNT(*) AS c FROM work_orders WHERE {o_sql} GROUP BY status", o_params
    ).fetchall()
    by_status = {r["status"]: r["c"] for r in order_rows}

    alarm_trend = rows_to_dicts(conn.execute(
        f"""SELECT substr(created_at,1,10) AS date, COUNT(*) AS value
            FROM alarms WHERE {a_sql} GROUP BY date ORDER BY date DESC LIMIT 14""",
        a_params,
    ).fetchall())
    alarm_trend.reverse()

    inspect_trend = rows_to_dicts(conn.execute(
        f"""SELECT plan_date AS date, COUNT(*) AS value FROM inspection_tasks
            WHERE {i_sql} AND status = 'DONE' GROUP BY plan_date
            ORDER BY plan_date DESC LIMIT 14""",
        i_params,
    ).fetchall())
    inspect_trend.reverse()

    part_trend = rows_to_dicts(conn.execute(
        """
        SELECT substr(created_at,1,10) AS date,
               SUM(CASE WHEN type = 'OUT' THEN qty ELSE 0 END) AS value
        FROM part_records GROUP BY date ORDER BY date DESC LIMIT 14
        """
    ).fetchall())
    part_trend.reverse()

    return success({
        "scope": user.get("scope"),
        "region": user.get("region"),
        "cards": {
            "deviceTotal": device_total,
            "deviceAlarm": device_alarm,
            "deviceMaintain": device_maintain,
            "orderPending": order_pending,
            "orderProcessing": order_processing,
            "orderClosed": order_closed,
            "alarmOpen": alarm_open,
            "alarmP1": alarm_p1,
            "inspectPending": inspect_pending,
            "inspectOverdue": inspect_overdue,
            "orderOverdue": order_overdue,
            "lowParts": low_parts,
            "maintainDue": maintain_due,
        },
        "byRegion": rows_to_dicts(conn.execute(
            f"""SELECT region AS name, COUNT(*) AS value FROM devices WHERE {d_sql}
                GROUP BY region ORDER BY value DESC""",
            d_params,
        ).fetchall()),
        "byCategory": rows_to_dicts(conn.execute(
            f"""SELECT category AS name, COUNT(*) AS value FROM devices WHERE {d_sql}
                GROUP BY category ORDER BY value DESC""",
            d_params,
        ).fetchall()),
        "byStatus": rows_to_dicts(conn.execute(
            f"""SELECT status AS name, COUNT(*) AS value FROM devices WHERE {d_sql}
                GROUP BY status""",
            d_params,
        ).fetchall()),
        "alarmTrend": alarm_trend,
        "orderByStatus": [{"name": status_text[s], "value": by_status.get(s, 0)} for s in status_text],
        "alarmLevel": rows_to_dicts(conn.execute(
            f"SELECT level AS name, COUNT(*) AS value FROM alarms WHERE {a_sql} GROUP BY level",
            a_params,
        ).fetchall()),
        "inspectTrend": inspect_trend,
        "partTrend": part_trend,
    })
