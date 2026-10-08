import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, scopeFilter, writeLog } from '../middleware/auth.js'

const router = Router()
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

const FIELDS = 'id, code, name, category, region, status, vendor, install_date, owner, remark'

/** 分页列表（支持关键词 / 类型 / 区域 / 状态 组合筛选）—— GET /api/devices */
router.get('/', authRequired, (req, res) => {
  const { keyword = '', category = '', region = '', status = '', page = 1, pageSize = 20 } = req.query
  const sc = scopeFilter('devices', req.user)
  const where = [sc.sql]
  const params = [...sc.params]

  if (keyword) {
    where.push('(code LIKE ? OR name LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (category) { where.push('category = ?'); params.push(category) }
  if (region) { where.push('region = ?'); params.push(region) }
  if (status) { where.push('status = ?'); params.push(status) }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM devices WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT ${FIELDS} FROM devices WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize))

  res.json({ code: 0, data: { list: rows, total, page: Number(page), pageSize: Number(pageSize) } })
})

/** 精简全量（导出用，受数据权限约束）—— GET /api/devices/all */
router.get('/all', authRequired, (req, res) => {
  const sc = scopeFilter('devices', req.user)
  const rows = db.prepare(
    `SELECT ${FIELDS} FROM devices WHERE ${sc.sql} ORDER BY id ASC`
  ).all(...sc.params)
  res.json({ code: 0, data: rows })
})

/** 详情 —— GET /api/devices/:id */
router.get('/:id', authRequired, (req, res) => {
  const row = db.prepare(`SELECT ${FIELDS} FROM devices WHERE id = ?`).get(req.params.id)
  if (!row) return res.status(404).json({ code: 404, message: '设备不存在' })
  res.json({ code: 0, data: row })
})

/** 新增 —— POST /api/devices */
router.post('/', authRequired, permit('device:edit'), (req, res) => {
  const d = req.body || {}
  if (!d.code || !d.name) return res.status(400).json({ code: 400, message: '设备编号与名称必填' })
  const exist = db.prepare('SELECT id FROM devices WHERE code = ?').get(d.code)
  if (exist) return res.status(400).json({ code: 400, message: '设备编号已存在' })
  db.prepare(
    `INSERT INTO devices (code, name, category, region, status, vendor, install_date, owner, remark, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(d.code, d.name, d.category || '未分类', d.region || '', d.status || '运行中',
    d.vendor || '', d.installDate || '', d.owner || '', d.remark || '', now())
  writeLog(req.user.username, '设备新增', `新增设备 ${d.code}`)
  res.json({ code: 0, message: '新增成功' })
})

/** 编辑 —— PUT /api/devices/:id */
router.put('/:id', authRequired, permit('device:edit'), (req, res) => {
  const d = req.body || {}
  db.prepare(
    `UPDATE devices SET name=?, category=?, region=?, status=?, vendor=?, install_date=?, owner=?, remark=? WHERE id=?`
  ).run(d.name, d.category, d.region, d.status, d.vendor, d.installDate, d.owner, d.remark, req.params.id)
  writeLog(req.user.username, '设备编辑', `编辑设备 #${req.params.id}`)
  res.json({ code: 0, message: '保存成功' })
})

/** 删除 —— DELETE /api/devices/:id */
router.delete('/:id', authRequired, permit('device:edit'), (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ?').run(req.params.id)
  writeLog(req.user.username, '设备删除', `删除设备 #${req.params.id}`)
  res.json({ code: 0, message: '删除成功' })
})

/** 区域 / 类型 / 状态 分布统计 —— GET /api/devices/stats */
router.get('/stats/summary', authRequired, (req, res) => {
  const sc = scopeFilter('devices', req.user)
  const by = (col) => db.prepare(
    `SELECT ${col} AS name, COUNT(*) AS value FROM devices WHERE ${sc.sql} GROUP BY ${col} ORDER BY value DESC`
  ).all(...sc.params)
  const total = db.prepare(`SELECT COUNT(*) c FROM devices WHERE ${sc.sql}`).get(...sc.params).c
  res.json({
    code: 0,
    data: { total, byRegion: by('region'), byCategory: by('category'), byStatus: by('status') }
  })
})

export default router
