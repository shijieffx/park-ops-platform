import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db')

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')

/** 建表：幂等，可重复执行 */
export function initSchema() {
  db.exec(`
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

    /* ---------- 巡检管理 ---------- */

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

    /* ---------- 备件库存 ---------- */

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
  `)

  // 增量迁移：老库补列（CREATE TABLE IF NOT EXISTS 不会补字段）
  ensureColumn('devices', 'maintain_cycle', 'INTEGER NOT NULL DEFAULT 90')
  ensureColumn('devices', 'next_maintain_date', 'TEXT')
  ensureColumn('work_orders', 'response_deadline', 'TEXT')
  ensureColumn('work_orders', 'resolve_deadline', 'TEXT')
  ensureColumn('work_orders', 'responded_at', 'TEXT')
  ensureColumn('work_orders', 'overdue', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('part_records', 'order_code', 'TEXT')
}

/** 若表中缺列则补上（幂等，可重复执行） */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

initSchema()
