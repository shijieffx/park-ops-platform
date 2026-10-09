import jwt from 'jsonwebtoken'
import { db } from '../db.js'

export const JWT_SECRET = process.env.JWT_SECRET || 'park-ops-demo-secret'
const TOKEN_TTL = '12h'

/** 角色 → 可访问的权限点（唯一事实来源，登录接口也复用这里） */
export const ROLE_PERMS = {
  admin: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view', 'system:view', 'system:user', 'system:role', 'system:dict'],
  manager: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view'],
  operator: ['dashboard:view', 'device:view', 'order:view', 'order:edit', 'alarm:view']
}

/** 角色 → 数据范围：ALL 全部 / REGION 本区域 / SELF 仅本人 */
export const ROLE_SCOPE = { admin: 'ALL', manager: 'REGION', operator: 'SELF' }

/** 角色编码 → 中文名，仅用于日志与展示 */
export const ROLE_NAME = { admin: '系统管理员', manager: '运维主管', operator: '运维专员' }

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

/** JWT 的外形特征：三段 base64url，用点分隔 */
const JWT_SHAPE = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g

/**
 * 从 Authorization 头中取出本服务可用的 token。
 *
 * 标准写法是 `Bearer <token>`，但某些部署环境会把**自己的凭证**追加到同一个头里
 * （实测线上收到的头比客户端发出的多 126 个字符），此时简单地 `slice(7)` 会拿到
 * 一串拼接后的脏数据，验签必然失败（invalid signature）。
 *
 * 因此这里改为：扫描头中所有形似 JWT 的片段，逐个用本服务的密钥验签，
 * 取第一个验签通过的。头里只有本服务的 token 时，行为与标准写法完全一致。
 */
export function resolveToken(rawHeader) {
  const raw = String(rawHeader || '')
  const candidates = raw.match(JWT_SHAPE) || []

  if (!candidates.length) {
    const fallback = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim()
    if (fallback) candidates.push(fallback)
  }

  let lastError = null
  for (const candidate of candidates) {
    try {
      return { token: candidate, payload: jwt.verify(candidate, JWT_SECRET) }
    } catch (err) {
      lastError = err
    }
  }
  return { token: null, payload: null, error: lastError, candidates: candidates.length }
}

/** 解析并校验 token */
export function authRequired(req, res, next) {
  // 优先读取自定义头 X-Auth-Token：
  // 实测线上部署环境会替换 Authorization 头（客户端发出的 253 字符令牌，
  // 服务端收到的是另一串 379 字符的内容），导致客户端令牌丢失、验签失败。
  // 自定义头不经过那层处理，可稳定送达；Authorization 作为兼容回退保留。
  const custom = req.headers['x-auth-token']
  const source = custom ? `Bearer ${custom}` : req.headers.authorization

  const { payload, token, error, candidates } = resolveToken(source)

  if (!token && !candidates) {
    return res.status(401).json({ code: 401, message: '未登录' })
  }
  if (!token) {
    // 默认只回统一提示，不外泄内部错误；
    // 需要排查环境差异（如线上验签失败）时，用 API_DEBUG=1 启动即可看到具体原因。
    const body = { code: 401, message: '登录已过期，请重新登录' }
    if (process.env.API_DEBUG === '1') body.reason = error?.message
    return res.status(401).json(body)
  }

  req.user = payload
  req.user.perms = ROLE_PERMS[payload.role_code] || []
  req.user.scope = ROLE_SCOPE[payload.role_code] || 'SELF'
  next()
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

/**
 * 在「当前用户数据权限范围内」取单条记录。
 * 越权访问与记录不存在返回同一结果（null），由调用方统一回 404，
 * 避免通过状态码差异探测出资源是否存在。
 */
export function findVisible(table, id, user, fields = '*') {
  const sc = scopeFilter(table, user)
  return db.prepare(
    `SELECT ${fields} FROM ${table} WHERE id = ? AND ${sc.sql}`
  ).get(id, ...sc.params)
}

/** 记录操作日志 */
export function writeLog(username, action, detail) {
  try {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ')
    db.prepare('INSERT INTO logs (username, action, detail, created_at) VALUES (?,?,?,?)')
      .run(username, action, detail, ts)
  } catch { /* 日志失败不影响主流程 */ }
}
