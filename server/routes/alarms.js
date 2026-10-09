import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, scopeFilter, findVisible, writeLog } from '../middleware/auth.js'
import { parsePaging, toKeyword } from '../utils/validate.js'

const router = Router()
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** 列表 —— GET /api/alarms */
router.get('/', authRequired, (req, res) => {
  const { level = '', status = '' } = req.query
  const keyword = toKeyword(req.query.keyword)
  const { page, pageSize, offset } = parsePaging(req.query)
  const sc = scopeFilter('alarms', req.user)
  const where = [sc.sql]
  const params = [...sc.params]
  if (level) { where.push('level = ?'); params.push(level) }
  if (status) { where.push('status = ?'); params.push(status) }
  if (keyword) { where.push('(device_code LIKE ? OR content LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM alarms WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT id, device_code, device_name, level, content, status, region, created_at
     FROM alarms WHERE ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)
  res.json({ code: 0, data: { list: rows, total, page, pageSize } })
})

/** 标记已处理 —— PUT /api/alarms/:id/close */
router.put('/:id/close', authRequired, permit('order:edit'), (req, res) => {
  const exist = findVisible('alarms', req.params.id, req.user, 'id')
  if (!exist) return res.status(404).json({ code: 404, message: '告警不存在或无权访问' })

  db.prepare('UPDATE alarms SET status = ? WHERE id = ?').run('已处理', req.params.id)
  writeLog(req.user.username, '告警处理', `处理告警 #${req.params.id}`)
  res.json({ code: 0, message: '已标记为已处理' })
})

/** 等级分布 —— GET /api/alarms/stats */
router.get('/stats/summary', authRequired, (req, res) => {
  const sc = scopeFilter('alarms', req.user)
  const rows = db.prepare(
    `SELECT level AS name, COUNT(*) AS value FROM alarms WHERE ${sc.sql} GROUP BY level`
  ).all(...sc.params)
  const order = ['紧急', '重要', '次要', '提示']
  res.json({ code: 0, data: rows.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) })
})

/** 近 30 天告警趋势 —— GET /api/alarms/trend */
router.get('/stats/trend', authRequired, (req, res) => {
  const sc = scopeFilter('alarms', req.user)
  const rows = db.prepare(
    `SELECT substr(created_at,1,10) AS date, COUNT(*) AS value
     FROM alarms WHERE ${sc.sql} GROUP BY date ORDER BY date DESC LIMIT 30`
  ).all(...sc.params)
  res.json({ code: 0, data: rows.reverse() })
  void now
})

export default router
