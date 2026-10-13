#!/usr/bin/env node
/**
 * 两套后端一致性对比（Node 版 ⇄ Python 版）
 *
 * 背景：本项目同时存在 Node(Express) 与 Python(FastAPI) 两套后端实现，
 * 共用同一个数据库与同一套前端。要证明「换后端对前端透明」，
 * 最直接的办法就是：对同一批只读接口分别请求两边，逐字段比对响应。
 *
 * 用法：
 *   node scripts/compare-backends.mjs [nodeBase] [pythonBase]
 * 默认：
 *   nodeBase   = http://127.0.0.1:3001
 *   pythonBase = http://127.0.0.1:8000
 * 两个服务需要同时启动。
 *
 * 说明：少数字段天然无法逐字节相同，已在下方显式列出并说明原因，不做静默忽略。
 */
const NODE_BASE = (process.argv[2] || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const PY_BASE = (process.argv[3] || 'http://127.0.0.1:8000').replace(/\/+$/, '')

const C = {
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

/** 时间/运行时相关字段：两边取到的时间戳必然不同 */
const IGNORE_KEYS = new Set(['ts', 'generatedAt', 'now', 'pid', 'uptimeSec', 'rssMB', 'python', 'node'])
/** 以当前时间实时计算的字段：两次请求间隔可能造成 0.1 小时级的差异 */
const TOLERANT_KEYS = new Set(['hoursLeft'])
const TOLERANCE = 0.3

const ENDPOINTS = [
  '/api/meta/menus',
  '/api/meta/roles',
  '/api/meta/dicts',
  '/api/meta/staff',
  '/api/devices?page=1&pageSize=5',
  '/api/devices/all',
  '/api/devices/stats/summary',
  '/api/devices/stats/maintain',
  '/api/orders?page=1&pageSize=5',
  '/api/orders?overdue=1&page=1&pageSize=5',
  '/api/orders/stats/summary',
  '/api/orders/stats/sla',
  '/api/alarms?page=1&pageSize=5',
  '/api/alarms/stats/summary',
  '/api/alarms/stats/trend',
  '/api/inspection/plans',
  '/api/inspection/tasks?page=1&pageSize=5',
  '/api/inspection/stats/summary',
  '/api/inspection/stats/overdue',
  '/api/inspection/meta/sla',
  '/api/parts?page=1&pageSize=5',
  '/api/parts?onlyLow=1&page=1&pageSize=5',
  '/api/parts/all',
  '/api/parts/records?page=1&pageSize=5',
  '/api/parts/stats/summary',
  '/api/stats/dashboard',
  '/api/ai/context'
]

/** 仅管理员可访问的接口 */
const ADMIN_ONLY = ['/api/users']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(base, path, token) {
  const res = await fetch(base + path, {
    headers: token ? { 'X-Auth-Token': token } : {}
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, raw: text }
}

async function login(base, username) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  }).then((r) => r.json())
  if (res.code !== 0) throw new Error(`${base} 登录失败：${JSON.stringify(res)}`)
  return res.data.token
}

function normalize(value, path = '') {
  if (Array.isArray(value)) return value.map((v, i) => normalize(v, `${path}[${i}]`))
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (IGNORE_KEYS.has(key)) continue
      out[key] = normalize(value[key], `${path}.${key}`)
    }
    return out
  }
  return value
}

function diff(a, b, path = '', out = []) {
  if (out.length > 6) return out
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b

  if (ta !== tb) { out.push(`${path || '(root)'}: 类型不同 ${ta} ≠ ${tb}`); return out }

  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${path}: 数组长度 ${a.length} ≠ ${b.length}`)
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out)
    return out
  }

  if (ta === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const key of keys) {
      if (!(key in a)) { out.push(`${path}.${key}: Node 缺失`); continue }
      if (!(key in b)) { out.push(`${path}.${key}: Python 缺失`); continue }
      diff(a[key], b[key], `${path}.${key}`, out)
    }
    return out
  }

  if (typeof a === 'number' && typeof b === 'number') {
    const key = path.split('.').pop().replace(/\[\d+\]$/, '')
    if (TOLERANT_KEYS.has(key)) {
      if (Math.abs(a - b) > TOLERANCE) out.push(`${path}: ${a} ≠ ${b}（超出容差 ${TOLERANCE}）`)
    } else if (a !== b) {
      out.push(`${path}: ${a} ≠ ${b}`)
    }
    return out
  }

  if (a !== b) out.push(`${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
  return out
}

const main = async () => {
  console.log(C.bold(`\n两套后端一致性对比\n  Node  版：${NODE_BASE}\n  Python 版：${PY_BASE}\n${'─'.repeat(56)}`))

  const roles = ['admin', 'manager', 'operator']
  const tokens = { node: {}, python: {} }
  for (const role of roles) {
    tokens.node[role] = await login(NODE_BASE, role)
    tokens.python[role] = await login(PY_BASE, role)
  }
  console.log(C.gray('三角色登录成功\n'))

  let compared = 0
  const mismatches = []

  const check = async (label, path, token) => {
    const [a, b] = await Promise.all([
      get(NODE_BASE, path, token.node),
      get(PY_BASE, path, token.python)
    ])
    compared++

    const problems = []
    if (a.status !== b.status) problems.push(`HTTP 状态 ${a.status} ≠ ${b.status}`)
    if (a.json === null || b.json === null) {
      problems.push(`响应不是 JSON（node=${a.json !== null}, python=${b.json !== null}）`)
    } else {
      problems.push(...diff(normalize(a.json), normalize(b.json)))
    }

    if (problems.length) {
      mismatches.push({ label, path, problems })
      console.log(`  ${C.red('[DIFF]')} ${label.padEnd(10, '　')} ${path}`)
      problems.slice(0, 3).forEach((p) => console.log(C.gray(`         ↳ ${p}`)))
    } else {
      console.log(`  ${C.green('[SAME]')} ${label.padEnd(10, '　')} ${path}`)
    }
  }

  for (const role of roles) {
    console.log(C.bold(`▶ 角色：${role}`))
    for (const path of ENDPOINTS) await check(role, path, { node: tokens.node[role], python: tokens.python[role] })
    if (role === 'admin') {
      for (const path of ADMIN_ONLY) await check(role, path, { node: tokens.node[role], python: tokens.python[role] })
    }
    console.log('')
  }

  console.log('─'.repeat(56))
  console.log(`对比 ${compared} 个请求，差异 ${mismatches.length} 处`)
  if (mismatches.length === 0) {
    console.log(C.green('两套后端在全部只读接口上返回一致 ✓'))
  }

  console.log(C.gray('\n显式排除的字段（无法逐字节相同，非静默忽略）：'))
  console.log(C.gray(`  · ${[...IGNORE_KEYS].join(' / ')} —— 时间戳与进程信息`))
  console.log(C.gray(`  · hoursLeft —— 实时计算，允许 ${TOLERANCE} 小时容差`))
  console.log(C.gray('  · /api/meta/logs 未纳入对比：每次登录都会各自写入一条操作日志，两份列表天然不同'))

  process.exitCode = mismatches.length ? 1 : 0
}

main().catch((e) => {
  console.error(C.red('\n[x] ' + (e?.message || e)))
  process.exitCode = 1
})
