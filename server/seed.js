/**
 * 初始化演示数据。
 * 全部为脚本随机生成的模拟数据，不含有任何真实业务信息。
 * 用法：npm run seed
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { db } from './db.js'

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86400000)
  return d.toISOString().slice(0, 10)
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区']
const CATEGORIES = ['环境监控', '安防摄像头', '配电柜', '门禁闸机', '消防主机', '能耗计量', '照明控制']
const VENDORS = ['海康威视', '大华股份', '西门子', '施耐德', '蓝卡科技', '宇视科技']
const DEV_STATUS = ['运行中', '运行中', '运行中', '运行中', '告警', '检修中', '已停用']
const ORDER_STATUS = ['PENDING', 'PROCESSING', 'CHECKING', 'CLOSED']
const ORDER_TYPE = ['故障报修', '巡检任务', '保养计划', '改造施工']
const PRIORITY = ['高', '中', '低']
const ALARM_LEVEL = ['紧急', '重要', '次要', '提示']

function reset() {
  db.exec(`
    DELETE FROM logs; DELETE FROM wo_timeline; DELETE FROM work_orders;
    DELETE FROM alarms; DELETE FROM devices; DELETE FROM users;
    DELETE FROM menus; DELETE FROM dicts; DELETE FROM roles;
  `)
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN
    ('logs','wo_timeline','work_orders','alarms','devices','users','menus','dicts','roles')`)
}

function seedRolesAndMenus() {
  const insRole = db.prepare(
    'INSERT INTO roles (name, code, data_scope, remark, created_at) VALUES (?,?,?,?,?)'
  )
  insRole.run('系统管理员', 'admin', 'ALL', '全部数据权限，可进系统管理', now())
  insRole.run('运维主管', 'manager', 'REGION', '仅本区域数据，可派单与验收', now())
  insRole.run('运维专员', 'operator', 'SELF', '仅本人相关数据，处理工单', now())

  const insMenu = db.prepare(
    'INSERT INTO menus (parent_id, title, path, component, icon, perm, sort, created_at) VALUES (?,?,?,?,?,?,?,?)'
  )
  const tops = [
    ['首页看板', '/dashboard', 'Dashboard', 'analytics', 'dashboard:view', 1],
    ['设备台账', '/device', 'Device', 'cube', 'device:view', 2],
    ['工单中心', '/order', 'Order', 'clipboard', 'order:view', 3],
    ['告警中心', '/alarm', 'Alarm', 'warning', 'alarm:view', 4],
    ['报表中心', '/report', 'Report', 'stats', 'report:view', 5],
    ['系统管理', '/system', 'System', 'settings', 'system:view', 6]
  ]
  tops.forEach(([title, path, comp, icon, perm, sort]) =>
    insMenu.run(0, title, path, comp, icon, perm, sort, now())
  )
  const subs = [
    [6, '用户管理', '/system/user', 'SystemUser', 'person', 'system:user', 1],
    [6, '角色权限', '/system/role', 'SystemRole', 'key', 'system:role', 2],
    [6, '数据字典', '/system/dict', 'SystemDict', 'list', 'system:dict', 3]
  ]
  subs.forEach(([pid, title, path, comp, icon, perm, sort]) =>
    insMenu.run(pid, title, path, comp, icon, perm, sort, now())
  )
}

function seedUsers() {
  const pwd = bcrypt.hashSync('123456', 10)
  const ins = db.prepare(
    'INSERT INTO users (username, password, real_name, phone, role_code, region, status, created_at) VALUES (?,?,?,?,?,?,?,?)'
  )
  // operator 的姓名必须是设备负责人之一，否则「仅本人相关」会查不到数据
  ins.run('admin', pwd, '张管理', '13800000001', 'admin', '全部区域', 1, now())
  ins.run('manager', pwd, '李主管', '13800000002', 'manager', '一号产业园', 1, now())
  ins.run('operator', pwd, '孙磊', '13800000003', 'operator', '一号产业园', 1, now())

  const names = ['赵伟', '钱芳', '孙磊', '李娜', '周强', '吴敏', '郑凯', '王超']
  for (let i = 0; i < 16; i++) {
    ins.run(
      `staff${i + 1}`, pwd, names[i % names.length],
      `138${String(10000000 + i * 12345).slice(0, 8)}`,
      i % 5 === 0 ? 'manager' : 'operator',
      pick(REGIONS), 1, now()
    )
  }
}

function seedDevices(n = 200) {
  const ins = db.prepare(
    `INSERT INTO devices (code, name, category, region, status, vendor, install_date, owner, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  const owners = ['赵伟', '钱芳', '孙磊', '李娜', '周强', '吴敏']
  for (let i = 1; i <= n; i++) {
    const cat = pick(CATEGORIES)
    ins.run(
      `DEV-${String(i).padStart(4, '0')}`,
      `${cat}-${String(i).padStart(3, '0')}`,
      cat, pick(REGIONS), pick(DEV_STATUS), pick(VENDORS),
      daysAgo(Math.floor(Math.random() * 900) + 30),
      pick(owners), '', now()
    )
  }
}

function seedOrders(n = 500) {
  const insOrder = db.prepare(
    `INSERT INTO work_orders (code, title, type, priority, status, device_code, creator, handler, region, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  const insTl = db.prepare(
    'INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)'
  )
  const creators = ['张管理', '李主管', '系统自动巡检']
  const handlers = ['王运维', '赵伟', '钱芳', '孙磊', '']
  const devices = db.prepare('SELECT code, region FROM devices').all()

  for (let i = 1; i <= n; i++) {
    const dev = pick(devices)
    const status = pick(ORDER_STATUS)
    const created = daysAgo(Math.floor(Math.random() * 180))
    const handler = status === 'PENDING' ? '' : pick(handlers.filter(Boolean))
    const info = insOrder.run(
      `WO${String(i).padStart(5, '0')}`,
      `${pick(ORDER_TYPE)}：${dev.code} 异常处理`,
      pick(ORDER_TYPE), pick(PRIORITY), status, dev.code,
      pick(creators), handler, dev.region, created, created
    )
    const oid = info.lastInsertRowid
    insTl.run(oid, '创建工单', pick(creators), '系统自动建单', created)
    if (status !== 'PENDING') {
      insTl.run(oid, '受理派单', '李主管', `指派给 ${handler}`, created)
      insTl.run(oid, '开始处理', handler, '现场排查中', created)
    }
    if (status === 'CHECKING' || status === 'CLOSED') {
      insTl.run(oid, '处理完成', handler, '已修复，待验收', created)
    }
    if (status === 'CLOSED') {
      insTl.run(oid, '验收闭环', '李主管', '验收通过', created)
    }
  }
}

function seedAlarms(n = 1000) {
  const ins = db.prepare(
    'INSERT INTO alarms (device_code, device_name, level, content, status, region, created_at) VALUES (?,?,?,?,?,?,?)'
  )
  const devices = db.prepare('SELECT code, name, region FROM devices').all()
  const contents = ['温度超过阈值', '通讯中断', '门禁异常开启', '电流波动告警', '视频信号丢失', '电量低于 10%']
  for (let i = 0; i < n; i++) {
    const d = pick(devices)
    ins.run(d.code, d.name, pick(ALARM_LEVEL), pick(contents),
      Math.random() > 0.35 ? '已处理' : '未处理', d.region,
      daysAgo(Math.floor(Math.random() * 90)))
  }
}

function seedDicts() {
  const ins = db.prepare('INSERT INTO dicts (type, label, value, sort) VALUES (?,?,?,?)')
  const dict = {
    device_status: [['运行中', 'RUNNING'], ['告警', 'ALARM'], ['检修中', 'MAINTAIN'], ['已停用', 'OFF']],
    device_category: CATEGORIES.map((c, i) => [c, `CAT_${i}`]),
    alarm_level: [['紧急', 'P1'], ['重要', 'P2'], ['次要', 'P3'], ['提示', 'P4']],
    order_priority: [['高', 'HIGH'], ['中', 'MID'], ['低', 'LOW']]
  }
  let sort = 0
  for (const [type, items] of Object.entries(dict)) {
    items.forEach(([label, value]) => ins.run(type, label, value, sort++))
  }
}

/**
 * 生成全套演示数据（会先清空既有数据，幂等）
 * @param {boolean} quiet 静默模式，供服务启动时自动调用
 */
export function runSeed(quiet = false) {
  reset()
  seedRolesAndMenus()
  seedUsers()
  seedDevices(200)
  seedOrders(500)
  seedAlarms(1000)
  seedDicts()

  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const stat = {
    roles: count('roles'), menus: count('menus'), users: count('users'),
    devices: count('devices'), orders: count('work_orders'),
    timeline: count('wo_timeline'), alarms: count('alarms')
  }
  if (!quiet) {
    console.log('演示数据生成完成：')
    console.log(`  角色 ${stat.roles} ｜ 菜单 ${stat.menus} ｜ 用户 ${stat.users}`)
    console.log(`  设备 ${stat.devices} ｜ 工单 ${stat.orders} ｜ 流转记录 ${stat.timeline} ｜ 告警 ${stat.alarms}`)
    console.log('  体验账号：admin/123456（全部权限） manager/123456（区域权限） operator/123456（个人权限）')
  }
  return stat
}

// 作为命令行脚本直接执行时（npm run seed）才立即生成数据
const isCLI = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isCLI) runSeed()
