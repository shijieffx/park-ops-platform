"""
通用工具单元测试（纯函数，不依赖数据库）。

这里的重点是把「与 Node 版对齐的边界行为」固定下来 ——
例如 `to_int('')` 必须等于 0（对齐 JS 的 `Number('')`）、小数必须截断而不是四舍五入。
这些细节一旦改动，两套后端的入参行为就会分叉。
"""

from __future__ import annotations

from datetime import datetime, timezone

from app.utils import (
    calc_deadlines,
    date_offset_text,
    hours_left,
    is_overdue,
    now_text,
    parse_paging,
    plus_hours,
    to_int,
    to_keyword,
    to_timestamp,
    today_text,
)


def test_to_int_matches_js_number_semantics():
    assert to_int("12", 1) == 12
    assert to_int(" 7 ", 1) == 7
    assert to_int("-4", 1) == -4
    assert to_int("", 1) == 0          # JS: Number('') === 0
    assert to_int("abc", 7) == 7       # 非数字回退
    assert to_int("3.9", 1) == 3       # 截断，不是四舍五入
    assert to_int(None, 5) == 5
    assert to_int("Infinity", 2) == 2
    assert to_int("NaN", 2) == 2


def test_parse_paging_clamps_to_safe_range():
    assert parse_paging({}) == (1, 20, 0)
    assert parse_paging({"page": "0", "pageSize": "0"}) == (1, 20, 0)
    assert parse_paging({"page": "-5", "pageSize": "10"}) == (1, 10, 0)
    assert parse_paging({"page": "3", "pageSize": "50"}) == (3, 50, 100)
    assert parse_paging({"page": "abc", "pageSize": "xyz"}) == (1, 20, 0)
    assert parse_paging({"pageSize": "999999"}) == (1, 100, 0)   # 上限 100


def test_to_keyword_trims_and_limits_length():
    assert to_keyword("  园区  ") == "园区"
    assert to_keyword(None) == ""
    assert to_keyword(123) == ""
    assert to_keyword("x" * 80) == "x" * 50


def test_now_text_is_east_eight():
    """业务时间必须是东八区，不能是 UTC（差 8 小时会让 SLA 判定整体偏移）"""
    utc_naive = datetime.now(timezone.utc).replace(tzinfo=None)
    local = datetime.strptime(now_text(), "%Y-%m-%d %H:%M:%S")
    assert abs((local - utc_naive).total_seconds() - 8 * 3600) < 5


def test_date_helpers():
    assert today_text() == now_text()[:10]
    assert len(date_offset_text(0)) == 10
    assert date_offset_text(1) > date_offset_text(0)
    assert date_offset_text(-1) < date_offset_text(0)


def test_plus_hours_keeps_east_eight_representation():
    assert plus_hours("2026-10-13 10:00:00", 8) == "2026-10-13 18:00:00"
    assert plus_hours("2026-10-13 22:00:00", 4) == "2026-10-14 02:00:00"
    assert plus_hours("2026-10-13 10:00:00", 24) == "2026-10-14 10:00:00"
    assert plus_hours("", 1) == ""
    assert plus_hours("not-a-date", 1) == ""


def test_to_timestamp_parses_as_east_eight():
    # 东八区的 2026-01-01 08:00:00 即 UTC 的 2026-01-01 00:00:00
    expected = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp()
    assert to_timestamp("2026-01-01 08:00:00") == expected
    # 相邻小时应严格相差 1 小时，不受本机时区影响
    assert to_timestamp("2026-01-01 09:00:00") - to_timestamp("2026-01-01 08:00:00") == 3600
    assert to_timestamp("") != to_timestamp("")   # NaN 不等于自身


def test_calc_deadlines_by_priority():
    assert calc_deadlines("高", "2026-10-13 09:00:00") == (
        "2026-10-13 11:00:00", "2026-10-13 17:00:00")
    assert calc_deadlines("中", "2026-10-13 09:00:00") == (
        "2026-10-13 17:00:00", "2026-10-14 09:00:00")
    assert calc_deadlines("低", "2026-10-13 09:00:00") == (
        "2026-10-14 09:00:00", "2026-10-16 09:00:00")
    # 未知优先级按「中」处理，不能抛异常
    assert calc_deadlines("未知", "2026-10-13 09:00:00") == calc_deadlines("中", "2026-10-13 09:00:00")


def test_is_overdue_edges():
    assert is_overdue("CLOSED", "2020-01-01 00:00:00", "2026-01-01 00:00:00") == 0  # 已闭环不判定
    assert is_overdue("PENDING", "", "2026-01-01 00:00:00") == 0                    # 无时限按未超时
    assert is_overdue("PENDING", "2020-01-01 00:00:00", "2026-01-01 00:00:00") == 1
    assert is_overdue("PENDING", "2030-01-01 00:00:00", "2026-01-01 00:00:00") == 0


def test_hours_left():
    assert hours_left("2026-01-01 10:00:00", "2026-01-01 00:00:00") == 10.0
    assert hours_left("2026-01-01 00:00:00", "2026-01-01 03:00:00") == -3.0
    assert hours_left("", None) is None


def test_iso_helpers_are_independent_of_machine_timezone(monkeypatch):
    """即使机器时区不是东八区，now_text 也必须给出东八区时间"""
    fake_utc = datetime(2026, 1, 1, 0, 30, tzinfo=timezone.utc)
    real_datetime = datetime

    class _FakeDateTime(real_datetime):  # type: ignore[misc]
        @classmethod
        def now(cls, tz=None):
            return fake_utc.astimezone(tz) if tz else fake_utc.replace(tzinfo=None)

    monkeypatch.setattr("app.utils.datetime", _FakeDateTime)
    assert now_text() == "2026-01-01 08:30:00"
    assert today_text() == "2026-01-01"
    assert date_offset_text(-1) == "2025-12-31"
