/**
 * WorkBuddy 云服务 · 公开发配置
 *
 * 取值来自开通云服务时服务端返回的 publicConfig，是**唯一允许出现在浏览器里**的部分：
 *  - `publishableKey` 只用来标识「是哪个应用」，本身不携带任何权限；
 *    服务端会强制校验请求来源（Origin）必须与本应用的发布域名完全一致，
 *    所以在别的站点上拿它去调用是无效的。
 *  - 真正的环境 ID、模型服务商密钥始终保留在服务端，不会下发到前端。
 *
 * 因此这里可以放进源码并随前端打包；仓库公开也没有安全风险。
 * ⚠️ 若后续更换了应用的发布域名，需要重新开通/发布以取得新的 endpoint。
 */
export const CLOUD_CONFIG = {
  /** 本应用的发布域名 —— 云服务数据面基址 */
  endpoint: 'https://park-ops-platform.app.workbuddy.host',
  /** 应用公开标识（非密钥） */
  publishableKey: 'wbpk_2f1OZgmMQ6x9lQGWHX1fof_Cti6Nj7nL0WleRvUMzhco3UGkrRyCsy0',
  /** 第三方登录（如微信扫码）所需的中转基址；本应用未使用第三方登录，传入不影响 */
  oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth'
}
