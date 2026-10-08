import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, writeLog } from '../middleware/auth.js'

const router = Router()

/** 菜单树：按当前角色过滤 —— GET /api/meta/menus */
router.get('/menus', authRequired, (req, res) => {
  const all = db.prepare('SELECT * FROM menus ORDER BY sort ASC, id ASC').all()
  const hidden = req.user.role_code === 'admin' ? [] : ['system:view', 'system:user', 'system:role', 'system:dict']
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
      .run(name, code, dataScope || 'ALL', remark || '', new Date().toISOString().slice(0, 19).replace('T', ' '))
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

/** 操作日志 —— GET /api/meta/logs */
router.get('/logs', authRequired, permit('system:view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT 200').all()
  res.json({ code: 0, data: rows })
})

export default router
