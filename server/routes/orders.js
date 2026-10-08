import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, scopeFilter, writeLog } from '../middleware/auth.js'

const router = Router()
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** 状态机：定义允许的流转 */
const FLOW = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['CHECKING'],
  CHECKING: ['CLOSED', 'PROCESSING'],
  CLOSED: []
}
const STATUS_TEXT = { PENDING: '待受理', PROCESSING: '处理中', CHECKING: '待验收', CLOSED: '已闭环' }

const FIELDS = 'id, code, title, type, priority, status, device_code, creator, handler, region, created_at, updated_at'

/** 列表 —— GET /api/orders */
router.get('/', authRequired, (req, res) => {
  const { status = '', type = '', priority = '', keyword = '', page = 1, pageSize = 20 } = req.query
  const sc = scopeFilter('work_orders', req.user)
  const where = [sc.sql]
  const params = [...sc.params]
  if (status) { where.push('status = ?'); params.push(status) }
  if (type) { where.push('type = ?'); params.push(type) }
  if (priority) { where.push('priority = ?'); params.push(priority) }
  if (keyword) { where.push('(code LIKE ? OR title LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM work_orders WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT ${FIELDS} FROM work_orders WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize))
  res.json({ code: 0, data: { list: rows, total, page: Number(page), pageSize: Number(pageSize) } })
})

/** 详情（含流转时间轴）—— GET /api/orders/:id */
router.get('/:id', authRequired, (req, res) => {
  const order = db.prepare(`SELECT ${FIELDS} FROM work_orders WHERE id = ?`).get(req.params.id)
  if (!order) return res.status(404).json({ code: 404, message: '工单不存在' })
  const timeline = db.prepare(
    'SELECT id, action, operator, note, created_at FROM wo_timeline WHERE order_id = ? ORDER BY id ASC'
  ).all(req.params.id)
  res.json({ code: 0, data: { ...order, statusText: STATUS_TEXT[order.status], timeline } })
})

/** 新建工单 —— POST /api/orders */
router.post('/', authRequired, permit('order:edit'), (req, res) => {
  const d = req.body || {}
  if (!d.title) return res.status(400).json({ code: 400, message: '工单标题必填' })
  const seq = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c + 1
  const code = `WO${String(seq).padStart(5, '0')}`
  const ts = now()
  const info = db.prepare(
    `INSERT INTO work_orders (code, title, type, priority, status, device_code, creator, handler, region, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(code, d.title, d.type || '故障报修', d.priority || '中', 'PENDING',
    d.deviceCode || '', req.user.real_name, '', d.region || '', ts, ts)
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
  const order = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(req.params.id)
  if (!order) return res.status(404).json({ code: 404, message: '工单不存在' })
  if (!FLOW[order.status]?.includes(to)) {
    return res.status(400).json({
      code: 400,
      message: `不允许从「${STATUS_TEXT[order.status]}」流转到「${STATUS_TEXT[to] || to}」`
    })
  }
  const ts = now()
  const actionText = {
    PROCESSING: '受理派单', CHECKING: '处理完成', CLOSED: '验收闭环'
  }[to]
  db.prepare('UPDATE work_orders SET status=?, handler=?, updated_at=? WHERE id=?')
    .run(to, handler || order.handler || req.user.real_name, ts, req.params.id)
  db.prepare('INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)')
    .run(req.params.id, actionText, req.user.real_name, note || '', ts)
  writeLog(req.user.username, '工单流转', `${order.code} → ${STATUS_TEXT[to]}`)
  res.json({ code: 0, message: `已流转至「${STATUS_TEXT[to]}」` })
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
