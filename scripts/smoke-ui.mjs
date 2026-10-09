#!/usr/bin/env node
/**
 * 前端冒烟测试（零第三方依赖）
 *
 * 用系统 Edge 的无头模式 + CDP 协议逐个打开路由，检查：
 *   1. 关键元素是否渲染出来（表格 / 图表 canvas / 菜单）
 *   2. 控制台是否抛出错误
 *   3. 截图留档，便于人工复核
 *
 * 用法：node scripts/smoke-ui.mjs [baseUrl]
 * 可用环境变量：EDGE_PATH（浏览器路径）、CDP_PORT、SMOKE_HEADFUL=1（显示窗口）
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = (process.argv[2] || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const CDP_PORT = Number(process.env.CDP_PORT || 9223)
const EDGE = process.env.EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const HEADFUL = process.env.SMOKE_HEADFUL === '1'
const OUT_DIR = path.resolve('smoke-shots')
const TOKEN_KEY = 'park_ops_token'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const C = {
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

/** 需要检查的路由：expect 为选择器，min 为最少数量 */
const PAGES = [
  { hash: '/login', name: '登录页', expect: '.n-button', min: 1, auth: false },
  { hash: '/dashboard', name: '首页看板', expect: 'canvas', min: 6, auth: true },
  { hash: '/device', name: '设备台账', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/inspection', name: '巡检管理', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/order', name: '工单中心', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/alarm', name: '告警中心', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/part', name: '备件库存', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/report', name: '报表中心', expect: 'canvas', min: 1, auth: true },
  { hash: '/system/user', name: '用户管理', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/system/role', name: '角色权限', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/system/dict', name: '数据字典', expect: '.n-data-table', min: 1, auth: true },
  { hash: '/system/log', name: '操作日志', expect: '.n-data-table', min: 1, auth: true }
]

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } else if (msg.method) {
        const handlers = this.listeners.get(msg.method) || []
        handlers.forEach((fn) => fn(msg.params))
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(fn)
  }

  /** 等待某个 CDP 事件（先注册再触发动作） */
  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = this.listeners.get(method) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
        reject(new Error(`等待事件 ${method} 超时`))
      }, timeout)
      const fn = (p) => {
        clearTimeout(timer)
        const arr = this.listeners.get(method) || []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
        resolve(p)
      }
      this.on(method, fn)
    })
  }
}

async function waitForCdp(timeoutMs = 25000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(300)
  }
  throw new Error('CDP 端口未就绪，浏览器可能启动失败')
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

async function main() {
  console.log(C.bold(`\n园区综合运维管理平台 · 前端冒烟测试\n目标：${BASE}\n${'─'.repeat(56)}`))

  if (!fs.existsSync(EDGE)) throw new Error(`找不到浏览器：${EDGE}`)

  // 用独立 user-data-dir，避免和用户正在使用的 Edge 抢占单实例
  const userDataDir = path.join(os.tmpdir(), 'wb-smoke-' + Date.now())
  const args = [
    HEADFUL ? '' : '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    'about:blank'
  ].filter(Boolean)

  const child = spawn(EDGE, args, { stdio: 'ignore', detached: false })
  let cdp = null
  const issues = []

  try {
    await waitForCdp()
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (!page) throw new Error('未找到可用的浏览器页面')

    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true })
    })
    cdp = new Cdp(ws)

    const consoleErrors = []
    const httpErrors = []
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    // 记录所有 4xx/5xx 响应，用于定位「页面元素在、但接口报错」的情况
    cdp.on('Network.responseReceived', (p) => {
      const st = p.response?.status || 0
      if (st >= 400) {
        httpErrors.push(`${st} ${String(p.response.url || '').replace(BASE, '')}`)
      }
    })
    cdp.on('Runtime.exceptionThrown', (p) =>
      consoleErrors.push('未捕获异常: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text)))
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        consoleErrors.push('console.error: ' + (p.args || []).map((a) => a.value ?? a.description).join(' '))
      }
    })
    cdp.on('Log.entryAdded', (p) => {
      if (p.entry?.level === 'error') consoleErrors.push('日志错误: ' + p.entry.text)
    })

    // 登录取 token（直接走接口，避免依赖页面表单）
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '123456' })
    }).then((r) => r.json())
    if (loginRes.code !== 0) throw new Error('登录接口异常：' + JSON.stringify(loginRes))
    const token = loginRes.data.token
    console.log(C.gray(`已获取 admin token（${token.slice(0, 16)}…）`))

    fs.mkdirSync(OUT_DIR, { recursive: true })

    let pass = 0
    for (const pg of PAGES) {
      if (pg.auth && !(await evaluate(cdp, `!!localStorage.getItem(${JSON.stringify(TOKEN_KEY)})`))) {
        // 首次进入受保护页面之前注入登录态
        await evaluate(cdp, `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(token)})`)
        const reloaded = cdp.once('Page.loadEventFired').catch(() => {})
        await cdp.send('Page.reload')
        await reloaded
        await sleep(1200)
      }

      consoleErrors.length = 0
      httpErrors.length = 0
      const nav = cdp.once('Page.loadEventFired').catch(() => {})
      await cdp.send('Page.navigate', { url: `${BASE}/#${pg.hash}` })
      await nav
      await sleep(1600) // 等 Vue 挂载 + ECharts 绘制 + 接口返回

      const rawUrl = await evaluate(cdp, 'location.hash')
      const count = await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(pg.expect)}).length`)
      const menuCount = await evaluate(cdp, 'document.querySelectorAll(".n-menu-item").length')

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT_DIR, pg.hash.replace(/[^\w]+/g, '_').replace(/^_/, '') + '.png')
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))

      const ok = count >= pg.min && consoleErrors.length === 0 && httpErrors.length === 0
      if (ok) pass++
      else issues.push({ page: pg.name, count, expect: pg.expect, errors: [...consoleErrors], http: [...httpErrors] })

      console.log(
        `  ${ok ? C.green('[PASS]') : C.red('[FAIL]')} ${pg.name.padEnd(6, '　')} ` +
        C.gray(`${pg.expect}×${count}（需 ≥${pg.min}）菜单 ${menuCount} 项 hash=${rawUrl}`)
      )
      if (consoleErrors.length) {
        consoleErrors.slice(0, 3).forEach((e) => console.log(C.red('         ↳ ' + e.slice(0, 160))))
      }
      if (httpErrors.length) {
        ;[...new Set(httpErrors)].slice(0, 5).forEach((e) => console.log(C.red('         ↳ HTTP ' + e.slice(0, 160))))
      }
    }

    console.log('\n' + '─'.repeat(56))
    console.log(`页面检查 ${PAGES.length} 项，通过 ${C.green(pass)} 项，异常 ${C.red(issues.length)} 项`)
    console.log(C.gray(`截图已保存到 ${OUT_DIR}`))
    if (issues.length) process.exitCode = 1
  } finally {
    try { cdp?.ws.close() } catch { /* ignore */ }
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* ignore */ }
    await sleep(500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(C.red('\n[x] ' + (e?.message || e)))
  process.exitCode = 1
})
