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

const roleName = computed(() => ROLE[user.profile?.roleCode || ''] || '访客')
const roleTag = computed(() =>
  ({ admin: 'error', manager: 'warning', operator: 'info' }[user.profile?.roleCode || ''] as any) || 'default'
)
const scopeText = computed(() => {
  if (user.profile?.roleCode === 'admin') return '全部区域'
  if (user.profile?.roleCode === 'manager') return `${user.profile?.region || '-'}（本区域）`
  return '仅本人相关数据'
})

/**
 * 后端下发的 icon key → 内联 SVG path。
 * 用内联图标而不是引入整个图标库，避免为首屏增加几百 KB。
 */
const ICONS: Record<string, string[]> = {
  analytics: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  cube: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7 7.5h.01', 'M7 16.5h.01'],
  clipboard: ['M9 5h10', 'M9 12h10', 'M9 19h10', 'M4 5h.01', 'M4 12h.01', 'M4 19h.01'],
  warning: ['M12 3l9.5 17H2.5z', 'M12 9.5v4.5', 'M12 17.5h.01'],
  stats: ['M3 21V11', 'M9 21V4', 'M15 21v-6', 'M21 21V8'],
  settings: [
    'M12 15a3 3 0 100-6 3 3 0 000 6z', 'M12 2v2.5', 'M12 19.5V22', 'M2 12h2.5',
    'M19.5 12H22', 'M5 5l1.8 1.8', 'M17.2 17.2L19 19', 'M19 5l-1.8 1.8', 'M6.8 17.2L5 19'
  ],
  person: ['M20 21v-1.8a4 4 0 00-4-4H8a4 4 0 00-4 4V21', 'M12 11a4 4 0 100-8 4 4 0 000 8z'],
  key: ['M12 22s7.5-4 7.5-9.5V5.5L12 2.5 4.5 5.5v7C4.5 18 12 22 12 22z'],
  'shield-check': ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'M8.8 11.8l2.2 2.2 4.2-4.2'],
  box: ['M3 7.5l9-4.2 9 4.2v9l-9 4.2-9-4.2z', 'M3 7.5l9 4.2 9-4.2', 'M12 11.7V21'],
  list: ['M5 3h14v18H5z', 'M8 7.5h8', 'M8 12h8', 'M8 16.5h5']
}

/** icon key → naive-ui 菜单的 render 函数 */
function iconFor(key?: string) {
  const paths = key ? ICONS[key] : undefined
  if (!paths) return undefined
  return () =>
    h('svg', {
      viewBox: '0 0 24 24',
      width: 17,
      height: 17,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.7,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }, paths.map((d) => h('path', { d })))
}

const menuOptions = computed<MenuOption[]>(() =>
  menus.value.map((m) => ({
    label: m.title,
    key: m.path || String(m.id),
    icon: iconFor(m.icon),
    children: m.children?.length
      ? m.children.map((c: any) => ({ label: c.title, key: c.path, icon: iconFor(c.icon) }))
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
