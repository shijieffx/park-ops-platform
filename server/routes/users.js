import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { authRequired, permit, writeLog } from '../middleware/auth.js'

const router = Router()
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** 列表 —— GET /api/users */
router.get('/', authRequired, permit('system:user'), (req, res) => {
  const { keyword = '', roleCode = '', page = 1, pageSize = 20 } = req.query
  const where = ['1=1']
  const params = []
  if (keyword) { where.push('(username LIKE ? OR real_name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
  if (roleCode) { where.push('role_code = ?'); params.push(roleCode) }
  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM users WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT id, username, real_name, phone, role_code, region, status, created_at
     FROM users WHERE ${cond} ORDER BY id ASC LIMIT ? OFFSET ?`
  ).all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize))
  res.json({ code: 0, data: { list: rows, total, page: Number(page), pageSize: Number(pageSize) } })
})

/** 新增 / 编辑 —— POST /api/users */
router.post('/', authRequired, permit('system:user'), (req, res) => {
  const d = req.body || {}
  if (!d.username || !d.realName) {
    return res.status(400).json({ code: 400, message: '账号与姓名必填' })
  }
  if (d.id) {
    db.prepare('UPDATE users SET real_name=?, phone=?, role_code=?, region=?, status=? WHERE id=?')
      .run(d.realName, d.phone || '', d.roleCode, d.region || '', d.status == null ? 1 : d.status, d.id)
  } else {
    const exist = db.prepare('SELECT id FROM users WHERE username = ?').get(d.username)
    if (exist) return res.status(400).json({ code: 400, message: '账号已存在' })
    db.prepare(
      `INSERT INTO users (username, password, real_name, phone, role_code, region, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(d.username, bcrypt.hashSync(d.password || '123456', 10), d.realName,
      d.phone || '', d.roleCode || 'operator', d.region || '', 1, now())
  }
  writeLog(req.user.username, '用户维护', `${d.id ? '编辑' : '新增'}用户 ${d.username}`)
  res.json({ code: 0, message: '保存成功' })
})

/** 重置密码 —— PUT /api/users/:id/reset */
router.put('/:id/reset', authRequired, permit('system:user'), (req, res) => {
  db.prepare('UPDATE users SET password = ? WHERE id = ?')
    .run(bcrypt.hashSync('123456', 10), req.params.id)
  writeLog(req.user.username, '用户维护', `重置用户 #${req.params.id} 密码`)
  res.json({ code: 0, message: '密码已重置为 123456' })
})

/** 启停 —— PUT /api/users/:id/status */
router.put('/:id/status', authRequired, permit('system:user'), (req, res) => {
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(req.body.status ? 1 : 0, req.params.id)
  res.json({ code: 0, message: '状态已更新' })
})

/** 删除 —— DELETE /api/users/:id */
router.delete('/:id', authRequired, permit('system:user'), (req, res) => {
  if (Number(req.params.id) === req.user.id) {
    return res.status(400).json({ code: 400, message: '不能删除当前登录账号' })
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id)
  writeLog(req.user.username, '用户维护', `删除用户 #${req.params.id}`)
  res.json({ code: 0, message: '删除成功' })
})

export default router
