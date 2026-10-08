import express from 'express'
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
app.use(express.json({ limit: '2mb' }))

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

// 统一错误处理：把异常转成前端可识别的 JSON
app.use((err, req, res, next) => {
  console.error('[server error]', err)
  res.status(500).json({ code: 500, message: err?.message || '服务端异常' })
})

// 生产模式：直接托管前端构建产物（同源部署，避免跨域与证书问题）
const dist = path.join(__dirname, '..', 'dist')
app.use(express.static(dist))
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next()
  res.sendFile(path.join(dist, 'index.html'), (e) => e && next())
})

// 启动前确保有可演示的数据（容器重建 / 数据卷为空时自动生成）
ensureSeedData()

app.listen(PORT, () => {
  console.log(`\n  园区综合运维管理平台 · 服务已启动`)
  console.log(`  监听端口：${PORT}（PORT 环境变量可覆盖）`)
  console.log(`  数据库：${process.env.DB_PATH || 'server/data.db'}`)
  console.log(`  体验账号：admin / manager / operator（密码均 123456）\n`)
})

export default app
