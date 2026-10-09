/**
 * 初始化演示数据。
 * 全部为脚本随机生成的模拟数据，不含有任何真实业务信息。
 * 用法：npm run seed
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { db } from './db.js'
import { nowText, dateOffsetText, hoursAgoText, plusHours } from './utils/time.js'
import { calcDeadlines, isOverdue, SLA_HOURS } from './utils/sla.js'

const now = nowText
/** 距今天 n 天前的日期（东八区）；传负数得到未来日期 */
const daysAgo = (n) => dateOffsetText(-n)
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区']
const CATEGORIES = ['环境监控', '安防摄像头', '配电柜', '门禁闸机', '消防主机', '能耗计量', '照明控制']
const VENDORS = ['海康威视', '大华股份', '西门子', '施耐德', '蓝卡科技', '宇视科技']
const DEV_STATUS = ['运行中', '运行中', '运行中', '运行中', '告警', '检修中', '已停用']
// 状态权重贴近真实运维：多数工单最终闭环，少量处于各处理环节
const ORDER_STATUS = ['PENDING', 'PENDING', 'PROCESSING', 'CHECKING',
  'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED']
const ORDER_TYPE = ['故障报修', '巡检任务', '保养计划', '改造施工']
const PRIORITY = ['高', '中', '低']
const ALARM_LEVEL = ['紧急', '重要', '次要', '提示']

function reset() {
  db.exec(`
    DELETE FROM logs; DELETE FROM wo_timeline; DELETE FROM work_orders;
    DELETE FROM alarms; DELETE FROM devices; DELETE FROM users;
    DELETE FROM menus; DELETE FROM dicts; DELETE FROM roles;
    DELETE FROM inspection_records; DELETE FROM inspection_tasks; DELETE FROM inspection_plans;
    DELETE FROM part_records; DELETE FROM parts;
  `)
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN
    ('logs','wo_timeline','work_orders','alarms','devices','users','menus','dicts','roles',
     'inspection_records','inspection_tasks','inspection_plans','part_records','parts')`)
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
    ['巡检管理', '/inspection', 'Inspection', 'shield-check', 'inspection:view', 3],
    ['工单中心', '/order', 'Order', 'clipboard', 'order:view', 4],
    ['告警中心', '/alarm', 'Alarm', 'warning', 'alarm:view', 5],
    ['备件库存', '/part', 'Part', 'box', 'part:view', 6],
    ['报表中心', '/report', 'Report', 'stats', 'report:view', 7],
    ['系统管理', '/system', 'System', 'settings', 'system:view', 8]
  ]
  tops.forEach(([title, path, comp, icon, perm, sort]) =>
    insMenu.run(0, title, path, comp, icon, perm, sort, now())
  )
  const systemId = db.prepare("SELECT id FROM menus WHERE path = '/system'").get().id
  const subs = [
    [systemId, '用户管理', '/system/user', 'SystemUser', 'person', 'system:user', 1],
    [systemId, '角色权限', '/system/role', 'SystemRole', 'key', 'system:role', 2],
    [systemId, '数据字典', '/system/dict', 'SystemDict', 'list', 'system:dict', 3],
    [systemId, '操作日志', '/system/log', 'SystemLog', 'list', 'system:log', 4]
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
    `INSERT INTO devices (code, name, category, region, status, vendor, install_date, owner, remark,
                          maintain_cycle, next_maintain_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  const owners = ['赵伟', '钱芳', '孙磊', '李娜', '周强', '吴敏']
  for (let i = 1; i <= n; i++) {
    const cat = pick(CATEGORIES)
    const cycle = pick([30, 60, 90, 180])
    // 让一部分设备的保养日期落在过去 / 近期，用于演示「保养到期提醒」
    const offset = Math.floor(Math.random() * (cycle * 1.4)) - Math.floor(cycle * 0.5)
    ins.run(
      `DEV-${String(i).padStart(4, '0')}`,
      `${cat}-${String(i).padStart(3, '0')}`,
      cat, pick(REGIONS), pick(DEV_STATUS), pick(VENDORS),
      daysAgo(Math.floor(Math.random() * 900) + 30),
      pick(owners), '', cycle, daysAgo(-offset), now()
    )
  }
}

/* SLA 时限与时间计算已抽到 utils/sla.js 与 utils/time.js，避免多处实现不一致 */

function seedOrders(n = 500) {
  const insOrder = db.prepare(
    `INSERT INTO work_orders (code, title, type, priority, status, device_code, creator, handler, region,
                              response_deadline, resolve_deadline, responded_at, overdue, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    const priority = pick(PRIORITY)
    const done = status === 'CLOSED' || status === 'CHECKING'
    // 已闭环的分散在近半年；未闭环的集中在近 24 小时内，贴合真实的待办积压形态
    const createdTime = done
      ? `${daysAgo(Math.floor(Math.random() * 175) + 5)} ` +
        `${String(8 + Math.floor(Math.random() * 10)).padStart(2, '0')}:` +
        `${String(Math.floor(Math.random() * 60)).padStart(2, '0')}:00`
      : hoursAgoText(Math.random() * 20)

    const sla = SLA_HOURS[priority]
    const { responseDeadline, resolveDeadline } = calcDeadlines(priority, createdTime)
    const handler = status === 'PENDING' ? '' : pick(handlers.filter(Boolean))
    // 约 1/4 的工单响应超出响应时限，用于演示响应时效预警
    const respondHours = status === 'PENDING'
      ? 0
      : (Math.random() < 0.25
        ? sla.respond + 1 + Math.floor(Math.random() * 6)
        : Math.floor(Math.random() * sla.respond) + 1)
    const respondedAt = status === 'PENDING' ? '' : plusHours(createdTime, respondHours)
    const overdue = isOverdue(status, resolveDeadline)

    const info = insOrder.run(
      `WO${String(i).padStart(5, '0')}`,
      `${pick(ORDER_TYPE)}：${dev.code} 异常处理`,
      pick(ORDER_TYPE), priority, status, dev.code,
      pick(creators), handler, dev.region,
      responseDeadline, resolveDeadline, respondedAt, overdue, createdTime, createdTime
    )
    const oid = info.lastInsertRowid
    insTl.run(oid, '创建工单', pick(creators), '系统自动建单', createdTime)
    if (status !== 'PENDING') {
      insTl.run(oid, '受理派单', '李主管', `指派给 ${handler}`, respondedAt)
      insTl.run(oid, '开始处理', handler, '现场排查中', respondedAt)
    }
    if (done) {
      insTl.run(oid, '处理完成', handler, '已修复，待验收', plusHours(respondedAt, 4))
    }
    if (status === 'CLOSED') {
      insTl.run(oid, '验收闭环', '李主管', '验收通过', plusHours(respondedAt, 8))
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

/** 巡检计划 / 任务 / 检查记录 */
function seedInspections() {
  const insPlan = db.prepare(
    `INSERT INTO inspection_plans (name, region, category, cycle, items, owner, status, next_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  const insTask = db.prepare(
    `INSERT INTO inspection_tasks (code, plan_id, plan_name, region, inspector, status, plan_date,
                                   finished_at, total, abnormal, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  const insRec = db.prepare(
    'INSERT INTO inspection_records (task_id, item, device_code, result, note, created_at) VALUES (?,?,?,?,?,?)'
  )

  const ITEMS = {
    环境监控: ['温湿度读数是否正常', '传感器有无漂移', '通讯链路是否稳定'],
    安防摄像头: ['画面是否清晰', '云台转动是否顺畅', '录像存储是否完整'],
    配电柜: ['指示灯与仪表状态', '接线端子有无松动', '柜内温度与异响'],
    门禁闸机: ['刷卡识别是否正常', '闸机开合是否顺畅', '应急开门是否有效'],
    消防主机: ['主机有无故障报修', '探测器是否在线', '联动测试是否通过'],
    能耗计量: ['表计读数是否正常', '通讯是否在线', '数据有无跳变'],
    照明控制: ['回路开关是否正常', '调光功能是否有效', '时控设置是否正确']
  }
  const PLANS = [
    ['一号产业园配电日常巡检', '一号产业园', '配电柜', '每日'],
    ['一号产业园安防周检', '一号产业园', '安防摄像头', '每周'],
    ['二号产业园环境巡检', '二号产业园', '环境监控', '每日'],
    ['智能制造区消防月检', '智能制造区', '消防主机', '每月'],
    ['研发综合楼门禁巡检', '研发综合楼', '门禁闸机', '每周'],
    ['仓储物流区能耗巡检', '仓储物流区', '能耗计量', '每月'],
    ['全域照明季度巡检', '仓储物流区', '照明控制', '每月']
  ]
  const CYCLE_DAYS = { 每日: 1, 每周: 7, 每月: 30 }
  const INSPECTORS = ['赵伟', '钱芳', '孙磊', '李娜', '周强', '吴敏']
  const devices = db.prepare('SELECT code, name, region, category FROM devices').all()

  PLANS.forEach(([name, region, category, cycle], idx) => {
    const items = ITEMS[category] || ['外观检查', '功能测试', '安全检查']
    const owner = INSPECTORS[idx % INSPECTORS.length]
    const cycleDays = CYCLE_DAYS[cycle]
    const planInfo = insPlan.run(
      name, region, category, cycle, JSON.stringify(items), owner, 1,
      daysAgo(-cycleDays), now()
    )
    const planId = planInfo.lastInsertRowid
    const rounds = cycle === '每日' ? 10 : cycle === '每周' ? 6 : 4

    // 由远及近生成历史轮次，最后一轮留作「待执行」，制造真实的待办感
    for (let k = rounds; k >= 0; k--) {
      const planDate = daysAgo(k * cycleDays)
      const pending = k === 0
      const status = pending ? 'PENDING' : (Math.random() > 0.1 ? 'DONE' : 'PENDING')
      const inspector = pending && Math.random() > 0.6 ? '' : INSPECTORS[(idx + k) % INSPECTORS.length]
      const finishedAt = status === 'DONE'
        ? `${planDate} ${String(9 + Math.floor(Math.random() * 8)).padStart(2, '0')}:30:00`
        : ''

      // 该计划覆盖的设备（按区域 + 类型筛选，全部区域则不加区域条件）
      const scope = devices.filter((d) =>
        d.category === category && (region.includes('全域') || region === '全部区域' || d.region === region))
      const target = scope.length ? pick(scope) : pick(devices)

      const abnormal = status === 'DONE' && Math.random() < 0.22 ? 1 : 0
      const total = items.length
      const taskInfo = insTask.run(
        `INS${String(planId).padStart(2, '0')}${planDate.replace(/-/g, '')}`,
        planId, name, region, inspector, status, planDate,
        finishedAt, total, abnormal, finishedAt || `${planDate} 08:00:00`
      )
      const taskId = taskInfo.lastInsertRowid

      if (status === 'DONE') {
        const abnormalIdx = abnormal ? Math.floor(Math.random() * items.length) : -1
        items.forEach((item, i) => {
          const bad = i === abnormalIdx
          insRec.run(
            taskId, item, target.code, bad ? '异常' : '正常',
            bad ? pick(['读数超出阈值', '存在异响', '连接松动', '响应缓慢', '指示灯异常']) : '',
            finishedAt
          )
        })
      }
    }
  })
}

/** 备件台账与出入库流水 */
function seedParts() {
  const insPart = db.prepare(
    `INSERT INTO parts (code, name, spec, unit, stock, safety_stock, price, vendor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  )
  const insRec = db.prepare(
    `INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock, after_stock,
                               order_code, operator, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  const CATALOG = [
    ['电源适配器', 'DC12V/2A', '个', 45], ['网络水晶头', 'RJ45 超五类', '盒', 12],
    ['网线', '超五类 305m', '箱', 380], ['POE 交换机', '8 口千兆', '台', 680],
    ['监控硬盘', '监控级 4TB', '块', 620], ['摄像机支架', '壁装铝合金', '个', 35],
    ['门禁读卡器', 'IC 13.56MHz', '台', 260], ['电插锁', '280kg 暗装', '把', 180],
    ['闸机翼门', '亚克力 600mm', '块', 420], ['蓄电池', '12V 7Ah', '节', 95],
    ['空气开关', 'C63 2P', '个', 48], ['交流接触器', 'AC220V 25A', '个', 130],
    ['接线端子', 'UK-2.5B', '包', 26], ['温湿度传感器', 'RS485 输出', '个', 210],
    ['烟感探测器', '独立式', '个', 68], ['声光报警器', 'DC24V', '个', 85],
    ['应急照明灯', '双头 3h', '盏', 110], ['LED 灯管', 'T8 18W', '支', 22],
    ['智能电表', '单相 RS485', '台', 320], ['网络测线仪', '带寻线', '台', 158]
  ]
  const VENDOR_LIST = ['海康威视', '大华股份', '施耐德', '西门子', '宇视科技']
  const OPERATORS = ['赵伟', '钱芳', '孙磊', '李娜', '周强', '吴敏', '王运维']
  const orders = db.prepare('SELECT code FROM work_orders ORDER BY id DESC LIMIT 200').all()

  CATALOG.forEach(([name, spec, unit, price], i) => {
    const safety = Math.ceil(Math.random() * 8) + 4
    // 约 1/4 的备件低于安全库存，用于演示库存预警
    const lowStock = i % 4 === 1
    const stock = lowStock ? Math.floor(Math.random() * safety) : safety + Math.floor(Math.random() * 40)
    const code = `PT-${String(i + 1).padStart(4, '0')}`
    const info = insPart.run(
      code, name, spec, unit, stock, safety, price, pick(VENDOR_LIST),
      daysAgo(Math.floor(Math.random() * 300) + 20)
    )
    const partId = info.lastInsertRowid

    // 生成几条历史流水（倒推库存变化，保证流水与当前库存自洽）
    const times = Math.floor(Math.random() * 4) + 1
    let running = stock
    for (let t = 0; t < times; t++) {
      const isOut = Math.random() > 0.45
      const qty = Math.floor(Math.random() * 4) + 1
      const before = isOut ? running + qty : running - qty
      if (before < 0) continue
      insRec.run(
        partId, code, name, isOut ? 'OUT' : 'IN', qty,
        isOut ? before : running, isOut ? running : before,
        isOut && Math.random() > 0.5 ? pick(orders).code : '',
        pick(OPERATORS), isOut ? '工单领用' : '采购入库',
        daysAgo(Math.floor(Math.random() * 90) + t)
      )
      running = before
    }
  })
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
  seedInspections()
  seedParts()
  seedDicts()

  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const stat = {
    roles: count('roles'), menus: count('menus'), users: count('users'),
    devices: count('devices'), orders: count('work_orders'),
    timeline: count('wo_timeline'), alarms: count('alarms'),
    plans: count('inspection_plans'), tasks: count('inspection_tasks'),
    records: count('inspection_records'), parts: count('parts'), partRecords: count('part_records')
  }
  if (!quiet) {
    console.log('演示数据生成完成：')
    console.log(`  角色 ${stat.roles} ｜ 菜单 ${stat.menus} ｜ 用户 ${stat.users}`)
    console.log(`  设备 ${stat.devices} ｜ 工单 ${stat.orders} ｜ 流转记录 ${stat.timeline} ｜ 告警 ${stat.alarms}`)
    console.log(`  巡检计划 ${stat.plans} ｜ 巡检任务 ${stat.tasks} ｜ 检查记录 ${stat.records}`)
    console.log(`  备件 ${stat.parts} ｜ 出入库流水 ${stat.partRecords}`)
    console.log('  体验账号：admin/123456（全部权限） manager/123456（区域权限） operator/123456（个人权限）')
  }
  return stat
}

// 作为命令行脚本直接执行时（npm run seed）才立即生成数据
const isCLI = process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isCLI) runSeed()
