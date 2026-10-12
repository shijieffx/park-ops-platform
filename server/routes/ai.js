import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, scopeFilter, ROLE_NAME } from '../middleware/auth.js'
import { nowText } from '../utils/time.js'

const router = Router()

const STATUS_TEXT = { PENDING: '待受理', PROCESSING: '处理中', CHECKING: '待验收', CLOSED: '已闭环' }
const SCOPE_TEXT = { ALL: '全部区域', REGION: '本区域', SELF: '仅本人相关' }

/**
 * 生成「当前登录账号数据权限范围内」的运行时快照。
 *
 * 为什么需要它：大模型本身不知道本平台的任何业务数据，如果不给事实依据，
 * 面对"现在有多少台设备告警"这类问题只会编造数字。
 * 因此这里把该用户**有权看到**的统计与少量样本压成一段紧凑文本，随每次提问发给模型。
 *
 * 关键点：快照同样受数据范围约束（复用 scopeFilter），所以
 * 专员问不出全量数据、主管只看得到自己区域 —— 与界面上的可见范围完全一致。
 */
function buildSnapshot(user) {
  const d = scopeFilter('devices', user)
  const o = scopeFilter('work_orders', user)
  const a = scopeFilter('alarms', user)
  const i = scopeFilter('inspection_tasks', user)

  const one = (sql, params = []) => db.prepare(sql).get(...params).c
  const ts = nowText()
  const today = ts.slice(0, 10)

  /* ---------- 设备 ---------- */
  const deviceTotal = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql}`, d.params)
  const deviceRunning = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND status = '运行中'`, d.params)
  const deviceAlarm = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND status = '告警'`, d.params)
  const deviceMaintain = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND status = '检修中'`, d.params)
  const byRegion = db.prepare(
    `SELECT region, COUNT(*) c FROM devices WHERE ${d.sql} GROUP BY region ORDER BY c DESC LIMIT 6`
  ).all(...d.params)

  /* ---------- 工单 ---------- */
  const orderRows = db.prepare(
    `SELECT status, COUNT(*) c FROM work_orders WHERE ${o.sql} GROUP BY status`
  ).all(...o.params)
  const orderTotal = orderRows.reduce((s, r) => s + r.c, 0)
  const st = (k) => orderRows.find((r) => r.status === k)?.c || 0

  const orderOverdue = one(
    `SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status != 'CLOSED'
       AND resolve_deadline != '' AND resolve_deadline < ?`,
    [...o.params, ts]
  )
  const orderOverdueHigh = one(
    `SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status != 'CLOSED' AND priority = '高'
       AND resolve_deadline != '' AND resolve_deadline < ?`,
    [...o.params, ts]
  )
  const overdueSamples = db.prepare(
    `SELECT code, title, priority, device_code, resolve_deadline FROM work_orders
     WHERE ${o.sql} AND status != 'CLOSED' AND resolve_deadline != '' AND resolve_deadline < ?
     ORDER BY resolve_deadline ASC LIMIT 5`
  ).all(...o.params, ts)

  /* ---------- 告警 ---------- */
  const alarmOpen = one(`SELECT COUNT(*) c FROM alarms WHERE ${a.sql} AND status = '未处理'`, a.params)
  const alarmP1 = one(
    `SELECT COUNT(*) c FROM alarms WHERE ${a.sql} AND level = '紧急' AND status = '未处理'`, a.params
  )

  /* ---------- 巡检 ---------- */
  const inspectPending = one(
    `SELECT COUNT(*) c FROM inspection_tasks WHERE ${i.sql} AND status = 'PENDING'`, i.params
  )
  const inspectOverdue = one(
    `SELECT COUNT(*) c FROM inspection_tasks WHERE ${i.sql} AND status = 'PENDING' AND plan_date < ?`,
    [...i.params, today]
  )

  /* ---------- 备件 ---------- */
  const partTotal = one('SELECT COUNT(*) c FROM parts')
  const lowParts = one('SELECT COUNT(*) c FROM parts WHERE stock < safety_stock')
  const lowPartsList = db.prepare(
    `SELECT name, spec, unit, stock, safety_stock FROM parts
     WHERE stock < safety_stock ORDER BY (safety_stock - stock) DESC LIMIT 5`
  ).all()

  /* ---------- 组装成文本 ---------- */
  const lines = []
  lines.push(`【当前账号】${user.real_name || user.username}（${ROLE_NAME[user.role_code] || user.role_code}）`)
  lines.push(`【数据范围】${SCOPE_TEXT[user.scope] || user.scope}${user.region ? `（${user.region}）` : ''}`)
  lines.push(`【快照时间】${ts}`)
  lines.push('')
  lines.push(`【设备】共 ${deviceTotal} 台 —— 运行中 ${deviceRunning}、告警 ${deviceAlarm}、检修中 ${deviceMaintain}`)
  if (byRegion.length) {
    lines.push(`  区域分布：${byRegion.map((r) => `${r.region} ${r.c} 台`).join('；')}`)
  }
  lines.push(
    `【工单】共 ${orderTotal} 张 —— ` +
    Object.keys(STATUS_TEXT).map((k) => `${STATUS_TEXT[k]} ${st(k)}`).join('、')
  )
  lines.push(`  处理超时（未闭环且已过处理时限）：${orderOverdue} 张，其中高优先级 ${orderOverdueHigh} 张`)
  if (overdueSamples.length) {
    lines.push('  超时工单样本（按超时程度排序）：')
    for (const r of overdueSamples) {
      lines.push(`    ${r.code}｜${r.priority}优先级｜设备 ${r.device_code || '-'}｜处理时限 ${r.resolve_deadline}｜${r.title}`)
    }
  }
  lines.push(`【巡检】待执行 ${inspectPending} 个任务，其中已逾期 ${inspectOverdue} 个`)
  lines.push(`【告警】未处理 ${alarmOpen} 条，其中紧急 ${alarmP1} 条`)
  lines.push(`【备件】共 ${partTotal} 种，低于安全库存 ${lowParts} 种`)
  if (lowPartsList.length) {
    lines.push(
      '  低库存明细：' +
      lowPartsList.map((p) => `${p.name}（现存 ${p.stock}/${p.safety_stock} ${p.unit}）`).join('；')
    )
  }

  return {
    snapshot: lines.join('\n'),
    scope: user.scope,
    scopeText: SCOPE_TEXT[user.scope] || user.scope,
    region: user.region || '',
    roleName: ROLE_NAME[user.role_code] || user.role_code,
    generatedAt: ts
  }
}

/**
 * AI 助手的事实依据 —— GET /api/ai/context
 *
 * 注意：这里**只提供本平台自己的业务数据**，不代理任何大模型请求。
 * 模型调用由前端通过云服务 SDK 直接发起（密钥不下发到浏览器）。
 */
router.get('/context', authRequired, (req, res) => {
  res.json({ code: 0, data: buildSnapshot(req.user) })
})

export default router
