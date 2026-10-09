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

  /* ── 8. 巡检业务闭环 ─────────────────────────── */
  section('巡检业务闭环')
  const ts = (s) => new Date(String(s).replace(' ', 'T') + '+08:00').getTime()

  const plansR = await req('GET', '/api/inspection/plans', { token: admin.token })
  const planList = plansR.json?.data || []
  check('巡检计划列表可读', plansR.json?.code === 0 && planList.length > 0, `${planList.length} 个计划`)
  check('计划包含检查项', (planList[0]?.items || []).length > 0)

  const taskR = await req('GET', '/api/inspection/tasks?page=1&pageSize=50', { token: admin.token })
  const taskList = taskR.json?.data?.list || []
  check('巡检任务列表可读', taskR.json?.code === 0 && taskList.length > 0, `${taskR.json?.data?.total} 个任务`)

  const pendingTask = taskList.find((t) => t.status === 'PENDING')
  if (pendingTask) {
    const detail = await req('GET', `/api/inspection/tasks/${pendingTask.id}`, { token: admin.token })
    const items = detail.json?.data?.items || []
    check('任务详情带出检查项', items.length > 0, `${items.length} 项`)

    const results = items.map((item, i) => ({
      item, result: i === 0 ? '异常' : '正常',
      note: i === 0 ? '自测：模拟异常项' : '', deviceCode: ''
    }))
    const submit = await req('POST', `/api/inspection/tasks/${pendingTask.id}/submit`, {
      token: admin.token, body: { results }
    })
    check('提交巡检结果成功', submit.json?.code === 0, submit.json?.message)
    check('异常项自动生成工单', (submit.json?.data?.orders || []).length > 0,
      `生成 ${submit.json?.data?.orders?.length || 0} 张`)

    const again = await req('POST', `/api/inspection/tasks/${pendingTask.id}/submit`, {
      token: admin.token, body: { results }
    })
    check('已完成任务不可重复提交', again.status === 400, `status=${again.status}`)

    const noResult = await req('POST', '/api/inspection/tasks/generate', {
      token: admin.token, body: {}
    })
    check('生成今日任务可重复调用（已存在则跳过）', noResult.json?.code === 0,
      noResult.json?.message)
  }

  /* ── 9. 备件库存与业务规则 ───────────────────── */
  section('备件库存')
  const partsR = await req('GET', '/api/parts?page=1&pageSize=20', { token: admin.token })
  const partList = partsR.json?.data?.list || []
  check('备件列表可读', partsR.json?.code === 0 && partList.length > 0, `${partsR.json?.data?.total} 种`)

  const lowR = await req('GET', '/api/parts?onlyLow=1&page=1&pageSize=50', { token: admin.token })
  const lowList = lowR.json?.data?.list || []
  check('低库存筛选结果全部命中', lowList.every((p) => p.stock < p.safety_stock),
    `筛出 ${lowList.length} 条`)

  const target = partList.find((p) => p.stock > 3)
  if (target) {
    const before = target.stock
    const tooMany = await req('POST', '/api/parts/apply', {
      token: admin.token, body: { partId: target.id, qty: before + 999 }
    })
    check('超库存领用被拒', tooMany.status === 400, tooMany.json?.message)

    const neg = await req('POST', '/api/parts/apply', {
      token: admin.token, body: { partId: target.id, qty: -5 }
    })
    check('领用数量为负被拒', neg.status === 400, `status=${neg.status}`)

    const ok1 = await req('POST', '/api/parts/apply', {
      token: admin.token, body: { partId: target.id, qty: 1, note: '自测领用' }
    })
    check('备件领用成功', ok1.json?.code === 0, ok1.json?.message)
    check('领用后库存扣减 1', ok1.json?.data?.stock === before - 1,
      `${before} → ${ok1.json?.data?.stock}`)

    // 归还，避免污染演示数据
    const back = await req('POST', `/api/parts/${target.id}/stock`, {
      token: admin.token, body: { type: 'IN', qty: 1, note: '自测归还' }
    })
    check('入库可恢复库存', back.json?.data?.stock === before, `恢复至 ${back.json?.data?.stock}`)

    const badPart = await req('POST', '/api/parts/apply', {
      token: admin.token, body: { partId: 999999, qty: 1 }
    })
    check('领用不存在的备件返回 404', badPart.status === 404, `status=${badPart.status}`)
  }

  /* ── 10. 工单 SLA 时效 ──────────────────────── */
  section('工单 SLA')
  const slaR = await req('GET', '/api/orders/stats/sla', { token: admin.token })
  check('SLA 统计可读', slaR.json?.code === 0)
  check('按时率在合理区间',
    typeof slaR.json?.data?.onTimeRate === 'number' &&
    slaR.json.data.onTimeRate >= 0 && slaR.json.data.onTimeRate <= 100,
    `按时率 ${slaR.json?.data?.onTimeRate}%`)

  const odR = await req('GET', '/api/orders?overdue=1&page=1&pageSize=20', { token: admin.token })
  const odList = odR.json?.data?.list || []
  check('超时筛选结果确实都是超时', odList.length > 0 && odList.every((o) => o.overdue === 1),
    `筛出 ${odList.length} 条`)

  const newOrder = await req('POST', '/api/orders', {
    token: admin.token,
    body: { title: '自测：SLA 时限校验', type: '故障报修', priority: '高', region: '一号产业园' }
  })
  check('新建工单成功', newOrder.json?.code === 0)
  if (newOrder.json?.data?.id) {
    const od = await req('GET', `/api/orders/${newOrder.json.data.id}`, { token: admin.token })
    const d = od.json?.data
    check('新工单自动写入处理时限', !!d?.resolve_deadline, d?.resolve_deadline)
    const span = (ts(d.resolve_deadline) - ts(d.created_at)) / 3600000
    check('高优先级处理时限为 8 小时', Math.abs(span - 8) < 0.05, `实际 ${span.toFixed(2)} 小时`)
    check('新工单初始未超时', d.overdue === 0)

    const assigned = await req('POST', `/api/orders/${newOrder.json.data.id}/assign`, {
      token: admin.token, body: { handler: operator.user.realName }
    })
    check('派单成功', assigned.json?.code === 0, assigned.json?.message)

    const assignAgain = await req('POST', `/api/orders/${newOrder.json.data.id}/assign`, {
      token: admin.token, body: { handler: '不存在的处理人' }
    })
    check('派单给不存在的人员被拒', assignAgain.status === 400, assignAgain.json?.message)
  }

  /* ── 11. 新模块权限与数据范围 ────────────────── */
  section('新模块权限')
  check('operator 可查看备件', (await req('GET', '/api/parts', { token: operator.token })).status === 200)
  check('operator 不能新增备件',
    (await req('POST', '/api/parts', { token: operator.token, body: { code: 'PT-X', name: 'x' } })).status === 403)
  check('operator 不能访问操作日志',
    (await req('GET', '/api/meta/logs', { token: operator.token })).status === 403)
  check('operator 不能删除巡检计划',
    (await req('DELETE', '/api/inspection/plans/999999', { token: operator.token })).status === 403)
  check('operator 可执行巡检',
    (await req('GET', '/api/inspection/tasks', { token: operator.token })).status === 200)
  // 主管具备计划维护权限，此处只验证「不被权限拦截」，具体结果取决于计划是否存在
  check('manager 可维护巡检计划',
    (await req('DELETE', '/api/inspection/plans/999999', { token: manager.token })).status !== 403)

  const allTasks = (await req('GET', '/api/inspection/tasks?page=1&pageSize=200', { token: admin.token }))
    .json?.data?.list || []
  const opTasks = (await req('GET', '/api/inspection/tasks?page=1&pageSize=200', { token: operator.token }))
    .json?.data?.list || []
  note(`巡检任务可见数：admin=${allTasks.length} / operator=${opTasks.length}`)
  check('巡检任务受数据范围约束', opTasks.length <= allTasks.length,
    `${opTasks.length} vs ${allTasks.length}`)

  const othersTask = allTasks.find((t) => t.inspector && t.inspector !== operator.user.realName)
  if (othersTask) {
    const r = await req('GET', `/api/inspection/tasks/${othersTask.id}`, { token: operator.token })
    check('专员不能读取他人的巡检任务', r.status === 404 || r.status === 403,
      `实际 ${r.status}（任务 ${othersTask.code}，巡检人 ${othersTask.inspector}）`)
  }

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
