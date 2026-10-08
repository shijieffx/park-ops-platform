import jwt from 'jsonwebtoken'
import { db } from '../db.js'

export const JWT_SECRET = process.env.JWT_SECRET || 'park-ops-demo-secret'
const TOKEN_TTL = '12h'

/** 角色 → 可访问的权限点 */
const ROLE_PERMS = {
  admin: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view', 'system:view', 'system:user', 'system:role', 'system:dict'],
  manager: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view'],
  operator: ['dashboard:view', 'device:view', 'order:view', 'order:edit', 'alarm:view']
}

/** 角色 → 数据范围：ALL 全部 / REGION 本区域 / SELF 仅本人 */
const ROLE_SCOPE = { admin: 'ALL', manager: 'REGION', operator: 'SELF' }

export function signToken(user) {
  // region 必须写入 token：数据范围过滤依赖它
  return jwt.sign(
    {
      id: user.id, username: user.username, role_code: user.role_code,
      real_name: user.real_name, region: user.region
    },
    JWT_SECRET, { expiresIn: TOKEN_TTL }
  )
}

/** 解析并校验 token */
export function authRequired(req, res, next) {
  const raw = req.headers.authorization || ''
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw
  if (!token) return res.status(401).json({ code: 401, message: '未登录' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    req.user.perms = ROLE_PERMS[req.user.role_code] || []
    req.user.scope = ROLE_SCOPE[req.user.role_code] || 'SELF'
    next()
  } catch {
    res.status(401).json({ code: 401, message: '登录已过期，请重新登录' })
  }
}

/** 权限点校验：permit('system:user') */
export function permit(...need) {
  return (req, res, next) => {
    const has = need.every((p) => req.user.perms.includes(p))
    if (!has) return res.status(403).json({ code: 403, message: '当前角色无此操作权限' })
    next()
  }
}

/**
 * 按角色生成数据过滤条件
 * @param {'devices'|'work_orders'|'alarms'} table
 * @returns { sql: string, params: any[] }
 */
export function scopeFilter(table, user) {
  if (user.scope === 'ALL') return { sql: '1=1', params: [] }
  if (user.scope === 'REGION') {
    if (!user.region) return { sql: '1=1', params: [] }
    return { sql: 'region = ?', params: [user.region] }
  }
  // SELF：工单看处理人，设备看负责人，告警看本区域
  if (table === 'work_orders') return { sql: 'handler = ?', params: [user.real_name] }
  if (table === 'devices') return { sql: 'owner = ?', params: [user.real_name] }
  if (table === 'alarms') {
    return user.region
      ? { sql: 'region = ?', params: [user.region] }
      : { sql: '1=1', params: [] }
  }
  return { sql: '1=1', params: [] }
}

/** 记录操作日志 */
export function writeLog(username, action, detail) {
  try {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('INSERT INTO logs (username, action, detail, created_at) VALUES (?,?,?,?)')
      .run(username, action, detail, ts)
  } catch { /* 日志失败不影响主流程 */ }
}
