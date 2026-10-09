/**
 * 统一请求封装：
 * - 自动携带 token
 * - 401 自动登出并跳登录页
 * - 统一解包 { code, data, message }，异常统一提示
 */
import { useUserStore } from '@/store/user'

const BASE = '/api'

export interface Res<T> { code: number; data: T; message?: string }

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const store = useUserStore()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {})
  }
  if (store.token) {
    // 同时带两个头：Authorization 是标准写法，X-Auth-Token 用于绕开
    // 部分部署环境对 Authorization 头的替换（服务端优先读后者）
    headers.Authorization = `Bearer ${store.token}`
    headers['X-Auth-Token'] = store.token
  }

  const res = await fetch(BASE + url, { ...options, headers })
  const json = (await res.json().catch(() => null)) as Res<T> | null

  if (!res.ok || !json || json.code !== 0) {
    const msg = json?.message || `请求失败（${res.status}）`
    if (res.status === 401) store.logout(true)
    throw new Error(msg)
  }
  return json.data
}

export const http = {
  get: <T>(url: string, params?: Record<string, any>) => {
    const qs = params
      ? '?' + Object.entries(params)
        .filter(([, v]) => v !== '' && v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&')
      : ''
    return request<T>(url + qs)
  },
  post: <T>(url: string, body?: any) =>
    request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  put: <T>(url: string, body?: any) =>
    request<T>(url, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' })
}

/* ---------------- 业务接口 ---------------- */

export interface LoginResult {
  token: string
  user: { id: number; username: string; realName: string; roleCode: string; region: string; perms: string[] }
}
export const api = {
  login: (username: string, password: string) =>
    http.post<LoginResult>('/auth/login', { username, password }),
  profile: () => http.get<LoginResult['user']>('/auth/profile'),

  menus: () => http.get<any[]>('/meta/menus'),
  roles: () => http.get<any[]>('/meta/roles'),
  saveRole: (body: any) => http.post('/meta/roles', body),
  delRole: (id: number) => http.del(`/meta/roles/${id}`),
  dicts: (type?: string) => http.get<any[]>('/meta/dicts', type ? { type } : undefined),
  logs: (params?: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/meta/logs', params),
  staff: () => http.get<any[]>('/meta/staff'),

  devices: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/devices', params),
  allDevices: () => http.get<any[]>('/devices/all'),
  saveDevice: (body: any) => http.post('/devices', body),
  updateDevice: (id: number, body: any) => http.put(`/devices/${id}`, body),
  delDevice: (id: number) => http.del(`/devices/${id}`),
  deviceStats: () => http.get<any>('/devices/stats/summary'),

  orders: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/orders', params),
  orderDetail: (id: number) => http.get<any>(`/orders/${id}`),
  createOrder: (body: any) => http.post('/orders', body),
  flowOrder: (id: number, body: any) => http.post(`/orders/${id}/flow`, body),

  alarms: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/alarms', params),
  alarmStats: () => http.get<any[]>('/alarms/stats/summary'),
  alarmTrend: () => http.get<any[]>('/alarms/stats/trend'),
  closeAlarm: (id: number) => http.put(`/alarms/${id}/close`, {}),

  users: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/users', params),
  saveUser: (body: any) => http.post('/users', body),
  resetPwd: (id: number) => http.put(`/users/${id}/reset`, {}),
  toggleUser: (id: number, status: boolean) => http.put(`/users/${id}/status`, { status }),
  delUser: (id: number) => http.del(`/users/${id}`),

  dashboard: () => http.get<any>('/stats/dashboard'),

  /* ---------------- 巡检管理 ---------------- */
  inspectionPlans: () => http.get<any[]>('/inspection/plans'),
  savePlan: (body: any) => http.post('/inspection/plans', body),
  togglePlan: (id: number, status: boolean) =>
    http.put(`/inspection/plans/${id}/status`, { status }),
  delPlan: (id: number) => http.del(`/inspection/plans/${id}`),
  inspectionTasks: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/inspection/tasks', params),
  inspectionTaskDetail: (id: number) => http.get<any>(`/inspection/tasks/${id}`),
  generateTasks: (date?: string) =>
    http.post<{ created: number; skipped: number }>('/inspection/tasks/generate', { date }),
  submitInspection: (id: number, body: any) =>
    http.post<{ total: number; abnormal: number; orders: string[] }>(
      `/inspection/tasks/${id}/submit`, body),
  inspectionStats: () => http.get<any>('/inspection/stats/summary'),

  /* ---------------- 备件库存 ---------------- */
  parts: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/parts', params),
  allParts: () => http.get<any[]>('/parts/all'),
  savePart: (body: any) => http.post('/parts', body),
  delPart: (id: number) => http.del(`/parts/${id}`),
  partStock: (id: number, body: { type: 'IN' | 'OUT'; qty: number; note?: string }) =>
    http.post<{ stock: number; lowStock: boolean }>(`/parts/${id}/stock`, body),
  applyPart: (body: { partId: number; qty: number; orderCode?: string; note?: string }) =>
    http.post<{ stock: number; lowStock: boolean; partName: string }>('/parts/apply', body),
  partRecords: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/parts/records', params),
  partStats: () => http.get<any>('/parts/stats/summary'),

  /* ---------------- 工单增强 ---------------- */
  assignOrder: (id: number, body: { handler: string; note?: string }) =>
    http.post(`/orders/${id}/assign`, body),
  orderSla: () => http.get<any>('/orders/stats/sla'),

  /* ---------------- 设备保养 ---------------- */
  maintainDue: (days = 7) => http.get<any>('/devices/stats/maintain', { days })
}
