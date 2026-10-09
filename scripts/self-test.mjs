#!/usr/bin/env node
/**
 * 接口自测脚本
 *   node scripts/self-test.mjs [baseUrl]
 * 默认针对 http://127.0.0.1:3001 跑一遍，覆盖：
 *   基础可用性 / 认证 / 权限点 / 数据范围 / 越权探测 / 业务规则 / 分页边界
 * 只做只读探测，不写坏数据。
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3001'

const C = {
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

let pass = 0
const bugs = []
const notes = []

async function req(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(BASE + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body)
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    return { status: res.status, json, raw: text }
  } catch (e) {
    return { status: 0, json: null, raw: String(e.message || e) }
  }
}

function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log(`  ${C.green('[PASS]')} ${name}`)
  } else {
    bugs.push({ name, detail })
    console.log(`  ${C.red('[BUG ]')} ${name}${detail ? C.gray(' — ' + detail) : ''}`)
  }
}

function note(text) {
  notes.push(text)
  console.log(`  ${C.yellow('[NOTE]')} ${text}`)
}

function section(title) {
  console.log(`\n${C.bold('▶ ' + title)}`)
}

function login(username, password) {
  return req('POST', '/api/auth/login', { body: { username, password } })
}

const PWD = '123456'

const main = async () => {
  console.log(C.bold(`\n园区综合运维管理平台 · 接口自测\n目标：${BASE}\n${'─'.repeat(56)}`))

  /* ── 1. 基础可用性 ─────────────────────────────── */
  section('基础可用性')
  const health = await req('GET', '/api/health')
  check('健康检查返回 200', health.status === 200, `status=${health.status}`)
  check('健康检查 code=0', health.json?.code === 0, JSON.stringify(health.json)?.slice(0, 80))
  const home = await req('GET', '/')
  check('首页返回 HTML', home.status === 200 && /<!doctype html/i.test(home.raw), `status=${home.status}`)
  const spa = await req('GET', '/order')
  check('SPA 子路由回退到首页', spa.status === 200 && /<!doctype html/i.test(spa.raw), `status=${spa.status}`)
  const api404 = await req('GET', '/api/not-exist')
  check('未知 API 返回 JSON 错误', api404.json !== null, `status=${api404.status} body=${api404.raw.slice(0, 60)}`)
  if (api404.json === null) note('未知 API 返回的是 HTML，前端解析会失败并提示「请求失败」')

  /* ── 2. 认证 ──────────────────────────────────── */
  section('认证')
  const adminR = await login('admin', PWD)
  const managerR = await login('manager', PWD)
  const operatorR = await login('operator', PWD)
  check('admin 登录成功', adminR.json?.code === 0 && !!adminR.json?.data?.token)
  check('manager 登录成功', managerR.json?.code === 0 && !!managerR.json?.data?.token)
  check('operator 登录成功', operatorR.json?.code === 0 && !!operatorR.json?.data?.token)

  const admin = adminR.json?.data
  const manager = managerR.json?.data
  const operator = operatorR.json?.data
  if (!admin || !manager || !operator) {
    console.log(C.red('\n登录失败，后续测试无法继续'))
    return
  }
  note(`admin 范围=全部区域；manager 区域=${manager.user.region}；operator=${operator.user.realName}`)

  check('密码错误被拒', (await login('admin', 'wrong-password')).status === 401)
  check('账号不存在被拒', (await login('nobody-here', PWD)).status === 401)
  check('缺少参数被拒', (await req('POST', '/api/auth/login', { body: {} })).status === 400)
  check('无 token 访问受保护接口返回 401', (await req('GET', '/api/devices')).status === 401)
  check('伪造 token 返回 401', (await req('GET', '/api/devices', { token: 'fake.token.here' })).status === 401)
  check('profile 返回当前用户', (await req('GET', '/api/auth/profile', { token: operator.token })).json?.data?.username === 'operator')

  /* ── 3. 权限点 ────────────────────────────────── */
  section('权限点校验')
  check('operator 看不到用户管理', (await req('GET', '/api/users', { token: operator.token })).status === 403)
  check('operator 看不到操作日志', (await req('GET', '/api/meta/logs', { token: operator.token })).status === 403)
  check('operator 不能新增设备', (await req('POST', '/api/devices', { token: operator.token, body: { code: 'T-X', name: 'x' } })).status === 403)
  check('manager 看不到操作日志', (await req('GET', '/api/meta/logs', { token: manager.token })).status === 403)
  check('admin 可以看操作日志', (await req('GET', '/api/meta/logs', { token: admin.token })).status === 200)
  check('admin 可以看用户列表', (await req('GET', '/api/users', { token: admin.token })).status === 200)

  /* ── 4. 数据范围 ──────────────────────────────── */
  section('数据范围（ALL / REGION / SELF）')
  const devTotal = async (t) => (await req('GET', '/api/devices?page=1&pageSize=1', { token: t })).json?.data?.total
  const aDev = await devTotal(admin.token)
  const mDev = await devTotal(manager.token)
  const oDev = await devTotal(operator.token)
  note(`设备可见数：admin=${aDev} / manager=${mDev} / operator=${oDev}`)
  check('admin 可见设备最多', aDev > mDev, `${aDev} vs ${mDev}`)
  check('manager 可见设备多于 operator', mDev > oDev, `${mDev} vs ${oDev}`)

  const dash = async (t) => (await req('GET', '/api/stats/dashboard', { token: t })).json?.data?.cards?.deviceTotal
  const aD = await dash(admin.token), mD = await dash(manager.token), oD = await dash(operator.token)
  note(`看板设备总数：admin=${aD} / manager=${mD} / operator=${oD}`)
  check('看板数据随角色收缩', aD >= mD && mD >= oD, `${aD}/${mD}/${oD}`)

  /* ── 5. 越权探测（只读，不改数据）────────────── */
  section('越权探测')
  const allDev = (await req('GET', '/api/devices/all', { token: admin.token })).json?.data || []
  const outside = allDev.find((d) => d.region && d.region !== manager.user.region)
  if (!outside) {
    note('未找到 manager 区域外的设备，跳过越权探测')
  } else {
    const r1 = await req('GET', `/api/devices/${outside.id}`, { token: manager.token })
    check('manager 不能读取区域外设备详情', r1.status === 403 || r1.status === 404,
      `实际 ${r1.status}，拿到了「${outside.region} / ${outside.name}」`)

    const r2 = await req('GET', `/api/devices/${outside.id}`, { token: operator.token })
    check('operator 不能读取他人设备详情', r2.status === 403 || r2.status === 404,
      `实际 ${r2.status}，拿到了「${outside.name}」`)
  }

  const allOrders = (await req('GET', '/api/orders?page=1&pageSize=200', { token: admin.token })).json?.data?.list || []
  const otherOrder = allOrders.find((o) => o.handler && o.handler !== operator.user.realName)
  if (!otherOrder) {
    note('未找到他人处理的工单，跳过工单越权探测')
  } else {
    const r3 = await req('GET', `/api/orders/${otherOrder.id}`, { token: operator.token })
    check('operator 不能读取他人工单详情', r3.status === 403 || r3.status === 404,
      `实际 ${r3.status}，拿到了单号 ${otherOrder.code}（处理人 ${otherOrder.handler}）`)
  }

  /* ── 6. 业务规则 ──────────────────────────────── */
  section('业务规则')
  check('新建工单缺少标题被拒', (await req('POST', '/api/orders', { token: admin.token, body: {} })).status === 400)
  check('新增设备缺少编号被拒', (await req('POST', '/api/devices', { token: admin.token, body: { name: '无编号设备' } })).status === 400)
  const dupCode = allDev[0]?.code
  const dup = await req('POST', '/api/devices', { token: admin.token, body: { code: dupCode, name: '重复编号' } })
  check('设备编号重复被拒', dup.status === 400, `status=${dup.status} ${dup.json?.message || ''}`)

  const pending = allOrders.find((o) => o.status === 'PENDING')
  if (pending) {
    const illegal = await req('POST', `/api/orders/${pending.id}/flow`, { token: admin.token, body: { to: 'CLOSED' } })
    check('工单非法流转被拒（待受理→已闭环）', illegal.status === 400, `status=${illegal.status} ${illegal.json?.message || ''}`)
  }
  const closed = allOrders.find((o) => o.status === 'CLOSED')
  if (closed) {
    const reflow = await req('POST', `/api/orders/${closed.id}/flow`, { token: admin.token, body: { to: 'PROCESSING' } })
    check('已闭环工单不可再流转', reflow.status === 400, `status=${reflow.status}`)
  }

  /* ── 7. 分页与边界 ───────────────────────────── */
  section('分页与参数边界')
  const p0 = await req('GET', '/api/devices?page=0&pageSize=10', { token: admin.token })
  check('page=0 不会返回全部数据', (p0.json?.data?.list?.length ?? 0) <= 10,
    `实际返回 ${p0.json?.data?.list?.length} 条（应受 pageSize 约束）`)

  const huge = await req('GET', '/api/devices?page=1&pageSize=999999', { token: admin.token })
  check('pageSize 有上限保护', (huge.json?.data?.list?.length ?? 0) <= 500,
    `实际返回 ${huge.json?.data?.list?.length} 条`)

  const neg = await req('GET', '/api/devices?page=-1&pageSize=10', { token: admin.token })
  check('page 为负数不报 500', neg.status === 200, `status=${neg.status}`)

  const badPage = await req('GET', '/api/devices?page=abc&pageSize=xyz', { token: admin.token })
  check('分页参数非数字不报 500', badPage.status === 200, `status=${badPage.status} body=${badPage.raw.slice(0, 100)}`)

  const badJson = await fetch(BASE + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin.token}` },
    body: '{bad json'
  }).catch(() => ({ status: 0 }))
  check('非法 JSON 请求体不导致 500', badJson.status !== 500, `status=${badJson.status}`)

  /* ── 汇总 ────────────────────────────────────── */
  console.log('\n' + '─'.repeat(56))
  console.log(`通过 ${C.green(pass)} 项，发现问题 ${C.red(bugs.length)} 项`)
  if (bugs.length) {
    console.log(C.bold('\n待修复清单：'))
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b.name}${b.detail ? C.gray(' — ' + b.detail) : ''}`))
  }
  if (notes.length) {
    console.log(C.bold('\n观察记录：'))
    notes.forEach((n, i) => console.log(`  ${i + 1}. ${n}`))
  }
  console.log()
  process.exit(bugs.length ? 1 : 0)
}

main()
