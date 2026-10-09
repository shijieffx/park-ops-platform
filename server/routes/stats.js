import { Router } from 'express'
import { db } from '../db.js'
import { authRequired, scopeFilter } from '../middleware/auth.js'
import { nowText } from '../utils/sla.js'

const router = Router()

/**
 * 首页看板聚合数据 —— GET /api/stats/dashboard
 * 所有统计均受角色数据范围约束：admin 全量 / manager 本区域 / operator 仅本人
 */
router.get('/dashboard', authRequired, (req, res) => {
  const d = scopeFilter('devices', req.user)
  const o = scopeFilter('work_orders', req.user)
  const a = scopeFilter('alarms', req.user)

  const one = (sql, params) => db.prepare(sql).get(...params)

  const deviceTotal = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql}`, d.params).c
  const deviceAlarm = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND status='告警'`, d.params).c
  const deviceMaintain = one(`SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND status='检修中'`, d.params).c

  const orderPending = one(`SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status='PENDING'`, o.params).c
  const orderProcessing = one(`SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status='PROCESSING'`, o.params).c
  const orderClosed = one(`SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status='CLOSED'`, o.params).c

  const alarmOpen = one(`SELECT COUNT(*) c FROM alarms WHERE ${a.sql} AND status='未处理'`, a.params).c
  const alarmP1 = one(`SELECT COUNT(*) c FROM alarms WHERE ${a.sql} AND level='紧急' AND status='未处理'`, a.params).c

  const byRegion = db.prepare(
    `SELECT region AS name, COUNT(*) AS value FROM devices WHERE ${d.sql} GROUP BY region ORDER BY value DESC`
  ).all(...d.params)

  const byCategory = db.prepare(
    `SELECT category AS name, COUNT(*) AS value FROM devices WHERE ${d.sql} GROUP BY category ORDER BY value DESC`
  ).all(...d.params)

  const alarmTrend = db.prepare(
    `SELECT substr(created_at,1,10) AS date, COUNT(*) AS value
     FROM alarms WHERE ${a.sql} GROUP BY date ORDER BY date DESC LIMIT 14`
  ).all(...a.params).reverse()

  const alarmLevel = db.prepare(
    `SELECT level AS name, COUNT(*) AS value FROM alarms WHERE ${a.sql} GROUP BY level`
  ).all(...a.params)

  const orderStatus = db.prepare(
    `SELECT status, COUNT(*) c FROM work_orders WHERE ${o.sql} GROUP BY status`
  ).all(...o.params)
  const statusText = { PENDING: '待受理', PROCESSING: '处理中', CHECKING: '待验收', CLOSED: '已闭环' }
  const orderByStatus = Object.keys(statusText).map((s) => ({
    name: statusText[s], value: orderStatus.find((r) => r.status === s)?.c || 0
  }))

  /* ---------- 巡检 / 备件 / 保养 / 时效 ---------- */
  const ins = scopeFilter('inspection_tasks', req.user)
  const tsNow = nowText()
  const today = tsNow.slice(0, 10)
  const isoIn = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

  // 巡检待办 与 逾期未巡检
  const inspectPending = one(
    `SELECT COUNT(*) c FROM inspection_tasks WHERE ${ins.sql} AND status = 'PENDING'`, ins.params).c
  const inspectOverdue = one(
    `SELECT COUNT(*) c FROM inspection_tasks WHERE ${ins.sql} AND status = 'PENDING' AND plan_date < ?`,
    [...ins.params, today]).c

  // 工单处理超时（未闭环且已过处理时限）
  const orderOverdue = one(
    `SELECT COUNT(*) c FROM work_orders WHERE ${o.sql} AND status != 'CLOSED'
       AND resolve_deadline != '' AND resolve_deadline < ?`,
    [...o.params, tsNow]).c

  // 备件低库存
  const lowParts = one('SELECT COUNT(*) c FROM parts WHERE stock < safety_stock', []).c

  // 7 天内需保养的设备
  const maintainDue = one(
    `SELECT COUNT(*) c FROM devices WHERE ${d.sql} AND next_maintain_date != ''
       AND next_maintain_date <= ?`,
    [...d.params, isoIn(7)]).c

  // 近 14 天巡检完成量
  const inspectTrend = db.prepare(
    `SELECT plan_date AS date, COUNT(*) AS value FROM inspection_tasks
     WHERE ${ins.sql} AND status = 'DONE' GROUP BY plan_date ORDER BY plan_date DESC LIMIT 14`
  ).all(...ins.params).reverse()

  // 近 14 天备件出库量
  const partTrend = db.prepare(
    `SELECT substr(created_at,1,10) AS date,
            SUM(CASE WHEN type = 'OUT' THEN qty ELSE 0 END) AS value
     FROM part_records GROUP BY date ORDER BY date DESC LIMIT 14`
  ).all().reverse()

  res.json({
    code: 0,
    data: {
      scope: req.user.scope,
      region: req.user.region,
      cards: {
        deviceTotal, deviceAlarm, deviceMaintain,
        orderPending, orderProcessing, orderClosed,
        alarmOpen, alarmP1,
        inspectPending, inspectOverdue, orderOverdue, lowParts, maintainDue
      },
      byRegion, byCategory, byStatus: db.prepare(
        `SELECT status AS name, COUNT(*) AS value FROM devices WHERE ${d.sql} GROUP BY status`
      ).all(...d.params),
      alarmTrend, orderByStatus, alarmLevel, inspectTrend, partTrend
    }
  })
})

export default router
