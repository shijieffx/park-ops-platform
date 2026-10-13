"""
初始化演示数据。

全部为脚本随机生成的模拟数据，不含有任何真实业务信息。
与 Node 版 ``server/seed.js`` 保持同口径（同样的表、同样的分布、同样的字段），
因此无论由哪一套后端生成数据，前端看到的效果一致。

用法：``python -m app.seed``
"""

from __future__ import annotations

import json
import random
import sqlite3
from typing import Any, Iterable

from .db import connect, init_schema, transaction
from .security import hash_password
from .utils import (
    SLA_HOURS,
    calc_deadlines,
    date_offset_text,
    hours_ago_text,
    is_overdue,
    now_text,
    plus_hours,
)

REGIONS = ["一号产业园", "二号产业园", "智能制造区", "研发综合楼", "仓储物流区"]
CATEGORIES = [
    "环境监控", "安防摄像头", "配电柜", "门禁闸机", "消防主机", "能耗计量", "照明控制",
]
VENDORS = ["海康威视", "大华股份", "西门子", "施耐德", "蓝卡科技", "宇视科技"]
# 状态权重贴近真实运维
DEV_STATUS = ["运行中", "运行中", "运行中", "运行中", "告警", "检修中", "已停用"]
# 多数工单最终闭环，少量处于各处理环节
ORDER_STATUS = [
    "PENDING", "PENDING", "PROCESSING", "CHECKING",
    "CLOSED", "CLOSED", "CLOSED", "CLOSED", "CLOSED", "CLOSED",
]
ORDER_TYPE = ["故障报修", "巡检任务", "保养计划", "改造施工"]
PRIORITY = ["高", "中", "低"]
ALARM_LEVEL = ["紧急", "重要", "次要", "提示"]

DEFAULT_PASSWORD = "123456"


def _pick(seq: Iterable[Any]) -> Any:
    return random.choice(list(seq))


def _days_ago(days: int) -> str:
    """距今天 n 天前的日期（东八区）"""
    return date_offset_text(-days)


def _rand_datetime(year_span_days: int) -> str:
    """近 n 天内的一个随机时间点（东八区）"""
    day = _days_ago(random.randint(0, max(year_span_days - 1, 0)))
    return f"{day} {random.randint(8, 17):02d}:{random.randint(0, 59):02d}:00"


# --------------------------------------------------------------------- 各表

def _reset(conn: sqlite3.Connection) -> None:
    # ⚠️ 多条语句必须用 executescript —— sqlite3 的 execute() 一次只允许一条语句
    # （better-sqlite3 的 db.exec 允许，Node 版这边不受影响）
    conn.executescript(
        """
        DELETE FROM logs; DELETE FROM wo_timeline; DELETE FROM work_orders;
        DELETE FROM alarms; DELETE FROM devices; DELETE FROM users;
        DELETE FROM menus; DELETE FROM dicts; DELETE FROM roles;
        DELETE FROM inspection_records; DELETE FROM inspection_tasks; DELETE FROM inspection_plans;
        DELETE FROM part_records; DELETE FROM parts;
        """
    )
    try:
        conn.executescript(
            """
            DELETE FROM sqlite_sequence WHERE name IN
            ('logs','wo_timeline','work_orders','alarms','devices','users','menus','dicts','roles',
             'inspection_records','inspection_tasks','inspection_plans','part_records','parts');
            """
        )
    except sqlite3.Error:
        # 首次建库时 sqlite_sequence 可能尚未生成，忽略即可
        pass


def _seed_roles_and_menus(conn: sqlite3.Connection) -> None:
    ts = now_text()
    conn.executemany(
        "INSERT INTO roles (name, code, data_scope, remark, created_at) VALUES (?,?,?,?,?)",
        [
            ("系统管理员", "admin", "ALL", "全部数据权限，可进系统管理", ts),
            ("运维主管", "manager", "REGION", "仅本区域数据，可派单与验收", ts),
            ("运维专员", "operator", "SELF", "仅本人相关数据，处理工单", ts),
        ],
    )

    tops = [
        ("首页看板", "/dashboard", "Dashboard", "analytics", "dashboard:view", 1),
        ("AI 助手", "/assistant", "Assistant", "sparkles", "assistant:view", 2),
        ("设备台账", "/device", "Device", "cube", "device:view", 3),
        ("巡检管理", "/inspection", "Inspection", "shield-check", "inspection:view", 4),
        ("工单中心", "/order", "Order", "clipboard", "order:view", 5),
        ("告警中心", "/alarm", "Alarm", "warning", "alarm:view", 6),
        ("备件库存", "/part", "Part", "box", "part:view", 7),
        ("报表中心", "/report", "Report", "stats", "report:view", 8),
        ("系统管理", "/system", "System", "settings", "system:view", 9),
    ]
    conn.executemany(
        "INSERT INTO menus (parent_id, title, path, component, icon, perm, sort, created_at)"
        " VALUES (0,?,?,?,?,?,?,?)",
        [(t, p, c, i, pm, s, ts) for t, p, c, i, pm, s in tops],
    )

    system_id = conn.execute("SELECT id FROM menus WHERE path = '/system'").fetchone()["id"]
    subs = [
        ("用户管理", "/system/user", "SystemUser", "person", "system:user", 1),
        ("角色权限", "/system/role", "SystemRole", "key", "system:role", 2),
        ("数据字典", "/system/dict", "SystemDict", "list", "system:dict", 3),
        ("操作日志", "/system/log", "SystemLog", "list", "system:log", 4),
    ]
    conn.executemany(
        "INSERT INTO menus (parent_id, title, path, component, icon, perm, sort, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        [(system_id, t, p, c, i, pm, s, ts) for t, p, c, i, pm, s in subs],
    )


def _seed_users(conn: sqlite3.Connection) -> None:
    ts = now_text()
    pwd = hash_password(DEFAULT_PASSWORD)
    rows = [
        # operator 的姓名必须是设备负责人之一，否则「仅本人相关」会查不到数据
        ("admin", pwd, "张管理", "13800000001", "admin", "全部区域", 1, ts),
        ("manager", pwd, "李主管", "13800000002", "manager", "一号产业园", 1, ts),
        ("operator", pwd, "孙磊", "13800000003", "operator", "一号产业园", 1, ts),
    ]
    names = ["赵伟", "钱芳", "孙磊", "李娜", "周强", "吴敏", "郑凯", "王超"]
    for i in range(16):
        rows.append((
            f"staff{i + 1}", pwd, names[i % len(names)],
            f"138{str(10000000 + i * 12345)[:8]}",
            "manager" if i % 5 == 0 else "operator",
            _pick(REGIONS), 1, ts,
        ))
    conn.executemany(
        "INSERT INTO users (username, password, real_name, phone, role_code, region, status, created_at)"
        " VALUES (?,?,?,?,?,?,?,?)",
        rows,
    )


def _seed_devices(conn: sqlite3.Connection, n: int = 200) -> None:
    ts = now_text()
    owners = ["赵伟", "钱芳", "孙磊", "李娜", "周强", "吴敏"]
    rows = []
    for i in range(1, n + 1):
        cat = _pick(CATEGORIES)
        cycle = _pick([30, 60, 90, 180])
        # 让一部分设备的保养日期落在过去 / 近期，用于演示「保养到期提醒」
        offset = random.randint(0, int(cycle * 1.4) - 1) - int(cycle * 0.5)
        rows.append((
            f"DEV-{i:04d}", f"{cat}-{i:03d}", cat, _pick(REGIONS), _pick(DEV_STATUS),
            _pick(VENDORS), _days_ago(random.randint(30, 929)), _pick(owners), "",
            cycle, date_offset_text(offset), ts,
        ))
    conn.executemany(
        "INSERT INTO devices (code, name, category, region, status, vendor, install_date,"
        " owner, remark, maintain_cycle, next_maintain_date, created_at)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )


def _seed_orders(conn: sqlite3.Connection, n: int = 500) -> None:
    creators = ["张管理", "李主管", "系统自动巡检"]
    handlers = ["王运维", "赵伟", "钱芳", "孙磊"]
    devices = [
        (r["code"], r["region"])
        for r in conn.execute("SELECT code, region FROM devices").fetchall()
    ]

    orders: list[tuple] = []
    timelines: list[tuple] = []
    for i in range(1, n + 1):
        dev_code, dev_region = _pick(devices)
        status = _pick(ORDER_STATUS)
        priority = _pick(PRIORITY)
        done = status in ("CLOSED", "CHECKING")

        # 已闭环的分散在近半年；未闭环的集中在近 20 小时内，贴合真实的待办积压形态
        if done:
            created_time = _rand_datetime(random.randint(0, 174) + 5)
        else:
            created_time = hours_ago_text(random.random() * 20)

        sla = SLA_HOURS[priority]
        response_deadline, resolve_deadline = calc_deadlines(priority, created_time)

        handler = "" if status == "PENDING" else _pick(handlers)
        # 约 1/4 的工单响应超出响应时限，用于演示响应时效预警
        if status == "PENDING":
            respond_hours = 0
        elif random.random() < 0.25:
            respond_hours = sla["respond"] + 1 + random.randint(0, 5)
        else:
            respond_hours = random.randint(1, sla["respond"])
        responded_at = "" if status == "PENDING" else plus_hours(created_time, respond_hours)
        overdue = is_overdue(status, resolve_deadline)

        code = f"WO{i:05d}"
        orders.append((
            code, f"{_pick(ORDER_TYPE)}：{dev_code} 异常处理", _pick(ORDER_TYPE),
            priority, status, dev_code, _pick(creators), handler, dev_region,
            response_deadline, resolve_deadline, responded_at, overdue,
            created_time, created_time,
        ))
        # 时间轴：用订单 code 反查 id 不方便，这里改为按插入顺序回填（见下方）
        timelines.append((code, status, done, created_time, handler, responded_at))

    conn.executemany(
        "INSERT INTO work_orders (code, title, type, priority, status, device_code, creator,"
        " handler, region, response_deadline, resolve_deadline, responded_at, overdue,"
        " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        orders,
    )

    id_by_code = {
        r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM work_orders").fetchall()
    }
    tl_rows: list[tuple] = []
    for code, status, done, created_time, handler, responded_at in timelines:
        oid = id_by_code[code]
        tl_rows.append((oid, "创建工单", _pick(creators), "系统自动建单", created_time))
        if status != "PENDING":
            tl_rows.append((oid, "受理派单", "李主管", f"指派给 {handler}", responded_at))
            tl_rows.append((oid, "开始处理", handler, "现场排查中", responded_at))
        if done:
            tl_rows.append((oid, "处理完成", handler, "已修复，待验收", plus_hours(responded_at, 4)))
        if status == "CLOSED":
            tl_rows.append((oid, "验收闭环", "李主管", "验收通过", plus_hours(responded_at, 8)))
    conn.executemany(
        "INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)",
        tl_rows,
    )


def _seed_alarms(conn: sqlite3.Connection, n: int = 1000) -> None:
    devices = [
        (r["code"], r["name"], r["region"])
        for r in conn.execute("SELECT code, name, region FROM devices").fetchall()
    ]
    contents = ["温度超过阈值", "通讯中断", "门禁异常开启", "电流波动告警", "视频信号丢失", "电量低于 10%"]
    rows = []
    for _ in range(n):
        code, name, region = _pick(devices)
        rows.append((
            code, name, _pick(ALARM_LEVEL), _pick(contents),
            "已处理" if random.random() > 0.35 else "未处理", region,
            _days_ago(random.randint(0, 89)),
        ))
    conn.executemany(
        "INSERT INTO alarms (device_code, device_name, level, content, status, region, created_at)"
        " VALUES (?,?,?,?,?,?,?)",
        rows,
    )


INSPECT_ITEMS: dict[str, list[str]] = {
    "环境监控": ["温湿度读数是否正常", "传感器有无漂移", "通讯链路是否稳定"],
    "安防摄像头": ["画面是否清晰", "云台转动是否顺畅", "录像存储是否完整"],
    "配电柜": ["指示灯与仪表状态", "接线端子有无松动", "柜内温度与异响"],
    "门禁闸机": ["刷卡识别是否正常", "闸机开合是否顺畅", "应急开门是否有效"],
    "消防主机": ["主机有无故障报修", "探测器是否在线", "联动测试是否通过"],
    "能耗计量": ["表计读数是否正常", "通讯是否在线", "数据有无跳变"],
    "照明控制": ["回路开关是否正常", "调光功能是否有效", "时控设置是否正确"],
}
INSPECT_PLANS = [
    ("一号产业园配电日常巡检", "一号产业园", "配电柜", "每日"),
    ("一号产业园安防周检", "一号产业园", "安防摄像头", "每周"),
    ("二号产业园环境巡检", "二号产业园", "环境监控", "每日"),
    ("智能制造区消防月检", "智能制造区", "消防主机", "每月"),
    ("研发综合楼门禁巡检", "研发综合楼", "门禁闸机", "每周"),
    ("仓储物流区能耗巡检", "仓储物流区", "能耗计量", "每月"),
    ("全域照明季度巡检", "仓储物流区", "照明控制", "每月"),
]
CYCLE_DAYS = {"每日": 1, "每周": 7, "每月": 30}
INSPECTORS = ["赵伟", "钱芳", "孙磊", "李娜", "周强", "吴敏"]
ABNORMAL_NOTES = ["读数超出阈值", "存在异响", "连接松动", "响应缓慢", "指示灯异常"]


def _seed_inspections(conn: sqlite3.Connection) -> None:
    ts = now_text()
    devices = [
        (r["code"], r["region"], r["category"])
        for r in conn.execute("SELECT code, region, category FROM devices").fetchall()
    ]
    records: list[tuple] = []

    for idx, (name, region, category, cycle) in enumerate(INSPECT_PLANS):
        items = INSPECT_ITEMS.get(category) or ["外观检查", "功能测试", "安全检查"]
        owner = INSPECTORS[idx % len(INSPECTORS)]
        cycle_days = CYCLE_DAYS[cycle]
        cur = conn.execute(
            "INSERT INTO inspection_plans (name, region, category, cycle, items, owner, status,"
            " next_date, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (name, region, category, cycle, json.dumps(items, ensure_ascii=False), owner, 1,
             _days_ago(-cycle_days), ts),
        )
        plan_id = cur.lastrowid
        rounds = 10 if cycle == "每日" else (6 if cycle == "每周" else 4)

        # 由远及近生成历史轮次，最后一轮留作「待执行」，制造真实的待办感
        for k in range(rounds, -1, -1):
            plan_date = _days_ago(k * cycle_days)
            pending = k == 0
            status = "PENDING" if pending else ("DONE" if random.random() > 0.1 else "PENDING")
            inspector = (
                "" if (pending and random.random() > 0.6)
                else INSPECTORS[(idx + k) % len(INSPECTORS)]
            )
            finished_at = (
                f"{plan_date} {random.randint(9, 16):02d}:30:00" if status == "DONE" else ""
            )

            # 该计划覆盖的设备（按区域 + 类型筛选，全域则不加区域条件）
            scope = [
                d for d in devices
                if d[2] == category and ("全域" in region or region == "全部区域" or d[1] == region)
            ]
            target = _pick(scope) if scope else _pick(devices)

            abnormal = 1 if (status == "DONE" and random.random() < 0.22) else 0
            task_cur = conn.execute(
                "INSERT INTO inspection_tasks (code, plan_id, plan_name, region, inspector, status,"
                " plan_date, finished_at, total, abnormal, created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (f"INS{plan_id:02d}{plan_date.replace('-', '')}", plan_id, name, region, inspector,
                 status, plan_date, finished_at, len(items), abnormal,
                 finished_at or f"{plan_date} 08:00:00"),
            )
            task_id = task_cur.lastrowid

            if status == "DONE":
                abnormal_idx = random.randrange(len(items)) if abnormal else -1
                for i, item in enumerate(items):
                    bad = i == abnormal_idx
                    records.append((
                        task_id, item, target[0], "异常" if bad else "正常",
                        _pick(ABNORMAL_NOTES) if bad else "", finished_at,
                    ))

    conn.executemany(
        "INSERT INTO inspection_records (task_id, item, device_code, result, note, created_at)"
        " VALUES (?,?,?,?,?,?)",
        records,
    )


PART_CATALOG = [
    ("电源适配器", "DC12V/2A", "个", 45), ("网络水晶头", "RJ45 超五类", "盒", 12),
    ("网线", "超五类 305m", "箱", 380), ("POE 交换机", "8 口千兆", "台", 680),
    ("监控硬盘", "监控级 4TB", "块", 620), ("摄像机支架", "壁装铝合金", "个", 35),
    ("门禁读卡器", "IC 13.56MHz", "台", 260), ("电插锁", "280kg 暗装", "把", 180),
    ("闸机翼门", "亚克力 600mm", "块", 420), ("蓄电池", "12V 7Ah", "节", 95),
    ("空气开关", "C63 2P", "个", 48), ("交流接触器", "AC220V 25A", "个", 130),
    ("接线端子", "UK-2.5B", "包", 26), ("温湿度传感器", "RS485 输出", "个", 210),
    ("烟感探测器", "独立式", "个", 68), ("声光报警器", "DC24V", "个", 85),
    ("应急照明灯", "双头 3h", "盏", 110), ("LED 灯管", "T8 18W", "支", 22),
    ("智能电表", "单相 RS485", "台", 320), ("网络测线仪", "带寻线", "台", 158),
]
PART_VENDORS = ["海康威视", "大华股份", "施耐德", "西门子", "宇视科技"]
PART_OPERATORS = ["赵伟", "钱芳", "孙磊", "李娜", "周强", "吴敏", "王运维"]


def _seed_parts(conn: sqlite3.Connection) -> None:
    orders = [
        r["code"] for r in
        conn.execute("SELECT code FROM work_orders ORDER BY id DESC LIMIT 200").fetchall()
    ]
    records: list[tuple] = []

    for i, (name, spec, unit, price) in enumerate(PART_CATALOG):
        safety = random.randint(1, 8) + 4
        # 约 1/4 的备件低于安全库存，用于演示库存预警
        low_stock = i % 4 == 1
        stock = random.randint(0, safety - 1) if low_stock else safety + random.randint(0, 39)
        code = f"PT-{i + 1:04d}"
        cur = conn.execute(
            "INSERT INTO parts (code, name, spec, unit, stock, safety_stock, price, vendor, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (code, name, spec, unit, stock, safety, price, _pick(PART_VENDORS),
             _days_ago(random.randint(20, 319))),
        )
        part_id = cur.lastrowid

        # 生成几条历史流水（倒推库存变化，保证流水与当前库存自洽）
        for t in range(random.randint(1, 4)):
            is_out = random.random() > 0.45
            qty = random.randint(1, 4)
            before = stock + qty if is_out else stock - qty
            if before < 0:
                continue
            records.append((
                part_id, code, name, "OUT" if is_out else "IN", qty,
                before if is_out else stock, stock if is_out else before,
                _pick(orders) if (is_out and random.random() > 0.5) else "",
                _pick(PART_OPERATORS), "工单领用" if is_out else "采购入库",
                _days_ago(random.randint(0, 89) + t),
            ))
            stock = before

    conn.executemany(
        "INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock,"
        " after_stock, order_code, operator, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        records,
    )


def _seed_dicts(conn: sqlite3.Connection) -> None:
    groups = [
        ("device_status", [("运行中", "RUNNING"), ("告警", "ALARM"), ("检修中", "MAINTAIN"), ("已停用", "OFF")]),
        ("device_category", [(c, f"CAT_{i}") for i, c in enumerate(CATEGORIES)]),
        ("alarm_level", [("紧急", "P1"), ("重要", "P2"), ("次要", "P3"), ("提示", "P4")]),
        ("order_priority", [("高", "HIGH"), ("中", "MID"), ("低", "LOW")]),
    ]
    rows = []
    sort = 0
    for dict_type, items in groups:
        for label, value in items:
            rows.append((dict_type, label, value, sort))
            sort += 1
    conn.executemany(
        "INSERT INTO dicts (type, label, value, sort) VALUES (?,?,?,?)", rows
    )


TABLES = [
    "roles", "menus", "users", "devices", "work_orders", "wo_timeline", "alarms",
    "inspection_plans", "inspection_tasks", "inspection_records",
    "parts", "part_records",
]


def run_seed(quiet: bool = False, conn: sqlite3.Connection | None = None) -> dict[str, int]:
    """生成全套演示数据（会先清空既有数据，幂等）"""
    own_conn = conn is None
    conn = conn or connect()
    try:
        if own_conn:
            init_schema(conn)

        # 清空必须放在事务之外：_reset 用的是 executescript，而
        # executescript 会先隐式提交当前事务，放进事务里会导致随后的 COMMIT 报
        # "cannot commit - no transaction is active"。
        _reset(conn)

        with transaction(conn):
            _seed_roles_and_menus(conn)
            _seed_users(conn)
            _seed_devices(conn, 200)
            _seed_orders(conn, 500)
            _seed_alarms(conn, 1000)
            _seed_inspections(conn)
            _seed_parts(conn)
            _seed_dicts(conn)

        stat = {t: conn.execute(f"SELECT COUNT(*) AS c FROM {t}").fetchone()["c"] for t in TABLES}
        stat["orders"] = stat["work_orders"]

        if not quiet:
            print("演示数据生成完成：")
            print(f"  角色 {stat['roles']} ｜ 菜单 {stat['menus']} ｜ 用户 {stat['users']}")
            print(
                f"  设备 {stat['devices']} ｜ 工单 {stat['work_orders']} ｜ "
                f"流转记录 {stat['wo_timeline']} ｜ 告警 {stat['alarms']}"
            )
            print(
                f"  巡检计划 {stat['inspection_plans']} ｜ 巡检任务 {stat['inspection_tasks']} ｜ "
                f"检查记录 {stat['inspection_records']}"
            )
            print(f"  备件 {stat['parts']} ｜ 出入库流水 {stat['part_records']}")
            print(
                f"  体验账号：admin/{DEFAULT_PASSWORD}（全部权限） "
                f"manager/{DEFAULT_PASSWORD}（区域权限） operator/{DEFAULT_PASSWORD}（个人权限）"
            )
        return stat
    finally:
        if own_conn:
            conn.close()


if __name__ == "__main__":
    run_seed()
