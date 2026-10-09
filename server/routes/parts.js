import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, writeLog } from '../middleware/auth.js'
import { parsePaging, toKeyword } from '../utils/validate.js'
import { nowText } from '../utils/sla.js'

const router = Router()

const FIELDS = 'id, code, name, spec, unit, stock, safety_stock, price, vendor, created_at'

/** 低库存判定直接下沉到 SQL，保证列表与统计口径一致 */
const LOW_STOCK_SQL = 'stock < safety_stock'

/** 备件列表 —— GET /api/parts */
router.get('/', authRequired, (req, res) => {
  const keyword = toKeyword(req.query.keyword)
  const { category = '', onlyLow = '' } = req.query
  const { page, pageSize, offset } = parsePaging(req.query)
  const where = ['1=1']
  const params = []

  if (keyword) {
    where.push('(code LIKE ? OR name LIKE ? OR spec LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  if (category) { where.push('vendor = ?'); params.push(category) }
  if (onlyLow === '1') where.push(LOW_STOCK_SQL)

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM parts WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT ${FIELDS}, (${LOW_STOCK_SQL}) AS low FROM parts WHERE ${cond} ORDER BY low DESC, id ASC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)

  res.json({
    code: 0,
    data: { list: rows.map((r) => ({ ...r, low: !!r.low })), total, page, pageSize }
  })
})

/** 全量（工单领用时的下拉数据）—— GET /api/parts/all */
router.get('/all', authRequired, (req, res) => {
  const rows = db.prepare(`SELECT ${FIELDS} FROM parts ORDER BY name ASC`).all()
  res.json({ code: 0, data: rows })
})

/** 出入库流水 —— GET /api/parts/records */
router.get('/records', authRequired, (req, res) => {
  const { partId = '', type = '', orderCode = '' } = req.query
  const { page, pageSize, offset } = parsePaging(req.query)
  const where = ['1=1']
  const params = []
  if (partId) { where.push('part_id = ?'); params.push(Number(partId)) }
  if (type) { where.push('type = ?'); params.push(type) }
  if (orderCode) { where.push('order_code = ?'); params.push(orderCode) }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM part_records WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT * FROM part_records WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)
  res.json({ code: 0, data: { list: rows, total, page, pageSize } })
})

/** 备件统计 —— GET /api/parts/stats/summary */
router.get('/stats/summary', authRequired, (_, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).c
  const totalParts = one('SELECT COUNT(*) c FROM parts')
  const lowCount = one(`SELECT COUNT(*) c FROM parts WHERE ${LOW_STOCK_SQL}`)
  const stockValue = db.prepare('SELECT SUM(stock * price) v FROM parts').get().v || 0
  const outQty = one("SELECT SUM(qty) c FROM part_records WHERE type = 'OUT'") || 0
  const inQty = one("SELECT SUM(qty) c FROM part_records WHERE type = 'IN'") || 0

  const lowList = db.prepare(
    `SELECT id, code, name, unit, stock, safety_stock FROM parts
     WHERE ${LOW_STOCK_SQL} ORDER BY (stock - safety_stock) ASC LIMIT 10`
  ).all()

  const trend = db.prepare(
    `SELECT substr(created_at,1,10) AS date,
            SUM(CASE WHEN type = 'OUT' THEN qty ELSE 0 END) AS outQty,
            SUM(CASE WHEN type = 'IN' THEN qty ELSE 0 END) AS inQty
     FROM part_records GROUP BY date ORDER BY date DESC LIMIT 14`
  ).all().reverse()

  res.json({
    code: 0,
    data: {
      totalParts, lowCount,
      stockValue: Math.round(stockValue * 100) / 100,
      outQty, inQty, lowList, trend
    }
  })
})

/** 新增 / 编辑备件 —— POST /api/parts */
router.post('/', authRequired, permit('part:edit'), (req, res) => {
  const d = req.body || {}
  if (!d.code || !d.name) return res.status(400).json({ code: 400, message: '备件编码与名称必填' })
  const stock = Number(d.stock) || 0
  const safety = Number(d.safetyStock) || 0
  if (stock < 0 || safety < 0) {
    return res.status(400).json({ code: 400, message: '库存与安全库存不能为负数' })
  }

  const payload = [d.code, d.name, d.spec || '', d.unit || '个', stock, safety,
    Number(d.price) || 0, d.vendor || '']

  if (d.id) {
    const exist = db.prepare('SELECT id FROM parts WHERE id = ?').get(d.id)
    if (!exist) return res.status(404).json({ code: 404, message: '备件不存在' })
    db.prepare(
      `UPDATE parts SET code=?, name=?, spec=?, unit=?, stock=?, safety_stock=?, price=?, vendor=? WHERE id=?`
    ).run(...payload, d.id)
    writeLog(req.user.username, '备件维护', `编辑备件 ${d.code}`)
    return res.json({ code: 0, message: '保存成功' })
  }

  if (db.prepare('SELECT id FROM parts WHERE code = ?').get(d.code)) {
    return res.status(400).json({ code: 400, message: '备件编码已存在' })
  }
  db.prepare(
    `INSERT INTO parts (code, name, spec, unit, stock, safety_stock, price, vendor, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(...payload, nowText())
  writeLog(req.user.username, '备件维护', `新增备件 ${d.code}`)
  res.json({ code: 0, message: '新增成功' })
})

/** 手动入库 / 出库 —— POST /api/parts/:id/stock */
router.post('/:id/stock', authRequired, permit('part:edit'), (req, res) => {
  const { type, qty, note } = req.body || {}
  const n = Number(qty)
  if (type !== 'IN' && type !== 'OUT') {
    return res.status(400).json({ code: 400, message: '出入库类型只能为 IN 或 OUT' })
  }
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ code: 400, message: '数量必须为正整数' })
  }

  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id)
  if (!part) return res.status(404).json({ code: 404, message: '备件不存在' })
  if (type === 'OUT' && part.stock < n) {
    return res.status(400).json({
      code: 400,
      message: `库存不足：当前 ${part.stock}${part.unit}，需出库 ${n}${part.unit}`
    })
  }

  const after = type === 'IN' ? part.stock + n : part.stock - n
  const tx = db.transaction(() => {
    db.prepare('UPDATE parts SET stock = ? WHERE id = ?').run(after, part.id)
    db.prepare(
      `INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock, after_stock,
                                 order_code, operator, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(part.id, part.code, part.name, type, n, part.stock, after, '',
      req.user.real_name, note || (type === 'IN' ? '采购入库' : '手动出库'), nowText())
  })
  tx()

  writeLog(req.user.username, '备件出入库',
    `${type === 'IN' ? '入库' : '出库'} ${part.code} ${n}${part.unit}`)
  res.json({
    code: 0,
    message: `${type === 'IN' ? '入库' : '出库'}成功，库存 ${part.stock} → ${after}`,
    data: { stock: after, lowStock: after < part.safety_stock }
  })
})

/**
 * 工单领用备件 —— POST /api/parts/apply
 * body: { partId, qty, orderCode, note }
 * 校验库存 → 扣减 → 写流水 → 返回是否触发低库存预警
 */
router.post('/apply', authRequired, permit('order:edit'), (req, res) => {
  const { partId, qty, orderCode, note } = req.body || {}
  const n = Number(qty)
  if (!partId) return res.status(400).json({ code: 400, message: '请选择备件' })
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ code: 400, message: '领用数量必须为正整数' })
  }

  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(partId)
  if (!part) return res.status(404).json({ code: 404, message: '备件不存在' })
  if (part.stock < n) {
    return res.status(400).json({
      code: 400,
      message: `库存不足：${part.name} 当前 ${part.stock}${part.unit}，需领用 ${n}${part.unit}`
    })
  }
  if (orderCode && !db.prepare('SELECT id FROM work_orders WHERE code = ?').get(orderCode)) {
    return res.status(400).json({ code: 400, message: '关联的工单不存在' })
  }

  const after = part.stock - n
  const ts = nowText()
  const tx = db.transaction(() => {
    db.prepare('UPDATE parts SET stock = ? WHERE id = ?').run(after, part.id)
    db.prepare(
      `INSERT INTO part_records (part_id, part_code, part_name, type, qty, before_stock, after_stock,
                                 order_code, operator, note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(part.id, part.code, part.name, 'OUT', n, part.stock, after,
      orderCode || '', req.user.real_name, note || '工单领用', ts)
  })
  tx()

  const low = after < part.safety_stock
  writeLog(req.user.username, '备件领用',
    `工单 ${orderCode || '-'} 领用 ${part.code} × ${n}，剩余 ${after}`)

  res.json({
    code: 0,
    message: low
      ? `领用成功，库存 ${part.stock} → ${after}，已低于安全库存 ${part.safety_stock}${part.unit}`
      : `领用成功，库存 ${part.stock} → ${after}`,
    data: { stock: after, lowStock: low, partName: part.name }
  })
})

/** 删除备件 —— DELETE /api/parts/:id */
router.delete('/:id', authRequired, permit('part:edit'), (req, res) => {
  const part = db.prepare('SELECT * FROM parts WHERE id = ?').get(req.params.id)
  if (!part) return res.status(404).json({ code: 404, message: '备件不存在' })
  const used = db.prepare('SELECT COUNT(*) c FROM part_records WHERE part_id = ?').get(part.id).c
  if (used > 0) {
    return res.status(400).json({ code: 400, message: '该备件已有出入库记录，不能删除' })
  }
  db.prepare('DELETE FROM parts WHERE id = ?').run(part.id)
  writeLog(req.user.username, '备件维护', `删除备件 ${part.code}`)
  res.json({ code: 0, message: '删除成功' })
})

export default router
