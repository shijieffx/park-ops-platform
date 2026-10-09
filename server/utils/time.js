/**
 * 时间工具
 *
 * 全项目统一使用「东八区时间的字符串」作为时间表示，形如 '2026-10-09 15:30:00'。
 * 与数据库 TEXT 列直接对应，前端展示无需再做时区换算。
 *
 * 注意：不要用 `new Date().toISOString()` 直接作为业务时间——那是 UTC，
 * 与按 +08:00 解析的 SLA 计算混用会导致 8 小时偏差。
 */

const CN_OFFSET_MS = 8 * 3600 * 1000

/** 当前时间（东八区）'YYYY-MM-DD HH:mm:ss' */
export function nowText() {
  return new Date(Date.now() + CN_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

/** 今天（东八区）'YYYY-MM-DD' */
export function todayText() {
  return new Date(Date.now() + CN_OFFSET_MS).toISOString().slice(0, 10)
}

/** N 天前后的日期（东八区）'YYYY-MM-DD'，负数表示未来 */
export function dateOffsetText(days) {
  return new Date(Date.now() + CN_OFFSET_MS + days * 86400000).toISOString().slice(0, 10)
}

/** N 小时前的时间（东八区）'YYYY-MM-DD HH:mm:ss' */
export function hoursAgoText(hours) {
  return new Date(Date.now() + CN_OFFSET_MS - hours * 3600 * 1000)
    .toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 在时间字符串上加小时，返回同格式。
 * 输入输出都是「东八区表示」，中间用真实时间戳运算，避免二次偏移。
 */
export function plusHours(baseTime, hours) {
  const d = new Date(String(baseTime).replace(' ', 'T') + '+08:00')
  return new Date(d.getTime() + hours * 3600 * 1000 + CN_OFFSET_MS)
    .toISOString().slice(0, 19).replace('T', ' ')
}

/** 把时间字符串转成毫秒时间戳（按东八区解析） */
export function toTimestamp(timeText) {
  if (!timeText) return NaN
  return new Date(String(timeText).replace(' ', 'T') + '+08:00').getTime()
}
