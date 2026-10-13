"""
数据库层：连接、建表 DDL、增量列迁移、启动自举。

设计要点
--------
1. **与 Node 版共用同一个 SQLite 文件**（默认 ``server/data.db``）：
   两套后端读写同一份数据，切换后端不需要任何迁移。
2. **连接按请求创建**：SQLite 连接很轻，配合 WAL 模式可以并发读；
   写操作设置 5 秒 busy timeout，避免与 Node 版同时写时立刻报 database is locked。
3. **DDL 与 Node 版逐字对齐**：两套后端都会执行同一份建表语句，
   因此无论先启动谁，表结构都一致。
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from .config import DB_PATH

# 建表语句：幂等，可重复执行（与 server/db.js 保持一致）
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  data_scope TEXT NOT NULL DEFAULT 'ALL',
  remark TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  path TEXT,
  component TEXT,
  icon TEXT,
  perm TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  real_name TEXT NOT NULL,
  phone TEXT,
  role_code TEXT NOT NULL,
  region TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  region TEXT NOT NULL,
  status TEXT NOT NULL,
  vendor TEXT,
  install_date TEXT,
  owner TEXT,
  remark TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  priority TEXT NOT NULL,
  status TEXT NOT NULL,
  device_code TEXT,
  creator TEXT NOT NULL,
  handler TEXT,
  region TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS wo_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  operator TEXT NOT NULL,
  note TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS alarms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_code TEXT NOT NULL,
  device_name TEXT,
  level TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  region TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS dicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  value TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action TEXT,
  detail TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS inspection_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  category TEXT,
  cycle TEXT NOT NULL,
  items TEXT NOT NULL,
  owner TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  next_date TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS inspection_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  plan_id INTEGER NOT NULL,
  plan_name TEXT,
  region TEXT,
  inspector TEXT,
  status TEXT NOT NULL,
  plan_date TEXT,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  abnormal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS inspection_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  item TEXT NOT NULL,
  device_code TEXT,
  result TEXT NOT NULL,
  note TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT NOT NULL DEFAULT '个',
  stock INTEGER NOT NULL DEFAULT 0,
  safety_stock INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  vendor TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS part_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  part_id INTEGER NOT NULL,
  part_code TEXT,
  part_name TEXT,
  type TEXT NOT NULL,
  qty INTEGER NOT NULL,
  before_stock INTEGER,
  after_stock INTEGER,
  order_code TEXT,
  operator TEXT,
  note TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_region ON devices(region);
CREATE INDEX IF NOT EXISTS idx_orders_status ON work_orders(status);
CREATE INDEX IF NOT EXISTS idx_alarms_level ON alarms(level);
CREATE INDEX IF NOT EXISTS idx_task_status ON inspection_tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_region ON inspection_tasks(region);
CREATE INDEX IF NOT EXISTS idx_part_code ON parts(code);
"""

# 增量迁移：老库补列（CREATE TABLE IF NOT EXISTS 不会补字段）
MIGRATIONS: list[tuple[str, str, str]] = [
    ("devices", "maintain_cycle", "INTEGER NOT NULL DEFAULT 90"),
    ("devices", "next_maintain_date", "TEXT"),
    ("work_orders", "response_deadline", "TEXT"),
    ("work_orders", "resolve_deadline", "TEXT"),
    ("work_orders", "responded_at", "TEXT"),
    ("work_orders", "overdue", "INTEGER NOT NULL DEFAULT 0"),
    ("part_records", "order_code", "TEXT"),
]


def connect() -> sqlite3.Connection:
    """
    新建一个数据库连接（自动提交模式，事务由 ``transaction()`` 显式包裹）。

    ``check_same_thread=False`` 是必须的：FastAPI 会把同步端点丢进线程池执行，
    「创建连接的线程」与「执行接口的线程」不保证是同一个
    （顺序请求时恰好复用同一线程，所以本地顺手跑一遍不一定能发现，并发请求下必然报
    "SQLite objects created in a thread can only be used in that same thread"）。

    安全前提：连接是**按请求创建**的，不会在多个请求之间共享，
    因此不存在同一连接被两个线程同时使用的情况。
    """
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(
        str(DB_PATH), timeout=5.0, isolation_level=None, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """显式事务：异常时回滚（对齐 better-sqlite3 的 db.transaction 语义）"""
    conn.execute("BEGIN")
    try:
        yield conn
    except Exception:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_schema(conn: sqlite3.Connection | None = None) -> None:
    """建表 + 增量补列（幂等）"""
    own = conn is None
    conn = conn or connect()
    try:
        conn.executescript(SCHEMA_SQL)
        for table, column, definition in MIGRATIONS:
            _ensure_column(conn, table, column, definition)
    finally:
        if own:
            conn.close()


def ensure_seed_data(verbose: bool = True) -> dict[str, int] | None:
    """
    启动自举：库为空则自动生成演示数据。

    目的：部署到服务器 / 容器后开箱即用 —— 数据卷被清空、或首次拉起时，
    不需要人工再执行一次初始化脚本。
    """
    from .seed import run_seed  # 延迟导入，避免循环依赖

    conn = connect()
    try:
        try:
            users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        except sqlite3.Error as exc:
            if verbose:
                print(f"[bootstrap] 读取用户表失败：{exc}")
            return None

        if users > 0:
            if verbose:
                print(f"[bootstrap] 已有数据（用户 {users} 个），跳过初始化")
            return None

        if verbose:
            print("[bootstrap] 数据库为空，正在生成演示数据…")
        stat = run_seed(quiet=True, conn=conn)
        if verbose:
            print(
                f"[bootstrap] 演示数据就绪：设备 {stat['devices']} ｜ "
                f"工单 {stat['orders']} ｜ 告警 {stat['alarms']}"
            )
        return stat
    finally:
        conn.close()


def db_file() -> Path:
    return DB_PATH
