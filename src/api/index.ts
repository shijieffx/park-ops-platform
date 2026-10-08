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
  if (store.token) headers.Authorization = `Bearer ${store.token}`

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
  logs: () => http.get<any[]>('/meta/logs'),

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
  closeAlarm: (id: number) => http.put(`/alarms/${id}/close`, {}),

  users: (params: Record<string, any>) =>
    http.get<{ list: any[]; total: number }>('/users', params),
  saveUser: (body: any) => http.post('/users', body),
  resetPwd: (id: number) => http.put(`/users/${id}/reset`, {}),
  toggleUser: (id: number, status: boolean) => http.put(`/users/${id}/status`, { status }),
  delUser: (id: number) => http.del(`/users/${id}`),

  dashboard: () => http.get<any>('/stats/dashboard')
}
