import express from 'express'
import compression from 'compression'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ensureSeedData } from './bootstrap.js'
import authRoutes from './routes/auth.js'
import metaRoutes from './routes/meta.js'
import deviceRoutes from './routes/devices.js'
import orderRoutes from './routes/orders.js'
import alarmRoutes from './routes/alarms.js'
import userRoutes from './routes/users.js'
import statRoutes from './routes/stats.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3001

const app = express()

// gzip：接口 JSON 与静态资源在传输前压缩，线上传输体积可降约 70%
app.use(compression())
app.use(express.json({ limit: '2mb' }))

// 请求体不是合法 JSON 时 Express 会抛解析异常 —— 转成 400，不要让它变成 500
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ code: 400, message: '请求体不是合法的 JSON' })
  }
  next(err)
})

// 简单请求日志，便于演示时观察接口调用
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.log(`[${new Date().toLocaleTimeString('zh-CN')}] ${req.method} ${req.path}`)
  }
  next()
})

app.use('/api/auth', authRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/devices', deviceRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/alarms', alarmRoutes)
app.use('/api/users', userRoutes)
app.use('/api/stats', statRoutes)

app.get('/api/health', (_, res) => res.json({ code: 0, data: { ok: true, ts: Date.now() } }))

/**
 * 运行时诊断：进程与时钟信息，用于排查部署环境差异（例如何时重启、时钟是否偏移）。
 * 刻意不暴露任何与密钥相关的信息。
 */
app.get('/api/diag', (_, res) => {
  const mem = process.memoryUsage()
  res.json({
    code: 0,
    data: {
      pid: process.pid,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      now: Date.now(),
      dbPath: process.env.DB_PATH || 'server/data.db',
      rssMB: Math.round(mem.rss / 1048576)
    }
  })
})

// API 兜底 404：未匹配的接口统一返回 JSON，否则前端会拿到 HTML 导致解析失败
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, message: `接口不存在：${req.method} ${req.originalUrl}` })
})

// 统一错误处理：把异常转成前端可识别的 JSON
// 注意：Express 依靠参数个数（4 个）识别错误处理中间件，_next 不能省略
app.use((err, req, res, _next) => {
  console.error('[server error]', err)
  res.status(500).json({ code: 500, message: err?.message || '服务端异常' })
})

// 生产模式：直接托管前端构建产物（同源部署，避免跨域与证书问题）
const dist = path.join(__dirname, '..', 'dist')

// 带内容哈希的产物可长期强缓存；index.html 每次校验，否则发版后用户会拿到旧页面
const HASHED_ASSET = /-[0-9a-zA-Z_]{8,}\.(js|css|woff2?|ttf|png|jpe?g|gif|svg)$/
app.use(express.static(dist, {
  setHeaders(res, filePath) {
    res.setHeader(
      'Cache-Control',
      HASHED_ASSET.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'
    )
  }
}))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  res.sendFile(path.join(dist, 'index.html'), (e) => e && next())
})

// 启动前确保有可演示的数据（容器重建 / 数据卷为空时自动生成）
ensureSeedData()

// 显式绑定 0.0.0.0：容器 / 反向代理部署时必须监听所有网卡
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  园区综合运维管理平台 · 服务已启动`)
  console.log(`  监听端口：${PORT}（PORT 环境变量可覆盖）`)
  console.log(`  数据库：${process.env.DB_PATH || 'server/data.db'}`)
  console.log(`  体验账号：admin / manager / operator（密码均 123456）\n`)
})

export default app
