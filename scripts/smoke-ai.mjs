#!/usr/bin/env node
/**
 * AI 助手端到端冒烟（零第三方依赖）
 *
 * 为什么单独一个脚本：模型调用必须在**应用发布域名**下才会被云服务接受，
 * 且部分失败（来源校验、额度、模型不可用）只在真实请求里才暴露。
 * 这个脚本用 CDP 驱动浏览器走完整流程：
 *   登录态注入 → 打开 AI 助手 → 等模型目录就绪 → 输入问题 → 发送 → 等流式回答
 *
 * 用法：node scripts/smoke-ai.mjs [baseUrl]
 * 默认目标取 src/config/cloud.ts 里的发布域名。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP_PORT = Number(process.env.CDP_PORT || 9224)
const EDGE = process.env.EDGE_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const OUT_DIR = path.resolve('smoke-shots')
const TOKEN_KEY = 'park_ops_token'
/** 回答最多等多久（推理型模型会先思考再出正文） */
const REPLY_TIMEOUT_MS = Number(process.env.AI_REPLY_TIMEOUT || 150000)

/** 默认目标 = 配置里的发布域名；本地跑必被来源校验拒绝，所以这里不给 localhost 兜底 */
const RELEASE = (() => {
  try {
    const src = fs.readFileSync(path.resolve('src/config/cloud.ts'), 'utf8')
    const hit = src.match(/endpoint:\s*'([^']+)'/)
    return hit ? hit[1].replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
})()

const BASE = (process.argv[2] || RELEASE || 'http://127.0.0.1:3001').replace(/\/+$/, '')
const QUESTION = process.env.AI_QUESTION || '用三句话总结当前运维整体状况'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const C = {
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`
}

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

  once(method, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待事件 ${method} 超时`)), timeout)
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
    } catch { /* 尚未就绪 */ }
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
  const results = []
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail })
    console.log(`  ${ok ? C.green('[PASS]') : C.red('[FAIL]')} ${name}${detail ? C.gray(' — ' + detail) : ''}`)
  }

  console.log(C.bold(`\nAI 助手 · 端到端冒烟\n目标：${BASE}\n问题：${QUESTION}\n${'─'.repeat(56)}`))
  if (!fs.existsSync(EDGE)) throw new Error(`找不到浏览器：${EDGE}`)

  const userDataDir = path.join(os.tmpdir(), 'wb-smoke-ai-' + Date.now())
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`, '--window-size=1440,900', 'about:blank'
  ]

  const child = spawn(EDGE, args, { stdio: 'ignore', detached: false })
  let cdp = null
  const consoleErrors = []
  const httpErrors = []

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

    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Network.enable')
    cdp.on('Network.responseReceived', (p) => {
      const st = p.response?.status || 0
      // 401 来自「未带应用标识」的探测，不算异常；其余 4xx/5xx 记录
      if (st >= 400) httpErrors.push(`${st} ${String(p.response.url || '').replace(BASE, '')}`)
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

    /* ── 1. 登录并进入 AI 助手 ── */
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '123456' })
    }).then((r) => r.json())
    if (loginRes.code !== 0) throw new Error('登录接口异常：' + JSON.stringify(loginRes))

    console.log(C.bold('▶ 打开页面'))
    let nav = cdp.once('Page.loadEventFired').catch(() => {})
    await cdp.send('Page.navigate', { url: BASE })
    await nav
    await sleep(1000)

    // 注入登录态：必须先站到站点源上，about:blank 上写 localStorage 是无效的。
    // 写完之后还要整页重载 —— 应用的用户态在启动时读取，
    // 只改 hash 属于同文档导航，store 不会重新初始化，会被路由守卫拦回登录页。
    await evaluate(cdp, `localStorage.setItem(${JSON.stringify(TOKEN_KEY)}, ${JSON.stringify(loginRes.data.token)})`)
    nav = cdp.once('Page.loadEventFired').catch(() => {})
    await cdp.send('Page.reload')
    await nav
    await sleep(1500)

    await evaluate(cdp, `location.hash = '#/assistant'`)
    await sleep(3000)

    const rendered = await evaluate(cdp, '!!document.querySelector(".composer")')
    check('对话页已渲染', rendered,
      rendered ? '' : `当前 hash=${await evaluate(cdp, 'location.hash')}（可能被路由守卫拦回登录页）`)
    if (!rendered) throw new Error('对话页未渲染，后续检查无法进行')

    /* ── 2. 等模型目录就绪 ── */
    console.log(C.bold('\n▶ 模型目录'))
    let footer = ''
    for (let i = 0; i < 30; i++) {
      footer = await evaluate(cdp, 'document.querySelector(".ai-foot")?.textContent || ""')
      if (/可选模型\s*\d+/.test(footer)) break
      await sleep(800)
    }
    check('模型目录加载成功', /可选模型\s*(\d+)/.test(footer), footer.trim().slice(0, 90))

    const modelCount = Number((footer.match(/可选模型\s*(\d+)/) || [])[1] || 0)
    const freeCount = Number((footer.match(/免费\s*(\d+)/) || [])[1] || 0)
    check('模型目录非空', modelCount > 0, `${modelCount} 个`)
    check('存在免费（倍率 0）模型', freeCount > 0, `${freeCount} 个免费`)

    const selected = await evaluate(cdp, 'document.querySelector(".n-base-selection-label")?.textContent || ""')
    check('默认选中了免费模型', selected.includes('免费'), selected.trim())

    /* ── 3. 提问并等待流式回答 ── */
    console.log(C.bold('\n▶ 真实对话'))
    const typed = await evaluate(cdp, `(() => {
      const el = document.querySelector('.composer textarea')
      if (!el) return false
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, ${JSON.stringify(QUESTION)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return el.value === ${JSON.stringify(QUESTION)}
    })()`)
    check('问题已填入输入框', typed === true)
    await sleep(300)
    const clicked = await evaluate(cdp, `(() => {
      const btn = [...document.querySelectorAll('.composer button')].find(b => b.textContent.includes('发送'))
      if (!btn) return false
      btn.click()
      return true
    })()`)
    check('发送按钮可点击', clicked === true)

    let reply = ''
    let reasoningLen = 0
    const startedAt = Date.now()
    while (Date.now() - startedAt < REPLY_TIMEOUT_MS) {
      const state = await evaluate(cdp, `(() => {
        const items = [...document.querySelectorAll('.msg.assistant')]
        const last = items[items.length - 1]
        return {
          content: last?.querySelector('.content')?.textContent || '',
          reasoning: last?.querySelector('.reason-body')?.textContent?.length || 0,
          err: last?.querySelector('.err')?.textContent || '',
          generating: !!document.querySelector('.composer button')?.textContent?.includes('停止')
        }
      })()`)
      reply = state.content || ''
      reasoningLen = state.reasoning || 0
      if (state.err) { reply = ''; check('模型调用未报错', false, state.err.slice(0, 160)); break }
      if (reply.length > 20 && !state.generating) break
      await sleep(1200)
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    check('模型返回了回答', reply.length > 0, `${reply.length} 字，耗时 ${seconds}s`)
    check('回答内容是中文正文', /[\u4e00-\u9fa5]/.test(reply))
    if (freeCount > 0) {
      // 默认走免费模型时，回答里应当带上快照里的真实数字，说明数据确实注入了
      const hasData = /\d/.test(reply)
      check('回答中引用了业务数据（含数字）', hasData, hasData ? '' : '回答中没有出现任何数字，可能未读到快照')
    }

    const usage = await evaluate(cdp, 'document.querySelector(".ai-foot")?.textContent || ""')
    check('用量信息已回传', /tokens/.test(usage), (usage.match(/本次消耗\s*\d+\s*tokens/) || ['(无)'])[0])

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, 'ai-assistant.png'), Buffer.from(shot.data, 'base64'))

    /* ── 4. 运行时报错 ── */
    console.log(C.bold('\n▶ 运行时错误'))
    const realHttp = [...new Set(httpErrors)].filter((e) => !/\s401\s/.test(' ' + e))
    check('无控制台报错', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '))
    check('无异常 HTTP 响应', realHttp.length === 0, realHttp.slice(0, 3).join(' | '))

    console.log('\n' + '─'.repeat(56))
    if (reply) {
      console.log(C.bold('模型回答（前 400 字）：'))
      console.log(C.gray(reply.slice(0, 400) + (reply.length > 400 ? ' …' : '')))
      console.log(C.gray(`思考过程累积 ${reasoningLen} 字（界面上可展开查看）`))
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n通过 ${C.green(results.length - failed.length)} 项，失败 ${C.red(failed.length)} 项`)
    console.log(C.gray(`截图已保存到 ${OUT_DIR}/ai-assistant.png`))
    if (failed.length) process.exitCode = 1
  } finally {
    try { cdp?.ws.close() } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    await sleep(500)
    try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(C.red('\n[x] ' + (e?.message || e)))
  process.exitCode = 1
})
