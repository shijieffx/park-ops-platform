/**
 * 请求参数安全解析
 * 目标：任何非法入参都不能让接口抛 500，一律回退到安全默认值。
 */

/** 转整数，失败返回 fallback（NaN / Infinity / 空串 / 小数都会被规范化） */
export function toInt(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.trunc(n)
}

/**
 * 解析分页参数
 * @returns {{ page: number, pageSize: number, offset: number }}
 */
export function parsePaging(query = {}, { defaultSize = 20, maxSize = 100 } = {}) {
  let page = toInt(query.page, 1)
  let pageSize = toInt(query.pageSize, defaultSize)

  if (page < 1) page = 1
  if (pageSize < 1) pageSize = defaultSize
  if (pageSize > maxSize) pageSize = maxSize

  return { page, pageSize, offset: (page - 1) * pageSize }
}

/** 裁剪字符串查询参数，防止超长入参拖垮 LIKE 查询 */
export function toKeyword(value, maxLen = 50) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLen)
}
