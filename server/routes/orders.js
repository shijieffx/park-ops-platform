import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, scopeFilter, findVisible, writeLog } from '../middleware/auth.js'
import { parsePaging, toKeyword } from '../utils/validate.js'
import { calcDeadlines, nowText, isOverdue, hoursLeft } from '../utils/sla.js'

const router = Router()
const now = nowText

/** 状态机：定义允许的流转 */
const FLOW = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['CHECKING'],
  CHECKING: ['CLOSED', 'PROCESSING'],
  CLOSED: []
}
const STATUS_TEXT = { PENDING: '待受理', PROCESSING: '处理中', CHECKING: '待验收', CLOSED: '已闭环' }

const FIELDS = `id, code, title, type, priority, status, device_code, creator, handler, region,
                response_deadline, resolve_deadline, responded_at, created_at, updated_at`

/** 列表 —— GET /api/orders */
router.get('/', authRequired, (req, res) => {
  const { status = '', type = '', priority = '', overdue: onlyOverdue = '' } = req.query
  const keyword = toKeyword(req.query.keyword)
  const { page, pageSize, offset } = parsePaging(req.query)
  const sc = scopeFilter('work_orders', req.user)
  const where = [sc.sql]
  const params = [...sc.params]
  if (status) { where.push('status = ?'); params.push(status) }
  if (type) { where.push('type = ?'); params.push(type) }
  if (priority) { where.push('priority = ?'); params.push(priority) }
  if (keyword) { where.push('(code LIKE ? OR title LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }

  const ts = nowText()
  // 超时筛选口径与看板保持一致：未闭环 且 已过处理时限
  if (onlyOverdue === '1') {
    where.push("status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?")
    params.push(ts)
  }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT ${FIELDS} FROM work_orders WHERE ${cond}
     ORDER BY CASE WHEN status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ? THEN 0 ELSE 1 END,
              id DESC LIMIT ? OFFSET ?`
  ).all(...params, ts, pageSize, offset)

  res.json({
    code: 0,
    data: {
      // overdue / 剩余时限实时计算：库里的标记会随时间失真
      list: rows.map((r) => ({
        ...r,
        overdue: isOverdue(r.status, r.resolve_deadline, ts),
        hoursLeft: hoursLeft(r.resolve_deadline, ts)
      })),
      total, page, pageSize
    }
  })
})

/** 详情（含流转时间轴）—— GET /api/orders/:id */
router.get('/:id', authRequired, (req, res) => {
  const order = findVisible('work_orders', req.params.id, req.user, FIELDS)
  if (!order) return res.status(404).json({ code: 404, message: '工单不存在或无权访问' })
  const timeline = db.prepare(
    'SELECT id, action, operator, note, created_at FROM wo_timeline WHERE order_id = ? ORDER BY id ASC'
  ).all(req.params.id)
  // 该工单已领用的备件（与备件模块联动）
  const partsUsed = db.prepare(
    `SELECT part_code, part_name, qty, operator, created_at FROM part_records
     WHERE order_code = ? AND type = 'OUT' ORDER BY id ASC`
  ).all(order.code)
  const ts = nowText()
  res.json({
    code: 0,
    data: {
      ...order,
      statusText: STATUS_TEXT[order.status],
      overdue: isOverdue(order.status, order.resolve_deadline, ts),
      hoursLeft: hoursLeft(order.resolve_deadline, ts),
      timeline,
      partsUsed
    }
  })
})

/** 新建工单 —— POST /api/orders */
router.post('/', authRequired, permit('order:edit'), (req, res) => {
  const d = req.body || {}
  if (!d.title) return res.status(400).json({ code: 400, message: '工单标题必填' })
  const seq = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c + 1
  const code = `WO${String(seq).padStart(5, '0')}`
  const ts = now()
  const priority = d.priority || '中'
  const { responseDeadline, resolveDeadline } = calcDeadlines(priority, ts)
  const info = db.prepare(
    `INSERT INTO work_orders (code, title, type, priority, status, device_code, creator, handler, region,
                              response_deadline, resolve_deadline, responded_at, overdue, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(code, d.title, d.type || '故障报修', priority, 'PENDING',
    d.deviceCode || '', req.user.real_name, '', d.region || '',
    responseDeadline, resolveDeadline, '', 0, ts, ts)
  db.prepare('INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)')
    .run(info.lastInsertRowid, '创建工单', req.user.real_name, d.remark || '', ts)
  writeLog(req.user.username, '工单创建', `创建工单 ${code}`)
  res.json({ code: 0, message: '创建成功', data: { id: info.lastInsertRowid, code } })
})

/**
 * 状态流转 —— POST /api/orders/:id/flow
 * body: { to: 'PROCESSING'|'CHECKING'|'CLOSED', handler?, note? }
 */
router.post('/:id/flow', authRequired, permit('order:edit'), (req, res) => {
  const { to, handler, note } = req.body || {}
  const order = findVisible('work_orders', req.params.id, req.user, '*')
  if (!order) return res.status(404).json({ code: 404, message: '工单不存在或无权访问' })
  if (!FLOW[order.status]?.includes(to)) {
    return res.status(400).json({
      code: 400,
      message: `不允许从「${STATUS_TEXT[order.status]}」流转到「${STATUS_TEXT[to] || to}」`
    })
  }
  const ts = nowText()
  const actionText = {
    PROCESSING: '受理派单', CHECKING: '处理完成', CLOSED: '验收闭环'
  }[to]
  // 首次受理即记录响应时间，用于统计响应时效
  const respondedAt = order.responded_at || ts
  db.prepare('UPDATE work_orders SET status=?, handler=?, responded_at=?, updated_at=? WHERE id=?')
    .run(to, handler || order.handler || req.user.real_name, respondedAt, ts, req.params.id)
  db.prepare('INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)')
    .run(req.params.id, actionText, req.user.real_name, note || '', ts)
  writeLog(req.user.username, '工单流转', `${order.code} → ${STATUS_TEXT[to]}`)
  res.json({ code: 0, message: `已流转至「${STATUS_TEXT[to]}」` })
})

/**
 * 派单 / 转派 —— POST /api/orders/:id/assign
 * body: { handler, note }
 * 首次指派即为「派单」并记录响应时间；已有处理人时改派记为「转派」
 */
router.post('/:id/assign', authRequired, permit('order:edit'), (req, res) => {
  const order = findVisible('work_orders', req.params.id, req.user, '*')
  if (!order) return res.status(404).json({ code: 404, message: '工单不存在或无权访问' })
  if (order.status === 'CLOSED') {
    return res.status(400).json({ code: 400, message: '已闭环的工单不能派单' })
  }

  const { handler, note } = req.body || {}
  if (!handler) return res.status(400).json({ code: 400, message: '请指定处理人' })
  const staff = db.prepare('SELECT real_name FROM users WHERE real_name = ? AND status = 1').get(handler)
  if (!staff) return res.status(400).json({ code: 400, message: '处理人不存在或账号已停用' })

  const ts = nowText()
  const isTransfer = !!order.handler && order.handler !== handler
  db.prepare('UPDATE work_orders SET handler = ?, responded_at = ?, updated_at = ? WHERE id = ?')
    .run(handler, order.responded_at || ts, ts, order.id)
  db.prepare(
    'INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)'
  ).run(order.id, isTransfer ? '转派' : '派单', req.user.real_name,
    `指派给 ${handler}${note ? '：' + note : ''}`, ts)
  writeLog(req.user.username, '工单派单', `${order.code} → ${handler}`)

  res.json({ code: 0, message: isTransfer ? `已转派给 ${handler}` : `已派单给 ${handler}` })
})

/**
 * SLA 时效统计 —— GET /api/orders/stats/sla
 */
router.get('/stats/sla', authRequired, (req, res) => {
  const sc = scopeFilter('work_orders', req.user)
  const ts = nowText()
  const one = (sql, ...p) => db.prepare(sql).get(...p).c

  const overdue = db.prepare(
    `SELECT COUNT(*) c FROM work_orders
     WHERE ${sc.sql} AND status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?`
  ).get(...sc.params, ts).c
  const responseOverdue = db.prepare(
    `SELECT COUNT(*) c FROM work_orders
     WHERE ${sc.sql} AND responded_at != '' AND response_deadline != '' AND responded_at > response_deadline`
  ).get(...sc.params).c
  const openTotal = one(`SELECT COUNT(*) c FROM work_orders WHERE ${sc.sql} AND status != 'CLOSED'`)
  const pending = one(`SELECT COUNT(*) c FROM work_orders WHERE ${sc.sql} AND status = 'PENDING'`)
  const processing = one(`SELECT COUNT(*) c FROM work_orders WHERE ${sc.sql} AND status = 'PROCESSING'`)

  const byPriority = db.prepare(
    `SELECT priority AS name, COUNT(*) AS value FROM work_orders
     WHERE ${sc.sql} AND status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?
     GROUP BY priority`
  ).all(...sc.params, ts)

  res.json({
    code: 0,
    data: {
      overdue, responseOverdue, openTotal, pending, processing,
      onTimeRate: openTotal ? Math.round(((openTotal - overdue) / openTotal) * 1000) / 10 : 100,
      byPriority
    }
  })
})

/** 状态分布统计 —— GET /api/orders/stats */
router.get('/stats/summary', authRequired, (req, res) => {
  const sc = scopeFilter('work_orders', req.user)
  const rows = db.prepare(
    `SELECT status, COUNT(*) c FROM work_orders WHERE ${sc.sql} GROUP BY status`
  ).all(...sc.params)
  const data = Object.keys(STATUS_TEXT).map((s) => ({
    name: STATUS_TEXT[s],
    value: rows.find((r) => r.status === s)?.c || 0
  }))
  res.json({ code: 0, data })
})

export default router
