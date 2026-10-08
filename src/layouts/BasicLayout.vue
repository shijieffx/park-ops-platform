<template>
  <n-layout has-sider style="height:100vh">
    <!-- 侧边栏：菜单由后端按角色返回，非 admin 看不到系统管理 -->
    <n-layout-sider
      bordered collapse-mode="width" :collapsed-width="64" :width="208"
      show-trigger="bar" :collapsed="collapsed" @update:collapsed="collapsed = $event"
      class="no-print"
    >
      <div class="logo">
        <span class="logo-mark">P</span>
        <span v-if="!collapsed" class="logo-text">园区运维平台</span>
      </div>
      <n-menu
        :value="activeKey" :collapsed="collapsed" :collapsed-width="64"
        :collapsed-icon-size="20" :options="menuOptions" @update:value="onMenu"
      />
    </n-layout-sider>

    <n-layout>
      <n-layout-header bordered class="header no-print">
        <div class="left">
          <n-breadcrumb>
            <n-breadcrumb-item>园区运维</n-breadcrumb-item>
            <n-breadcrumb-item>{{ route.meta.title }}</n-breadcrumb-item>
          </n-breadcrumb>
        </div>
        <div class="right">
          <n-tag size="small" :type="roleTag" round>{{ roleName }}</n-tag>
          <span class="region">数据范围：{{ scopeText }}</span>
          <n-dropdown :options="userOptions" @select="onUserAction">
            <n-button text>
              <span class="uname">{{ user.profile?.realName }}</span>
            </n-button>
          </n-dropdown>
        </div>
      </n-layout-header>

      <n-layout-content content-style="padding:0;" style="height:calc(100vh - 56px);overflow:auto;">
        <router-view v-slot="{ Component }">
          <component :is="Component" />
        </router-view>
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NLayout, NLayoutSider, NLayoutHeader, NLayoutContent, NMenu, NBreadcrumb,
  NBreadcrumbItem, NTag, NDropdown, NButton, useMessage, useDialog
} from 'naive-ui'
import type { MenuOption } from 'naive-ui'
import { useUserStore } from '@/store/user'
import { api } from '@/api'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const user = useUserStore()

const collapsed = ref(false)
const menus = ref<any[]>([])

const activeKey = computed(() => (route.path as string))

const ROLE: Record<string, string> = { admin: '系统管理员', manager: '运维主管', operator: '运维专员' }
const SCOPE: Record<string, string> = { ALL: '全部区域', REGION: '本区域', SELF: '仅本人相关' }

const roleName = computed(() => ROLE[user.profile?.roleCode || ''] || '访客')
const roleTag = computed(() =>
  ({ admin: 'error', manager: 'warning', operator: 'info' }[user.profile?.roleCode || ''] as any) || 'default'
)
const scopeText = computed(() => {
  if (user.profile?.roleCode === 'admin') return '全部区域'
  if (user.profile?.roleCode === 'manager') return `${user.profile?.region || '-'}（本区域）`
  return '仅本人相关数据'
})

const menuOptions = computed<MenuOption[]>(() =>
  menus.value.map((m) => ({
    label: m.title,
    key: m.path || String(m.id),
    icon: undefined,
    children: m.children?.length
      ? m.children.map((c: any) => ({ label: c.title, key: c.path }))
      : undefined
  }))
)

function onMenu(key: string) {
  if (key && key.startsWith('/')) router.push(key)
}

const userOptions = [
  { label: '刷新我的信息', key: 'profile' },
  { label: '退出登录', key: 'logout' }
]

function onUserAction(key: string) {
  if (key === 'logout') {
    dialog.warning({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      positiveText: '确定',
      negativeText: '取消',
      onPositiveClick: () => {
        user.logout()
        router.push('/login')
      }
    })
  } else {
    user.loadProfile().then(() => message.success('已刷新'))
  }
}

onMounted(async () => {
  try {
    menus.value = await api.menus()
  } catch (e: any) {
    message.error(e.message || '菜单加载失败')
  }
})
void h
</script>

<style scoped>
.logo {
  height: 56px; display: flex; align-items: center; gap: 8px;
  padding: 0 16px; border-bottom: 1px solid #eef1f4;
}
.logo-mark {
  width: 26px; height: 26px; border-radius: 6px; background: #1f5f8b;
  color: #fff; font-weight: 700; display: flex; align-items: center;
  justify-content: center; flex: none;
}
.logo-text { font-weight: 600; font-size: 15px; white-space: nowrap; }
.header {
  height: 56px; display: flex; align-items: center;
  justify-content: space-between; padding: 0 18px;
}
.header .right { display: flex; align-items: center; gap: 12px; }
.region { font-size: 12px; color: #79838c; }
.uname { font-size: 13px; }
</style>
