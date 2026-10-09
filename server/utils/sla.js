/**
 * 工单 SLA（服务时限）计算
 *
 * 按优先级给出响应时限与处理时限，供三处共用：
 *   - 工单创建时写入 deadline
 *   - 巡检发现异常自动转工单时
 *   - 列表 / 看板的超时判定
 */
import { nowText, plusHours, toTimestamp } from './time.js'

export { nowText }

export const SLA_HOURS = {
  高: { respond: 2, resolve: 8 },
  中: { respond: 8, resolve: 24 },
  低: { respond: 24, resolve: 72 }
}

/** 按优先级计算响应时限与处理时限 */
export function calcDeadlines(priority, baseTime) {
  const sla = SLA_HOURS[priority] || SLA_HOURS['中']
  return {
    responseDeadline: plusHours(baseTime, sla.respond),
    resolveDeadline: plusHours(baseTime, sla.resolve)
  }
}

/**
 * 是否已超时。
 * 已闭环的工单不参与判定；没有处理时限的（历史数据）按未超时处理。
 */
export function isOverdue(status, resolveDeadline, referenceTime) {
  if (status === 'CLOSED' || !resolveDeadline) return 0
  return toTimestamp(resolveDeadline) < toTimestamp(referenceTime || nowText()) ? 1 : 0
}

/** 距处理时限还有多少小时（负数表示已超时），无时限返回 null */
export function hoursLeft(resolveDeadline, referenceTime) {
  if (!resolveDeadline) return null
  const diff = toTimestamp(resolveDeadline) - toTimestamp(referenceTime || nowText())
  return Math.round((diff / 3600000) * 10) / 10
}
