import { createWorkBuddyCloud, type WorkBuddyCloudClient } from '@tencent-ai/workbuddy-cloud-sdk'
import { CLOUD_CONFIG } from '@/config/cloud'

/**
 * 云服务客户端（单例）。
 *
 * 三个模块共用同一个实例，只初始化一次。
 * endpoint 与 publishableKey 两个都必须传：
 * 不传 endpoint 会退化为「同源推断」，一旦应用换域名就会静默失联。
 */
let client: WorkBuddyCloudClient | null = null

export function getCloud(): WorkBuddyCloudClient {
  if (!client) {
    client = createWorkBuddyCloud({
      endpoint: CLOUD_CONFIG.endpoint,
      publishableKey: CLOUD_CONFIG.publishableKey,
      oauthRelayBaseUrl: CLOUD_CONFIG.oauthRelayBaseUrl
    })
  }
  return client
}

/**
 * 当前页面是否运行在应用的发布域名下。
 *
 * 云服务会校验请求来源：只有在发布域名（含其子路径）打开时，模型调用才会被接受。
 * 本地 `npm run dev` 时来源是 localhost，因此调用必然被拒 ——
 * 这不是代码问题，而是云服务的安全机制，界面上应当给出准确提示。
 */
export function isOnReleaseOrigin(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.location.origin === new URL(CLOUD_CONFIG.endpoint).origin
  } catch {
    return false
  }
}
