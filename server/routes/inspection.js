import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, permit, scopeFilter, writeLog } from '../middleware/auth.js'
import { parsePaging, toKeyword } from '../utils/validate.js'
import { calcDeadlines, nowText } from '../utils/sla.js'

const router = Router()

/** 巡检任务的可见范围复用统一的数据范围规则（专员只看本人负责的任务） */
const taskScope = (user) => scopeFilter('inspection_tasks', user)

/** 在可见范围内取任务，越权与不存在返回同一结果 */
function findTask(id, user) {
  const sc = taskScope(user)
  return db
    .prepare(`SELECT * FROM inspection_tasks WHERE id = ? AND ${sc.sql}`)
    .get(id, ...sc.params)
}

const parseItems = (raw) => {
  if (Array.isArray(raw)) return raw.filter(Boolean)
  if (typeof raw !== 'string') return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(Boolean) : []
  } catch {
    // 兼容用顿号 / 逗号手写检查项
    return raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean)
  }
}

/* ─────────────────── 巡检计划 ─────────────────── */

/** 计划列表 —— GET /api/inspection/plans */
router.get('/plans', authRequired, (req, res) => {
  const rows = db.prepare('SELECT * FROM inspection_plans ORDER BY id ASC').all()
  const tasks = db.prepare(
    `SELECT plan_id, COUNT(*) total,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) done,
            SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) pending
     FROM inspection_tasks GROUP BY plan_id`
  ).all()
  const map = Object.fromEntries(tasks.map((t) => [t.plan_id, t]))
  res.json({
    code: 0,
    data: rows.map((p) => ({
      ...p,
      items: parseItems(p.items),
      taskTotal: map[p.id]?.total || 0,
      taskDone: map[p.id]?.done || 0,
      taskPending: map[p.id]?.pending || 0
    }))
  })
})

/** 新增 / 编辑计划 —— POST /api/inspection/plans */
router.post('/plans', authRequired, permit('inspection:plan'), (req, res) => {
  const d = req.body || {}
  if (!d.name) return res.status(400).json({ code: 400, message: '计划名称必填' })
  if (!d.region) return res.status(400).json({ code: 400, message: '巡检区域必填' })
  const items = parseItems(d.items)
  if (!items.length) return res.status(400).json({ code: 400, message: '至少需要一个检查项' })

  const payload = [d.name, d.region, d.category || '', d.cycle || '每日',
    JSON.stringify(items), d.owner || '', d.status == null ? 1 : Number(d.status)]

  if (d.id) {
    const exist = db.prepare('SELECT id FROM inspection_plans WHERE id = ?').get(d.id)
    if (!exist) return res.status(404).json({ code: 404, message: '计划不存在' })
    db.prepare(
      `UPDATE inspection_plans SET name=?, region=?, category=?, cycle=?, items=?, owner=?, status=? WHERE id=?`
    ).run(...payload, d.id)
    writeLog(req.user.username, '巡检计划', `编辑计划「${d.name}」`)
    return res.json({ code: 0, message: '保存成功' })
  }

  db.prepare(
    `INSERT INTO inspection_plans (name, region, category, cycle, items, owner, status, next_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(...payload, nowText().slice(0, 10), nowText())
  writeLog(req.user.username, '巡检计划', `新增计划「${d.name}」`)
  res.json({ code: 0, message: '新增成功' })
})

/** 启停 / 删除计划 —— PUT /api/inspection/plans/:id/status、DELETE /api/inspection/plans/:id */
router.put('/plans/:id/status', authRequired, permit('inspection:plan'), (req, res) => {
  const exist = db.prepare('SELECT id FROM inspection_plans WHERE id = ?').get(req.params.id)
  if (!exist) return res.status(404).json({ code: 404, message: '计划不存在' })
  db.prepare('UPDATE inspection_plans SET status = ? WHERE id = ?')
    .run(req.body?.status ? 1 : 0, req.params.id)
  res.json({ code: 0, message: '状态已更新' })
})

router.delete('/plans/:id', authRequired, permit('inspection:plan'), (req, res) => {
  const used = db.prepare('SELECT COUNT(*) c FROM inspection_tasks WHERE plan_id = ?').get(req.params.id)
  if (used.c > 0) {
    return res.status(400).json({ code: 400, message: '该计划已产生巡检任务，不能删除（可改为停用）' })
  }
  db.prepare('DELETE FROM inspection_plans WHERE id = ?').run(req.params.id)
  writeLog(req.user.username, '巡检计划', `删除计划 #${req.params.id}`)
  res.json({ code: 0, message: '删除成功' })
})

/* ─────────────────── 巡检任务 ─────────────────── */

/** 任务列表 —— GET /api/inspection/tasks */
router.get('/tasks', authRequired, (req, res) => {
  const { status = '', planId = '', dateFrom = '', dateTo = '' } = req.query
  const keyword = toKeyword(req.query.keyword)
  const { page, pageSize, offset } = parsePaging(req.query)
  const sc = taskScope(req.user)
  const where = [sc.sql]
  const params = [...sc.params]

  if (status) { where.push('status = ?'); params.push(status) }
  if (planId) { where.push('plan_id = ?'); params.push(Number(planId)) }
  if (dateFrom) { where.push('plan_date >= ?'); params.push(dateFrom) }
  if (dateTo) { where.push('plan_date <= ?'); params.push(dateTo) }
  if (keyword) {
    where.push('(code LIKE ? OR plan_name LIKE ? OR inspector LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }

  const cond = where.join(' AND ')
  const total = db.prepare(`SELECT COUNT(*) c FROM inspection_tasks WHERE ${cond}`).get(...params).c
  const rows = db.prepare(
    `SELECT * FROM inspection_tasks WHERE ${cond} ORDER BY plan_date DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, offset)
  res.json({ code: 0, data: { list: rows, total, page, pageSize } })
})

/** 任务详情（含检查记录）—— GET /api/inspection/tasks/:id */
router.get('/tasks/:id', authRequired, (req, res) => {
  const task = findTask(req.params.id, req.user)
  if (!task) return res.status(404).json({ code: 404, message: '巡检任务不存在或无权访问' })
  const records = db.prepare(
    'SELECT * FROM inspection_records WHERE task_id = ? ORDER BY id ASC'
  ).all(req.params.id)
  const plan = db.prepare('SELECT * FROM inspection_plans WHERE id = ?').get(task.plan_id)
  res.json({
    code: 0,
    data: { ...task, records, items: plan ? parseItems(plan.items) : [] }
  })
})

/** 按计划生成今日任务 —— POST /api/inspection/tasks/generate */
router.post('/tasks/generate', authRequired, permit('inspection:edit'), (req, res) => {
  const planDate = req.body?.date || nowText().slice(0, 10)
  const plans = db.prepare('SELECT * FROM inspection_plans WHERE status = 1').all()
  let created = 0
  let skipped = 0

  const insTask = db.prepare(
    `INSERT INTO inspection_tasks (code, plan_id, plan_name, region, inspector, status, plan_date,
                                   finished_at, total, abnormal, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )

  for (const p of plans) {
    const code = `INS${String(p.id).padStart(2, '0')}${planDate.replace(/-/g, '')}`
    if (db.prepare('SELECT id FROM inspection_tasks WHERE code = ?').get(code)) {
      skipped++
      continue
    }
    const items = parseItems(p.items)
    // 专员自己触发时直接认领，管理员 / 主管触发则留给负责人
    const inspector = req.user.scope === 'SELF' ? req.user.real_name : (p.owner || '')
    insTask.run(code, p.id, p.name, p.region, inspector, 'PENDING', planDate,
      '', items.length, 0, nowText())
    created++
  }

  writeLog(req.user.username, '巡检任务', `生成 ${planDate} 的任务：新建 ${created} 个，跳过 ${skipped} 个`)
  res.json({
    code: 0,
    message: `已生成 ${created} 个任务${skipped ? `，跳过 ${skipped} 个已存在` : ''}`,
    data: { created, skipped, date: planDate }
  })
})

/**
 * 提交巡检结果 —— POST /api/inspection/tasks/:id/submit
 * body: { results: [{ item, deviceCode, result: '正常'|'异常', note }], remark }
 *
 * 业务闭环：登记检查项 → 统计异常 → 异常项自动生成告警与工单（带 SLA 时限）→ 任务置为已完成
 */
router.post('/tasks/:id/submit', authRequired, permit('inspection:edit'), (req, res) => {
  const task = findTask(req.params.id, req.user)
  if (!task) return res.status(404).json({ code: 404, message: '巡检任务不存在或无权访问' })
  if (task.status === 'DONE') {
    return res.status(400).json({ code: 400, message: '该巡检任务已完成，不能重复提交' })
  }

  const results = Array.isArray(req.body?.results) ? req.body.results : []
  if (!results.length) return res.status(400).json({ code: 400, message: '请至少登记一个检查项' })

  const items = results.filter((r) => r && r.item)
  const abnormalList = items.filter((r) => r.result === '异常')
  const ts = nowText()

  const createdOrders = []
  const tx = db.transaction(() => {
    const insRec = db.prepare(
      'INSERT INTO inspection_records (task_id, item, device_code, result, note, created_at) VALUES (?,?,?,?,?,?)'
    )
    for (const r of items) {
      insRec.run(task.id, String(r.item), r.deviceCode || '', r.result === '异常' ? '异常' : '正常',
        r.note || '', ts)
    }

    const insAlarm = db.prepare(
      'INSERT INTO alarms (device_code, device_name, level, content, status, region, created_at) VALUES (?,?,?,?,?,?,?)'
    )
    const insOrder = db.prepare(
      `INSERT INTO work_orders (code, title, type, priority, status, device_code, creator, handler, region,
                                response_deadline, resolve_deadline, responded_at, overdue, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const insTl = db.prepare(
      'INSERT INTO wo_timeline (order_id, action, operator, note, created_at) VALUES (?,?,?,?,?)'
    )
    const seqBase = db.prepare('SELECT COUNT(*) c FROM work_orders').get().c

    abnormalList.forEach((r, i) => {
      const devCode = r.deviceCode || ''
      const dev = devCode
        ? db.prepare('SELECT name, region FROM devices WHERE code = ?').get(devCode)
        : null

      // 1) 产生告警（异常必告警）
      insAlarm.run(devCode, dev?.name || '', '重要',
        `巡检发现异常：${r.item}${r.note ? '（' + r.note + '）' : ''}`, '未处理',
        dev?.region || task.region || '', ts)

      // 2) 自动转工单，优先级按异常项取「高」，并按 SLA 写入时限
      const code = `WO${String(seqBase + i + 1).padStart(5, '0')}`
      const priority = '高'
      const { responseDeadline, resolveDeadline } = calcDeadlines(priority, ts)
      const info = insOrder.run(
        code, `巡检异常：${r.item}`, '故障报修', priority, 'PENDING', devCode,
        req.user.real_name, '', dev?.region || task.region || '',
        responseDeadline, resolveDeadline, '', 0, ts, ts
      )
      insTl.run(info.lastInsertRowid, '创建工单', req.user.real_name,
        `由巡检任务 ${task.code} 自动生成`, ts)
      createdOrders.push(code)
    })

    db.prepare(
      `UPDATE inspection_tasks SET status = 'DONE', inspector = ?, finished_at = ?,
                                   total = ?, abnormal = ? WHERE id = ?`
    ).run(task.inspector || req.user.real_name, ts, items.length, abnormalList.length, task.id)
  })

  try {
    tx()
  } catch (err) {
    return res.status(500).json({ code: 500, message: '提交失败：' + err.message })
  }

  writeLog(req.user.username, '巡检执行',
    `完成任务 ${task.code}，检查 ${items.length} 项，异常 ${abnormalList.length} 项` +
    (createdOrders.length ? `，自动建单 ${createdOrders.join('、')}` : ''))

  res.json({
    code: 0,
    message: abnormalList.length
      ? `提交成功，发现 ${abnormalList.length} 项异常，已自动生成 ${createdOrders.length} 张工单`
      : '提交成功，本次巡检全部正常',
    data: { total: items.length, abnormal: abnormalList.length, orders: createdOrders }
  })
})

/** 巡检统计 —— GET /api/inspection/stats/summary */
router.get('/stats/summary', authRequired, (req, res) => {
  const sc = taskScope(req.user)
  const one = (sql) => db.prepare(sql).get(...sc.params).c
  const pending = one(`SELECT COUNT(*) c FROM inspection_tasks WHERE ${sc.sql} AND status = 'PENDING'`)
  const done = one(`SELECT COUNT(*) c FROM inspection_tasks WHERE ${sc.sql} AND status = 'DONE'`)
  const abnormalTasks = one(`SELECT COUNT(*) c FROM inspection_tasks WHERE ${sc.sql} AND abnormal > 0`)

  const trend = db.prepare(
    `SELECT plan_date AS date, COUNT(*) AS value FROM inspection_tasks
     WHERE ${sc.sql} AND status = 'DONE' GROUP BY plan_date ORDER BY plan_date DESC LIMIT 14`
  ).all(...sc.params).reverse()

  const byRegion = db.prepare(
    `SELECT region AS name, COUNT(*) AS value FROM inspection_tasks
     WHERE ${sc.sql} GROUP BY region ORDER BY value DESC`
  ).all(...sc.params)

  const planProgress = db.prepare(
    `SELECT plan_name AS name,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done
     FROM inspection_tasks WHERE ${sc.sql} GROUP BY plan_name ORDER BY total DESC LIMIT 8`
  ).all(...sc.params)

  res.json({
    code: 0,
    data: { pending, done, abnormalTasks, trend, byRegion, planProgress }
  })
})

/** 到期未执行的巡检任务（用于看板提醒）—— GET /api/inspection/stats/overdue */
router.get('/stats/overdue', authRequired, (req, res) => {
  const sc = taskScope(req.user)
  const today = nowText().slice(0, 10)
  const rows = db.prepare(
    `SELECT * FROM inspection_tasks
     WHERE ${sc.sql} AND status = 'PENDING' AND plan_date < ?
     ORDER BY plan_date ASC LIMIT 20`
  ).all(...sc.params, today)
  res.json({ code: 0, data: rows.map((r) => ({ ...r, overdueDays: 1 })) })
})

/** 供前端复用的 SLA 参考值 */
router.get('/meta/sla', authRequired, (_, res) => {
  res.json({ code: 0, data: { hours: { 高: { respond: 2, resolve: 8 }, 中: { respond: 8, resolve: 24 }, 低: { respond: 24, resolve: 72 } } } })
})

export default router
