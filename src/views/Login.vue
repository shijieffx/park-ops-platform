<template>
  <div class="login-page">
    <div class="panel">
      <div class="brand">
        <span class="mark">P</span>
        <div>
          <h1>园区综合运维管理平台</h1>
          <p>Park Integrated Operations Platform</p>
        </div>
      </div>

      <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="64">
        <n-form-item label="账号" path="username">
          <n-input v-model:value="form.username" placeholder="请输入账号" @keyup.enter="submit" />
        </n-form-item>
        <n-form-item label="密码" path="password">
          <n-input v-model:value="form.password" type="password" show-password-on="click"
            placeholder="请输入密码" @keyup.enter="submit" />
        </n-form-item>
      </n-form>

      <n-button type="primary" block :loading="loading" @click="submit">登 录</n-button>

      <!-- 演示账号：方便甲方直接切换查看不同角色的权限差异 -->
      <div class="accounts">
        <p class="tip">演示账号（密码统一 <b>123456</b>），切换可对比权限差异：</p>
        <div class="acct-list">
          <div v-for="a in demoAccounts" :key="a.username" class="acct" @click="fill(a)">
            <n-tag size="small" :type="a.tag as any">{{ a.label }}</n-tag>
            <code>{{ a.username }}</code>
            <span class="desc">{{ a.desc }}</span>
          </div>
        </div>
      </div>

      <p class="foot">个人独立开发作品 · 全部数据为模拟数据</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { NForm, NFormItem, NInput, NButton, NTag, useMessage } from 'naive-ui'
import type { FormInst } from 'naive-ui'
import { useUserStore } from '@/store/user'

const router = useRouter()
const message = useMessage()
const store = useUserStore()
const formRef = ref<FormInst | null>(null)
const loading = ref(false)

const form = reactive({ username: 'admin', password: '123456' })
const rules = {
  username: { required: true, message: '请输入账号', trigger: 'blur' },
  password: { required: true, message: '请输入密码', trigger: 'blur' }
}

const demoAccounts = [
  { username: 'admin', label: '管理员', tag: 'error', desc: '全部数据 + 系统管理' },
  { username: 'manager', label: '运维主管', tag: 'warning', desc: '仅本区域，可派单验收' },
  { username: 'operator', label: '运维专员', tag: 'info', desc: '仅本人相关，无系统管理' }
]

function fill(a: typeof demoAccounts[number]) {
  form.username = a.username
  form.password = '123456'
}

async function submit() {
  try {
    await formRef.value?.validate()
  } catch { return }
  loading.value = true
  try {
    await store.login(form.username, form.password)
    message.success(`欢迎回来，${store.profile?.realName}`)
    router.push('/dashboard')
  } catch (e: any) {
    message.error(e.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #eaf2f8 0%, #f4f6f8 55%, #e8eef3 100%);
  padding: 20px;
}
.panel {
  width: 420px; background: #fff; border-radius: 12px; padding: 32px;
  box-shadow: 0 8px 32px rgba(16, 24, 40, .08);
}
.brand { display: flex; gap: 12px; align-items: center; margin-bottom: 24px; }
.brand .mark {
  width: 40px; height: 40px; border-radius: 10px; background: #1f5f8b; color: #fff;
  font-size: 20px; font-weight: 700; display: flex; align-items: center; justify-content: center;
}
.brand h1 { font-size: 18px; margin: 0; }
.brand p { font-size: 12px; color: #98a2ad; margin: 2px 0 0; letter-spacing: .5px; }
.accounts { margin-top: 22px; border-top: 1px dashed #e5e9ed; padding-top: 14px; }
.tip { font-size: 12px; color: #79838c; margin: 0 0 10px; }
.acct-list { display: flex; flex-direction: column; gap: 8px; }
.acct {
  display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: #f7f9fb; border-radius: 6px; cursor: pointer; font-size: 12px;
}
.acct:hover { background: #eaf2f8; }
.acct code { font-weight: 600; }
.acct .desc { color: #98a2ad; }
.foot { text-align: center; font-size: 11px; color: #b0b8c0; margin: 18px 0 0; }
</style>
