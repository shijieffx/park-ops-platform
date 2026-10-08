import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { signToken, authRequired, writeLog } from '../middleware/auth.js'

const router = Router()

/** 登录：POST /api/auth/login */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(400).json({ code: 400, message: '请输入账号与密码' })
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user) return res.status(401).json({ code: 401, message: '账号不存在' })
  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ code: 401, message: '密码错误' })
  }
  if (!user.status) return res.status(403).json({ code: 403, message: '账号已停用' })

  writeLog(user.username, '登录', `${user.real_name} 登录系统`)
  res.json({
    code: 0,
    data: {
      token: signToken(user),
      user: {
        id: user.id, username: user.username, realName: user.real_name,
        roleCode: user.role_code, region: user.region,
        perms: require_perms(user.role_code)
      }
    }
  })
})

/** 当前登录人信息：GET /api/auth/profile */
router.get('/profile', authRequired, (req, res) => {
  const user = db.prepare(
    'SELECT id, username, real_name, phone, role_code, region, status FROM users WHERE id = ?'
  ).get(req.user.id)
  if (!user) return res.status(401).json({ code: 401, message: '账号不存在' })
  res.json({
    code: 0,
    data: {
      id: user.id, username: user.username, realName: user.real_name,
      phone: user.phone, roleCode: user.role_code, region: user.region,
      perms: require_perms(user.role_code)
    }
  })
})

function require_perms(roleCode) {
  const map = {
    admin: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
      'alarm:view', 'report:view', 'system:view', 'system:user', 'system:role', 'system:dict'],
    manager: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
      'alarm:view', 'report:view'],
    operator: ['dashboard:view', 'device:view', 'order:view', 'order:edit', 'alarm:view']
  }
  return map[roleCode] || []
}

export default router
