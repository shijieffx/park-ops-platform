import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, writeLog } from '../middleware/auth.js'
import { nowText } from '../utils/time.js'

const router = Router()

/** 菜单树：按当前角色过滤 —— GET /api/meta/menus */
router.get('/menus', authRequired, (req, res) => {
  const all = db.prepare('SELECT * FROM menus ORDER BY sort ASC, id ASC').all()
  const hidden = req.user.role_code === 'admin'
    ? []
    : ['system:view', 'system:user', 'system:role', 'system:dict', 'system:log']
  const visible = all.filter((m) => !hidden.includes(m.perm))
  const tree = visible
    .filter((m) => m.parent_id === 0)
    .map((m) => ({ ...m, children: visible.filter((c) => c.parent_id === m.id) }))
  res.json({ code: 0, data: tree })
})

/** 角色列表 —— GET /api/meta/roles */
router.get('/roles', authRequired, (req, res) => {
  const rows = db.prepare('SELECT id, name, code, data_scope, remark FROM roles ORDER BY id').all()
  res.json({ code: 0, data: rows })
})

/** 新增 / 编辑角色 —— POST /api/meta/roles */
router.post('/roles', authRequired, permit('system:role'), (req, res) => {
  const { id, name, code, dataScope, remark } = req.body || {}
  if (!name || !code) return res.status(400).json({ code: 400, message: '角色名称与编码必填' })
  if (id) {
    db.prepare('UPDATE roles SET name=?, code=?, data_scope=?, remark=? WHERE id=?')
      .run(name, code, dataScope || 'ALL', remark || '', id)
  } else {
    const exist = db.prepare('SELECT id FROM roles WHERE code = ?').get(code)
    if (exist) return res.status(400).json({ code: 400, message: '角色编码已存在' })
    db.prepare('INSERT INTO roles (name, code, data_scope, remark, created_at) VALUES (?,?,?,?,?)')
      .run(name, code, dataScope || 'ALL', remark || '', nowText())
  }
  writeLog(req.user.username, '角色维护', `${id ? '编辑' : '新增'}角色 ${name}`)
  res.json({ code: 0, message: '保存成功' })
})

/** 删除角色 —— DELETE /api/meta/roles/:id */
router.delete('/roles/:id', authRequired, permit('system:role'), (req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM users WHERE role_code = (SELECT code FROM roles WHERE id=?)')
    .get(req.params.id)
  if (used?.c > 0) return res.status(400).json({ code: 400, message: '该角色下仍有用户，不能删除' })
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id)
  writeLog(req.user.username, '角色维护', `删除角色 #${req.params.id}`)
  res.json({ code: 0, message: '删除成功' })
})

/** 数据字典 —— GET /api/meta/dicts?type=xxx */
router.get('/dicts', authRequired, (req, res) => {
  const { type } = req.query
  const rows = type
    ? db.prepare('SELECT * FROM dicts WHERE type = ? ORDER BY sort, id').all(type)
    : db.prepare('SELECT * FROM dicts ORDER BY type, sort, id').all()
  res.json({ code: 0, data: rows })
})

/** 可派单人员 —— GET /api/meta/staff（按姓名去重，同一人可能有多条账号记录） */
router.get('/staff', authRequired, (_, res) => {
  const rows = db.prepare(
    `SELECT real_name AS realName, role_code AS roleCode
     FROM users WHERE status = 1 AND real_name != ''
     GROUP BY real_name
     ORDER BY CASE role_code WHEN 'manager' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END, real_name`
  ).all()
  res.json({ code: 0, data: rows })
})

/** 操作日志 —— GET /api/meta/logs */
router.get('/logs', authRequired, permit('system:log'), (req, res) => {
  const { keyword = '', username = '' } = req.query
  const where = ['1=1']
  const params = []
  const kw = String(keyword).trim().slice(0, 50)
  if (kw) { where.push('(action LIKE ? OR detail LIKE ?)'); params.push(`%${kw}%`, `%${kw}%`) }
  if (username) { where.push('username = ?'); params.push(username) }
  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM logs WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT * FROM logs WHERE ${cond} ORDER BY id DESC LIMIT 300`
  ).all(...params)
  res.json({ code: 0, data: { list: rows, total } })
})

export default router
