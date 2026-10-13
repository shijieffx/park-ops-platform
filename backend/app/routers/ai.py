"""
AI 助手的「事实依据」接口。

⚠️ 这里**只提供本平台自己的业务数据**，不代理任何大模型请求。
模型调用由前端通过云服务 SDK 直连数据面（``/.cloud/llm/*``）完成，
服务端密钥不下发到浏览器。

为什么需要这份快照：大模型不知道本平台的业务数据。若不注入事实依据，
问「现在有多少台设备告警」它只会编一个数。
因此这里把该账号**有权看到**的统计与少量样本压成一段紧凑文本，
前端随每次提问一起发给模型。
"""

from __future__ import annotations

import sqlite3
from typing import Any

from fastapi import APIRouter, Depends

from ..deps import count, current_user, get_db, scope_filter
from ..errors import success
from ..permissions import SCOPE_TEXT, role_name_of
from ..utils import now_text

router = APIRouter(prefix="/api/ai", tags=["AI 助手"])

STATUS_TEXT = {"PENDING": "待受理", "PROCESSING": "处理中", "CHECKING": "待验收", "CLOSED": "已闭环"}


def build_snapshot(conn: sqlite3.Connection, user: dict[str, Any]) -> dict[str, Any]:
    d_sql, d_params = scope_filter("devices", user)
    o_sql, o_params = scope_filter("work_orders", user)
    a_sql, a_params = scope_filter("alarms", user)
    i_sql, i_params = scope_filter("inspection_tasks", user)

    ts = now_text()
    today = ts[:10]

    # ---------- 设备 ----------
    device_total = count(conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql}", d_params)
    device_running = count(
        conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql} AND status = '运行中'", d_params
    )
    device_alarm = count(
        conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql} AND status = '告警'", d_params
    )
    device_maintain = count(
        conn, f"SELECT COUNT(*) FROM devices WHERE {d_sql} AND status = '检修中'", d_params
    )
    by_region = conn.execute(
        f"""SELECT region, COUNT(*) AS c FROM devices WHERE {d_sql}
            GROUP BY region ORDER BY c DESC LIMIT 6""",
        d_params,
    ).fetchall()

    # ---------- 工单 ----------
    rows = conn.execute(
        f"SELECT status, COUNT(*) AS c FROM work_orders WHERE {o_sql} GROUP BY status", o_params
    ).fetchall()
    by_status = {r["status"]: r["c"] for r in rows}
    order_total = sum(by_status.values())

    order_overdue = count(
        conn,
        f"""SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status != 'CLOSED'
            AND resolve_deadline != '' AND resolve_deadline < ?""",
        [*o_params, ts],
    )
    order_overdue_high = count(
        conn,
        f"""SELECT COUNT(*) FROM work_orders WHERE {o_sql} AND status != 'CLOSED'
            AND priority = '高' AND resolve_deadline != '' AND resolve_deadline < ?""",
        [*o_params, ts],
    )
    overdue_samples = conn.execute(
        f"""SELECT code, title, priority, device_code, resolve_deadline FROM work_orders
            WHERE {o_sql} AND status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?
            ORDER BY resolve_deadline ASC LIMIT 5""",
        [*o_params, ts],
    ).fetchall()

    # ---------- 告警 ----------
    alarm_open = count(
        conn, f"SELECT COUNT(*) FROM alarms WHERE {a_sql} AND status = '未处理'", a_params
    )
    alarm_p1 = count(
        conn,
        f"SELECT COUNT(*) FROM alarms WHERE {a_sql} AND level = '紧急' AND status = '未处理'",
        a_params,
    )

    # ---------- 巡检 ----------
    inspect_pending = count(
        conn, f"SELECT COUNT(*) FROM inspection_tasks WHERE {i_sql} AND status = 'PENDING'", i_params
    )
    inspect_overdue = count(
        conn,
        f"""SELECT COUNT(*) FROM inspection_tasks WHERE {i_sql} AND status = 'PENDING'
            AND plan_date < ?""",
        [*i_params, today],
    )

    # ---------- 备件 ----------
    part_total = count(conn, "SELECT COUNT(*) FROM parts")
    low_parts = count(conn, "SELECT COUNT(*) FROM parts WHERE stock < safety_stock")
    low_list = conn.execute(
        """SELECT name, spec, unit, stock, safety_stock FROM parts
           WHERE stock < safety_stock ORDER BY (safety_stock - stock) DESC LIMIT 5"""
    ).fetchall()

    # ---------- 组装成文本 ----------
    lines: list[str] = []
    lines.append(f"【当前账号】{user.get('real_name') or user.get('username')}"
                 f"（{role_name_of(user.get('role_code', ''))}）")
    scope_text = SCOPE_TEXT.get(user.get("scope", ""), user.get("scope") or "")
    region = user.get("region") or ""
    lines.append(f"【数据范围】{scope_text}" + (f"（{region}）" if region else ""))
    lines.append(f"【快照时间】{ts}")
    lines.append("")
    lines.append(
        f"【设备】共 {device_total} 台 —— 运行中 {device_running}、告警 {device_alarm}、"
        f"检修中 {device_maintain}"
    )
    if by_region:
        lines.append("  区域分布：" + "；".join(f"{r['region']} {r['c']} 台" for r in by_region))
    lines.append(
        f"【工单】共 {order_total} 张 —— "
        + "、".join(f"{text} {by_status.get(key, 0)}" for key, text in STATUS_TEXT.items())
    )
    lines.append(f"  处理超时（未闭环且已过处理时限）：{order_overdue} 张，其中高优先级 {order_overdue_high} 张")
    if overdue_samples:
        lines.append("  超时工单样本（按超时程度排序）：")
        for r in overdue_samples:
            lines.append(
                f"    {r['code']}｜{r['priority']}优先级｜设备 {r['device_code'] or '-'}"
                f"｜处理时限 {r['resolve_deadline']}｜{r['title']}"
            )
    lines.append(f"【巡检】待执行 {inspect_pending} 个任务，其中已逾期 {inspect_overdue} 个")
    lines.append(f"【告警】未处理 {alarm_open} 条，其中紧急 {alarm_p1} 条")
    lines.append(f"【备件】共 {part_total} 种，低于安全库存 {low_parts} 种")
    if low_list:
        lines.append("  低库存明细：" + "；".join(
            f"{p['name']}（现存 {p['stock']}/{p['safety_stock']} {p['unit']}）" for p in low_list
        ))

    return {
        "snapshot": "\n".join(lines),
        "scope": user.get("scope"),
        "scopeText": scope_text,
        "region": region,
        "roleName": role_name_of(user.get("role_code", "")),
        "generatedAt": ts,
    }


@router.get("/context", summary="AI 助手数据快照（受数据范围约束）")
def context(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    return success(build_snapshot(conn, user))
