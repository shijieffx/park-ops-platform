import { defineStore } from 'pinia'
import { api } from '@/api'
import type { LoginResult } from '@/api'

const TOKEN_KEY = 'park_ops_token'

export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    profile: null as LoginResult['user'] | null
  }),
  getters: {
    isLogin: (s) => !!s.token,
    perms: (s) => s.profile?.perms || [],
    hasPerm: (s) => (p: string) => (s.profile?.perms || []).includes(p)
  },
  actions: {
    async login(username: string, password: string) {
      const res = await api.login(username, password)
      this.token = res.token
      this.profile = res.user
      localStorage.setItem(TOKEN_KEY, res.token)
    },
    async loadProfile() {
      if (!this.token) return
      try {
        this.profile = await api.profile()
      } catch {
        this.logout(true)
      }
    },
    logout(force = false) {
      this.token = ''
      this.profile = null
      localStorage.removeItem(TOKEN_KEY)
      if (force && location.hash !== '#/login') location.hash = '#/login'
    }
  }
})
