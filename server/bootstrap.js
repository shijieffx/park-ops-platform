/**
 * 数据自举：服务启动前检查数据库，若为空则自动生成演示数据。
 *
 * 目的：让部署到服务器 / 容器后开箱即用 —— 云环境的数据卷被清空、
 * 或首次拉起时，不需要人工再执行一次 npm run seed。
 */
import { db } from './db.js'
import { runSeed } from './seed.js'

export function ensureSeedData() {
  let users
  try {
    users = db.prepare('SELECT COUNT(*) c FROM users').get().c
  } catch (e) {
    console.error('[bootstrap] 读取用户表失败：', e.message)
    return false
  }
  if (users > 0) {
    console.log(`[bootstrap] 已有数据（用户 ${users} 个），跳过初始化`)
    return false
  }
  console.log('[bootstrap] 数据库为空，正在生成演示数据…')
  const stat = runSeed(true)
  console.log(`[bootstrap] 演示数据就绪：设备 ${stat.devices} ｜ 工单 ${stat.orders} ｜ 告警 ${stat.alarms}`)
  return true
}
