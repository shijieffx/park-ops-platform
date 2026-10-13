"""巡检管理：计划 → 任务 → 现场执行 → 异常自动转告警与工单"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, Depends, Request

from ..db import transaction
from ..deps import (
    count,
    current_user,
    get_db,
    require_perms,
    rows_to_dicts,
    scope_filter,
    write_log,
)
from ..errors import ApiError, success
from ..utils import SLA_HOURS, calc_deadlines, now_text, parse_paging, to_keyword

router = APIRouter(prefix="/api/inspection", tags=["巡检管理"])

require_plan = require_perms("inspection:plan")
require_execute = require_perms("inspection:edit")


def task_scope(user: dict) -> tuple[str, list[Any]]:
    """巡检任务的可见范围复用统一的数据范围规则（专员只看本人负责的任务）"""
    return scope_filter("inspection_tasks", user)


def find_task(
    conn: sqlite3.Connection, task_id: Any, user: dict
) -> sqlite3.Row | None:
    """在可见范围内取任务，越权与不存在返回同一结果"""
    sc_sql, params = task_scope(user)
    return conn.execute(
        f"SELECT * FROM inspection_tasks WHERE id = ? AND {sc_sql}", [task_id, *params]
    ).fetchone()


def parse_items(raw: Any) -> list[str]:
    """检查项解析：兼容 JSON 数组与「顿号 / 逗号」手写的字符串"""
    if isinstance(raw, list):
        return [str(i) for i in raw if i]
    if not isinstance(raw, str):
        return []
    try:
        arr = json.loads(raw)
        if isinstance(arr, list):
            return [str(i) for i in arr if i]
        return []
    except json.JSONDecodeError:
        return [s.strip() for s in raw.replace("，", "、").replace(",", "、").split("、") if s.strip()]


# ------------------------------------------------------------------ 巡检计划

@router.get("/plans", summary="计划列表（含任务进度）")
def list_plans(
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    rows = conn.execute("SELECT * FROM inspection_plans ORDER BY id ASC").fetchall()
    stats = {
        r["plan_id"]: r
        for r in conn.execute(
            """
            SELECT plan_id, COUNT(*) AS total,
                   SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done,
                   SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending
            FROM inspection_tasks GROUP BY plan_id
            """
        ).fetchall()
    }
    data = []
    for row in rows:
        item = dict(row)
        stat = stats.get(row["id"])
        item["items"] = parse_items(row["items"])
        item["taskTotal"] = stat["total"] if stat else 0
        item["taskDone"] = (stat["done"] or 0) if stat else 0
        item["taskPending"] = (stat["pending"] or 0) if stat else 0
        data.append(item)
    return success(data)


@router.post("/plans", summary="新增 / 编辑计划", dependencies=[Depends(require_plan)])
def save_plan(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    if not d.get("name"):
        raise ApiError(400, "计划名称必填")
    if not d.get("region"):
        raise ApiError(400, "巡检区域必填")
    items = parse_items(d.get("items"))
    if not items:
        raise ApiError(400, "至少需要一个检查项")

    row = [
        d["name"], d["region"], d.get("category") or "", d.get("cycle") or "每日",
        json.dumps(items, ensure_ascii=False), d.get("owner") or "",
        1 if d.get("status") is None else int(d["status"]),
    ]

    if d.get("id"):
        exists = conn.execute("SELECT id FROM inspection_plans WHERE id = ?", [d["id"]]).fetchone()
        if exists is None:
            raise ApiError(404, "计划不存在")
        conn.execute(
            "UPDATE inspection_plans SET name=?, region=?, category=?, cycle=?, items=?, owner=?,"
            " status=? WHERE id=?",
            [*row, d["id"]],
        )
        write_log(conn, user["username"], "巡检计划", f"编辑计划「{d['name']}」")
        return success(message="保存成功")

    ts = now_text()
    conn.execute(
        "INSERT INTO inspection_plans (name, region, category, cycle, items, owner, status,"
        " next_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        [*row, ts[:10], ts],
    )
    write_log(conn, user["username"], "巡检计划", f"新增计划「{d['name']}」")
    return success(message="新增成功")


@router.put("/plans/{plan_id}/status", summary="启用 / 停用计划", dependencies=[Depends(require_plan)])
def toggle_plan(
    plan_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    payload: dict | None = Body(default=None),
):
    exists = conn.execute("SELECT id FROM inspection_plans WHERE id = ?", [plan_id]).fetchone()
    if exists is None:
        raise ApiError(404, "计划不存在")
    conn.execute(
        "UPDATE inspection_plans SET status = ? WHERE id = ?",
        [1 if (payload or {}).get("status") else 0, plan_id],
    )
    return success(message="状态已更新")


@router.delete("/plans/{plan_id}", summary="删除计划", dependencies=[Depends(require_plan)])
def delete_plan(
    plan_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    used = count(conn, "SELECT COUNT(*) FROM inspection_tasks WHERE plan_id = ?", [plan_id])
    if used > 0:
        raise ApiError(400, "该计划已产生巡检任务，不能删除（可改为停用）")
    conn.execute("DELETE FROM inspection_plans WHERE id = ?", [plan_id])
    write_log(conn, user["username"], "巡检计划", f"删除计划 #{plan_id}")
    return success(message="删除成功")


# ------------------------------------------------------------------ 巡检任务

@router.get("/tasks", summary="任务列表")
def list_tasks(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    query = request.query_params
    status = str(query.get("status") or "")
    plan_id = str(query.get("planId") or "")
    date_from = str(query.get("dateFrom") or "")
    date_to = str(query.get("dateTo") or "")
    keyword = to_keyword(query.get("keyword"))
    page, page_size, offset = parse_paging(query)

    sc_sql, params = task_scope(user)
    where = [sc_sql]
    if status:
        where.append("status = ?")
        params.append(status)
    if plan_id:
        where.append("plan_id = ?")
        params.append(int(plan_id) if plan_id.lstrip("-").isdigit() else 0)
    if date_from:
        where.append("plan_date >= ?")
        params.append(date_from)
    if date_to:
        where.append("plan_date <= ?")
        params.append(date_to)
    if keyword:
        where.append("(code LIKE ? OR plan_name LIKE ? OR inspector LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%", f"%{keyword}%"]
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM inspection_tasks WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT * FROM inspection_tasks WHERE {cond} ORDER BY plan_date DESC, id DESC"
        f" LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total, "page": page, "pageSize": page_size})


@router.post("/tasks/generate", summary="按计划生成任务", dependencies=[Depends(require_execute)])
def generate_tasks(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    plan_date = (payload or {}).get("date") or now_text()[:10]
    plans = conn.execute("SELECT * FROM inspection_plans WHERE status = 1").fetchall()
    ts = now_text()
    created, skipped = 0, 0

    with transaction(conn):
        for plan in plans:
            code = f"INS{plan['id']:02d}{plan_date.replace('-', '')}"
            if conn.execute("SELECT id FROM inspection_tasks WHERE code = ?", [code]).fetchone():
                skipped += 1
                continue
            items = parse_items(plan["items"])
            # 专员自己触发时直接认领，管理员 / 主管触发则留给负责人
            inspector = (
                user.get("real_name") if user.get("scope") == "SELF" else (plan["owner"] or "")
            )
            conn.execute(
                "INSERT INTO inspection_tasks (code, plan_id, plan_name, region, inspector, status,"
                " plan_date, finished_at, total, abnormal, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [code, plan["id"], plan["name"], plan["region"], inspector, "PENDING", plan_date,
                 "", len(items), 0, ts],
            )
            created += 1

    write_log(
        conn, user["username"], "巡检任务",
        f"生成 {plan_date} 的任务：新建 {created} 个，跳过 {skipped} 个",
    )
    message = f"已生成 {created} 个任务" + (f"，跳过 {skipped} 个已存在" if skipped else "")
    return success({"created": created, "skipped": skipped, "date": plan_date}, message=message)


@router.get("/tasks/{task_id}", summary="任务详情（含检查记录与检查项）")
def task_detail(
    task_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    task = find_task(conn, task_id, user)
    if task is None:
        raise ApiError(404, "巡检任务不存在或无权访问")
    records = rows_to_dicts(conn.execute(
        "SELECT * FROM inspection_records WHERE task_id = ? ORDER BY id ASC", [task_id]
    ).fetchall())
    plan = conn.execute(
        "SELECT * FROM inspection_plans WHERE id = ?", [task["plan_id"]]
    ).fetchone()
    return success({
        **dict(task),
        "records": records,
        "items": parse_items(plan["items"]) if plan else [],
    })


@router.post(
    "/tasks/{task_id}/submit",
    summary="提交巡检结果（异常自动转告警与工单）",
    dependencies=[Depends(require_execute)],
)
def submit_task(
    task_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    task = find_task(conn, task_id, user)
    if task is None:
        raise ApiError(404, "巡检任务不存在或无权访问")
    if task["status"] == "DONE":
        raise ApiError(400, "该巡检任务已完成，不能重复提交")

    d = payload or {}
    raw_results = d.get("results")
    results = raw_results if isinstance(raw_results, list) else []
    if not results:
        raise ApiError(400, "请至少登记一个检查项")

    items = [r for r in results if isinstance(r, dict) and r.get("item")]
    abnormal = [r for r in items if r.get("result") == "异常"]
    ts = now_text()
    created_orders: list[str] = []

    try:
        with transaction(conn):
            for r in items:
                conn.execute(
                    "INSERT INTO inspection_records (task_id, item, device_code, result, note,"
                    " created_at) VALUES (?,?,?,?,?,?)",
                    [
                        task["id"], str(r["item"]), r.get("deviceCode") or "",
                        "异常" if r.get("result") == "异常" else "正常", r.get("note") or "", ts,
                    ],
                )

            seq_base = count(conn, "SELECT COUNT(*) FROM work_orders")
            for i, r in enumerate(abnormal):
                device_code = r.get("deviceCode") or ""
                device = (
                    conn.execute(
                        "SELECT name, region FROM devices WHERE code = ?", [device_code]
                    ).fetchone()
                    if device_code else None
                )
                region = (device["region"] if device else None) or task["region"] or ""

                # 1) 产生告警（异常必告警）
                conn.execute(
                    "INSERT INTO alarms (device_code, device_name, level, content, status, region,"
                    " created_at) VALUES (?,?,?,?,?,?,?)",
                    [
                        device_code, device["name"] if device else "", "重要",
                        f"巡检发现异常：{r['item']}"
                        + (f"（{r['note']}）" if r.get("note") else ""),
                        "未处理", region, ts,
                    ],
                )

                # 2) 自动转工单，优先级按异常项取「高」，并按 SLA 写入时限
                code = f"WO{seq_base + i + 1:05d}"
                priority = "高"
                response_deadline, resolve_deadline = calc_deadlines(priority, ts)
                cur = conn.execute(
                    "INSERT INTO work_orders (code, title, type, priority, status, device_code,"
                    " creator, handler, region, response_deadline, resolve_deadline, responded_at,"
                    " overdue, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [
                        code, f"巡检异常：{r['item']}", "故障报修", priority, "PENDING", device_code,
                        user.get("real_name") or "", "", region, response_deadline,
                        resolve_deadline, "", 0, ts, ts,
                    ],
                )
                conn.execute(
                    "INSERT INTO wo_timeline (order_id, action, operator, note, created_at)"
                    " VALUES (?,?,?,?,?)",
                    [
                        cur.lastrowid, "创建工单", user.get("real_name") or "",
                        f"由巡检任务 {task['code']} 自动生成", ts,
                    ],
                )
                created_orders.append(code)

            conn.execute(
                "UPDATE inspection_tasks SET status = 'DONE', inspector = ?, finished_at = ?,"
                " total = ?, abnormal = ? WHERE id = ?",
                [
                    task["inspector"] or user.get("real_name") or "", ts,
                    len(items), len(abnormal), task["id"],
                ],
            )
    except sqlite3.Error as exc:
        raise ApiError(500, f"提交失败：{exc}") from exc

    detail = (
        f"完成任务 {task['code']}，检查 {len(items)} 项，异常 {len(abnormal)} 项"
        + (f"，自动建单 {'、'.join(created_orders)}" if created_orders else "")
    )
    write_log(conn, user["username"], "巡检执行", detail)

    message = (
        f"提交成功，发现 {len(abnormal)} 项异常，已自动生成 {len(created_orders)} 张工单"
        if abnormal else "提交成功，本次巡检全部正常"
    )
    return success(
        {"total": len(items), "abnormal": len(abnormal), "orders": created_orders}, message=message
    )


# ------------------------------------------------------------------ 统计

@router.get("/stats/summary", summary="巡检统计")
def inspection_stats(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = task_scope(user)

    def one(condition: str) -> int:
        return count(conn, f"SELECT COUNT(*) FROM inspection_tasks WHERE {sc_sql} AND {condition}", params)

    trend = rows_to_dicts(conn.execute(
        f"""SELECT plan_date AS date, COUNT(*) AS value FROM inspection_tasks
            WHERE {sc_sql} AND status = 'DONE' GROUP BY plan_date
            ORDER BY plan_date DESC LIMIT 14""",
        params,
    ).fetchall())
    trend.reverse()

    return success({
        "pending": one("status = 'PENDING'"),
        "done": one("status = 'DONE'"),
        "abnormalTasks": one("abnormal > 0"),
        "trend": trend,
        "byRegion": rows_to_dicts(conn.execute(
            f"""SELECT region AS name, COUNT(*) AS value FROM inspection_tasks
                WHERE {sc_sql} GROUP BY region ORDER BY value DESC""",
            params,
        ).fetchall()),
        "planProgress": rows_to_dicts(conn.execute(
            f"""SELECT plan_name AS name, COUNT(*) AS total,
                       SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done
                FROM inspection_tasks WHERE {sc_sql} GROUP BY plan_name
                ORDER BY total DESC LIMIT 8""",
            params,
        ).fetchall()),
    })


@router.get("/stats/overdue", summary="到期未执行的巡检任务")
def overdue_tasks(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    sc_sql, params = task_scope(user)
    today = now_text()[:10]
    rows = conn.execute(
        f"""SELECT * FROM inspection_tasks
            WHERE {sc_sql} AND status = 'PENDING' AND plan_date < ?
            ORDER BY plan_date ASC LIMIT 20""",
        [*params, today],
    ).fetchall()
    return success([{**dict(r), "overdueDays": 1} for r in rows])


@router.get("/meta/sla", summary="SLA 参考值（供前端复用）")
def sla_meta(_: dict = Depends(current_user)):
    return success({"hours": SLA_HOURS})
