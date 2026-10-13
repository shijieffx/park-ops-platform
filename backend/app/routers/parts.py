"""备件库存：台账、出入库、工单领用、低库存预警"""

from __future__ import annotations

import sqlite3

from fastapi import APIRouter, Body, Depends, Request

from ..db import transaction
from ..deps import (
    count,
    current_user,
    get_db,
    require_perms,
    rows_to_dicts,
    scalar,
    write_log,
)
from ..errors import ApiError, success
from ..utils import now_text, parse_paging, to_int, to_keyword

router = APIRouter(prefix="/api/parts", tags=["备件库存"])

require_edit = require_perms("part:edit")
require_order_edit = require_perms("order:edit")

FIELDS = "id, code, name, spec, unit, stock, safety_stock, price, vendor, created_at"

# 低库存判定直接下沉到 SQL，保证列表与统计口径一致
LOW_STOCK_SQL = "stock < safety_stock"


@router.get("", summary="备件列表（低库存优先）")
def list_parts(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    query = request.query_params
    keyword = to_keyword(query.get("keyword"))
    vendor = str(query.get("category") or "")
    only_low = str(query.get("onlyLow") or "")
    page, page_size, offset = parse_paging(query)

    where, params = ["1=1"], []
    if keyword:
        where.append("(code LIKE ? OR name LIKE ? OR spec LIKE ?)")
        params += [f"%{keyword}%", f"%{keyword}%", f"%{keyword}%"]
    if vendor:
        where.append("vendor = ?")
        params.append(vendor)
    if only_low == "1":
        where.append(LOW_STOCK_SQL)
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM parts WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT {FIELDS}, ({LOW_STOCK_SQL}) AS low FROM parts WHERE {cond}"
        f" ORDER BY low DESC, id ASC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({
        "list": [{**dict(r), "low": bool(r["low"])} for r in rows],
        "total": total,
        "page": page,
        "pageSize": page_size,
    })


@router.get("/all", summary="全量备件（工单领用下拉）")
def all_parts(
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    rows = conn.execute(f"SELECT {FIELDS} FROM parts ORDER BY name ASC").fetchall()
    return success(rows_to_dicts(rows))


@router.get("/records", summary="出入库流水")
def part_records(
    request: Request,
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    query = request.query_params
    part_id = str(query.get("partId") or "")
    record_type = str(query.get("type") or "")
    order_code = str(query.get("orderCode") or "")
    page, page_size, offset = parse_paging(query)

    where, params = ["1=1"], []
    if part_id:
        where.append("part_id = ?")
        params.append(to_int(part_id, 0))
    if record_type:
        where.append("type = ?")
        params.append(record_type)
    if order_code:
        where.append("order_code = ?")
        params.append(order_code)
    cond = " AND ".join(where)

    total = count(conn, f"SELECT COUNT(*) FROM part_records WHERE {cond}", params)
    rows = conn.execute(
        f"SELECT * FROM part_records WHERE {cond} ORDER BY id DESC LIMIT ? OFFSET ?",
        [*params, page_size, offset],
    ).fetchall()
    return success({"list": rows_to_dicts(rows), "total": total, "page": page, "pageSize": page_size})


@router.get("/stats/summary", summary="备件统计")
def part_stats(
    conn: sqlite3.Connection = Depends(get_db),
    _: dict = Depends(current_user),
):
    low_list = rows_to_dicts(conn.execute(
        f"""SELECT id, code, name, unit, stock, safety_stock FROM parts
            WHERE {LOW_STOCK_SQL} ORDER BY (stock - safety_stock) ASC LIMIT 10"""
    ).fetchall())
    trend = rows_to_dicts(conn.execute(
        """
        SELECT substr(created_at,1,10) AS date,
               SUM(CASE WHEN type = 'OUT' THEN qty ELSE 0 END) AS outQty,
               SUM(CASE WHEN type = 'IN' THEN qty ELSE 0 END) AS inQty
        FROM part_records GROUP BY date ORDER BY date DESC LIMIT 14
        """
    ).fetchall())
    trend.reverse()

    return success({
        "totalParts": count(conn, "SELECT COUNT(*) FROM parts"),
        "lowCount": count(conn, f"SELECT COUNT(*) FROM parts WHERE {LOW_STOCK_SQL}"),
        "stockValue": round(float(scalar(conn, "SELECT SUM(stock * price) FROM parts") or 0), 2),
        "outQty": int(scalar(conn, "SELECT SUM(qty) FROM part_records WHERE type = 'OUT'") or 0),
        "inQty": int(scalar(conn, "SELECT SUM(qty) FROM part_records WHERE type = 'IN'") or 0),
        "lowList": low_list,
        "trend": trend,
    })


@router.post("", summary="新增 / 编辑备件", dependencies=[Depends(require_edit)])
def save_part(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    if not d.get("code") or not d.get("name"):
        raise ApiError(400, "备件编码与名称必填")

    stock = to_int(d.get("stock"), 0)
    safety = to_int(d.get("safetyStock"), 0)
    if stock < 0 or safety < 0:
        raise ApiError(400, "库存与安全库存不能为负数")

    payload_row = [
        d["code"], d["name"], d.get("spec") or "", d.get("unit") or "个", stock, safety,
        float(d.get("price") or 0), d.get("vendor") or "",
    ]

    if d.get("id"):
        exists = conn.execute("SELECT id FROM parts WHERE id = ?", [d["id"]]).fetchone()
        if exists is None:
            raise ApiError(404, "备件不存在")
        conn.execute(
            "UPDATE parts SET code=?, name=?, spec=?, unit=?, stock=?, safety_stock=?, price=?,"
            " vendor=? WHERE id=?",
            [*payload_row, d["id"]],
        )
        write_log(conn, user["username"], "备件维护", f"编辑备件 {d['code']}")
        return success(message="保存成功")

    if conn.execute("SELECT id FROM parts WHERE code = ?", [d["code"]]).fetchone():
        raise ApiError(400, "备件编码已存在")
    conn.execute(
        "INSERT INTO parts (code, name, spec, unit, stock, safety_stock, price, vendor, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?)",
        [*payload_row, now_text()],
    )
    write_log(conn, user["username"], "备件维护", f"新增备件 {d['code']}")
    return success(message="新增成功")


@router.post("/apply", summary="工单领用备件", dependencies=[Depends(require_order_edit)])
def apply_part(
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    part_id = d.get("partId")
    qty = d.get("qty")
    if not part_id:
        raise ApiError(400, "请选择备件")

    n = _positive_int(qty)
    if n is None:
        raise ApiError(400, "领用数量必须为正整数")

    part = conn.execute("SELECT * FROM parts WHERE id = ?", [part_id]).fetchone()
    if part is None:
        raise ApiError(404, "备件不存在")
    if part["stock"] < n:
        raise ApiError(
            400,
            f"库存不足：{part['name']} 当前 {part['stock']}{part['unit']}，需领用 {n}{part['unit']}",
        )

    order_code = d.get("orderCode") or ""
    if order_code and not conn.execute(
        "SELECT id FROM work_orders WHERE code = ?", [order_code]
    ).fetchone():
        raise ApiError(400, "关联的工单不存在")

    after = part["stock"] - n
    ts = now_text()
    with transaction(conn):
        conn.execute("UPDATE parts SET stock = ? WHERE id = ?", [after, part["id"]])
        conn.execute(
            "INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock,"
            " after_stock, order_code, operator, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                part["id"], part["code"], part["name"], "OUT", n, part["stock"], after,
                order_code, user.get("real_name") or "", d.get("note") or "工单领用", ts,
            ],
        )

    low = after < part["safety_stock"]
    write_log(
        conn, user["username"], "备件领用",
        f"工单 {order_code or '-'} 领用 {part['code']} × {n}，剩余 {after}",
    )
    message = f"领用成功，库存 {part['stock']} → {after}"
    if low:
        message += f"，已低于安全库存 {part['safety_stock']}{part['unit']}"
    return success({"stock": after, "lowStock": low, "partName": part["name"]}, message=message)


@router.post("/{part_id}/stock", summary="手动入库 / 出库", dependencies=[Depends(require_edit)])
def change_stock(
    part_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
    payload: dict | None = Body(default=None),
):
    d = payload or {}
    record_type = d.get("type")
    n = _positive_int(d.get("qty"))
    if record_type not in ("IN", "OUT"):
        raise ApiError(400, "出入库类型只能为 IN 或 OUT")
    if n is None:
        raise ApiError(400, "数量必须为正整数")

    part = conn.execute("SELECT * FROM parts WHERE id = ?", [part_id]).fetchone()
    if part is None:
        raise ApiError(404, "备件不存在")
    if record_type == "OUT" and part["stock"] < n:
        raise ApiError(
            400,
            f"库存不足：当前 {part['stock']}{part['unit']}，需出库 {n}{part['unit']}",
        )

    after = part["stock"] + n if record_type == "IN" else part["stock"] - n
    with transaction(conn):
        conn.execute("UPDATE parts SET stock = ? WHERE id = ?", [after, part["id"]])
        conn.execute(
            "INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock,"
            " after_stock, order_code, operator, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                part["id"], part["code"], part["name"], record_type, n, part["stock"], after, "",
                user.get("real_name") or "",
                d.get("note") or ("采购入库" if record_type == "IN" else "手动出库"),
                now_text(),
            ],
        )

    action = "入库" if record_type == "IN" else "出库"
    write_log(conn, user["username"], "备件出入库", f"{action} {part['code']} {n}{part['unit']}")
    return success(
        {"stock": after, "lowStock": after < part["safety_stock"]},
        message=f"{action}成功，库存 {part['stock']} → {after}",
    )


@router.delete("/{part_id}", summary="删除备件", dependencies=[Depends(require_edit)])
def delete_part(
    part_id: int,
    conn: sqlite3.Connection = Depends(get_db),
    user: dict = Depends(current_user),
):
    part = conn.execute("SELECT * FROM parts WHERE id = ?", [part_id]).fetchone()
    if part is None:
        raise ApiError(404, "备件不存在")
    used = count(conn, "SELECT COUNT(*) FROM part_records WHERE part_id = ?", [part["id"]])
    if used > 0:
        raise ApiError(400, "该备件已有出入库记录，不能删除")
    conn.execute("DELETE FROM parts WHERE id = ?", [part["id"]])
    write_log(conn, user["username"], "备件维护", f"删除备件 {part['code']}")
    return success(message="删除成功")


def _positive_int(value: object) -> int | None:
    """正整数校验：与 Node 的 Number.isInteger(n) && n > 0 对齐"""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        return int(value) if value.is_integer() and value > 0 else None
    if isinstance(value, str):
        text = value.strip()
        if text.lstrip("+-").isdigit():
            num = int(text)
            return num if num > 0 else None
    return None
