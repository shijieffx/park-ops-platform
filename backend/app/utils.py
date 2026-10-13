"""
通用工具：时间口径、入参解析、SLA 时限。

与 Node 版 ``server/utils/{time,validate,sla}.js`` 一一对应，行为保持一致。
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

# 全项目统一使用「东八区时间的字符串」表示业务时间，形如 '2026-10-09 15:30:00'。
# 与数据库 TEXT 列直接对应，前端展示无需再做时区换算。
#
# ⚠️ 不要用 datetime.utcnow() 直接作为业务时间 —— 那是 UTC，
# 与按 +08:00 解析的 SLA 计算混用会导致 8 小时偏差。
CN_TZ = timezone(timedelta(hours=8))
TIME_FMT = "%Y-%m-%d %H:%M:%S"
DATE_FMT = "%Y-%m-%d"


def now_text() -> str:
    """当前时间（东八区）'YYYY-MM-DD HH:mm:ss'"""
    return datetime.now(CN_TZ).strftime(TIME_FMT)


def today_text() -> str:
    """今天（东八区）'YYYY-MM-DD'"""
    return datetime.now(CN_TZ).strftime(DATE_FMT)


def date_offset_text(days: int) -> str:
    """N 天前后的日期（东八区）'YYYY-MM-DD'，负数表示未来"""
    return (datetime.now(CN_TZ) + timedelta(days=days)).strftime(DATE_FMT)


def hours_ago_text(hours: float) -> str:
    """N 小时前的时间（东八区）'YYYY-MM-DD HH:mm:ss'"""
    return (datetime.now(CN_TZ) - timedelta(hours=hours)).strftime(TIME_FMT)


def parse_ts(time_text: Any) -> datetime | None:
    """把业务时间字符串按东八区解析成带时区的 datetime；解析失败返回 None"""
    if not time_text:
        return None
    raw = str(time_text).strip().replace("T", " ")
    try:
        dt = datetime.strptime(raw[:19], TIME_FMT)
    except ValueError:
        try:
            dt = datetime.strptime(raw[:10], DATE_FMT)
        except ValueError:
            return None
    return dt.replace(tzinfo=CN_TZ)


def plus_hours(base_time: Any, hours: float) -> str:
    """在业务时间字符串上加小时，返回同格式（输入输出都是东八区表示）"""
    dt = parse_ts(base_time)
    if dt is None:
        return ""
    return (dt + timedelta(hours=hours)).strftime(TIME_FMT)


def to_timestamp(time_text: Any) -> float:
    """业务时间字符串 → 秒级时间戳（按东八区解析）；无效返回 NaN"""
    dt = parse_ts(time_text)
    return float("nan") if dt is None else dt.timestamp()


def is_invalid_number(value: float) -> bool:
    return math.isnan(value) or math.isinf(value)


# ---------------------------------------------------------------- 入参解析

def to_int(value: Any, fallback: int) -> int:
    """转整数，失败返回 fallback（NaN / 空串 / 小数都会被规范化）。

    对齐 JS 的 ``Number()`` 语义：空串视为 0，小数截断（不是四舍五入）。
    """
    if value is None:
        return fallback
    raw = str(value).strip()
    if raw == "":
        return 0
    try:
        num = float(raw)
    except ValueError:
        return fallback
    if is_invalid_number(num):
        return fallback
    return int(num)


def parse_paging(
    query: Mapping[str, Any], default_size: int = 20, max_size: int = 100
) -> tuple[int, int, int]:
    """解析分页参数 → (page, pageSize, offset)，任何非法入参都回退到安全默认值"""
    page = to_int(query.get("page"), 1)
    page_size = to_int(query.get("pageSize"), default_size)

    if page < 1:
        page = 1
    if page_size < 1:
        page_size = default_size
    if page_size > max_size:
        page_size = max_size

    return page, page_size, (page - 1) * page_size


def to_keyword(value: Any, max_len: int = 50) -> str:
    """裁剪字符串查询参数，防止超长入参拖垮 LIKE 查询"""
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_len]


def qstr(query: Mapping[str, Any], key: str, default: str = "") -> str:
    """取查询参数的字符串值（缺省与空值都归一成 default）"""
    value = query.get(key)
    return default if value is None else str(value)


# ---------------------------------------------------------------- SLA

# 按优先级给出（响应时限, 处理时限），单位小时
SLA_HOURS: dict[str, dict[str, int]] = {
    "高": {"respond": 2, "resolve": 8},
    "中": {"respond": 8, "resolve": 24},
    "低": {"respond": 24, "resolve": 72},
}


def calc_deadlines(priority: str, base_time: str) -> tuple[str, str]:
    """按优先级计算（响应时限, 处理时限）两个时间点"""
    sla = SLA_HOURS.get(priority) or SLA_HOURS["中"]
    return (
        plus_hours(base_time, sla["respond"]),
        plus_hours(base_time, sla["resolve"]),
    )


def is_overdue(status: str, resolve_deadline: Any, reference: Any = None) -> int:
    """
    是否已超时。

    已闭环的工单不参与判定；没有处理时限的（历史数据）按未超时处理。
    """
    if status == "CLOSED" or not resolve_deadline:
        return 0
    deadline = to_timestamp(resolve_deadline)
    ref = to_timestamp(reference or now_text())
    if is_invalid_number(deadline) or is_invalid_number(ref):
        return 0
    return 1 if deadline < ref else 0


def hours_left(resolve_deadline: Any, reference: Any = None) -> float | None:
    """距处理时限还有多少小时（负数表示已超时），无时限返回 None"""
    if not resolve_deadline:
        return None
    deadline = to_timestamp(resolve_deadline)
    ref = to_timestamp(reference or now_text())
    if is_invalid_number(deadline) or is_invalid_number(ref):
        return None
    # 与 Node 版一致：保留一位小数
    return round((deadline - ref) / 3600.0, 1)
