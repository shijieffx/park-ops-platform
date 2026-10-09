import { createRouter, createWebHashHistory, RouteRecordRaw } from 'vue-router'
import { useUserStore } from '@/store/user'

const BasicLayout = () => import('@/layouts/BasicLayout.vue')

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'Login', component: () => import('@/views/Login.vue'), meta: { public: true } },
  {
    path: '/',
    component: BasicLayout,
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard', name: 'Dashboard',
        component: () => import('@/views/Dashboard.vue'),
        meta: { title: '首页看板', perm: 'dashboard:view' }
      },
      {
        path: 'device', name: 'Device',
        component: () => import('@/views/DeviceList.vue'),
        meta: { title: '设备台账', perm: 'device:view' }
      },
      {
        path: 'inspection', name: 'Inspection',
        component: () => import('@/views/InspectionList.vue'),
        meta: { title: '巡检管理', perm: 'inspection:view' }
      },
      {
        path: 'order', name: 'Order',
        component: () => import('@/views/OrderList.vue'),
        meta: { title: '工单中心', perm: 'order:view' }
      },
      {
        path: 'alarm', name: 'Alarm',
        component: () => import('@/views/AlarmList.vue'),
        meta: { title: '告警中心', perm: 'alarm:view' }
      },
      {
        path: 'part', name: 'Part',
        component: () => import('@/views/PartList.vue'),
        meta: { title: '备件库存', perm: 'part:view' }
      },
      {
        path: 'report', name: 'Report',
        component: () => import('@/views/Report.vue'),
        meta: { title: '报表中心', perm: 'report:view' }
      },
      {
        path: 'system/user', name: 'SystemUser',
        component: () => import('@/views/system/UserManage.vue'),
        meta: { title: '用户管理', perm: 'system:user' }
      },
      {
        path: 'system/role', name: 'SystemRole',
        component: () => import('@/views/system/RoleManage.vue'),
        meta: { title: '角色权限', perm: 'system:role' }
      },
      {
        path: 'system/dict', name: 'SystemDict',
        component: () => import('@/views/system/DictManage.vue'),
        meta: { title: '数据字典', perm: 'system:dict' }
      },
      {
        path: 'system/log', name: 'SystemLog',
        component: () => import('@/views/system/LogList.vue'),
        meta: { title: '操作日志', perm: 'system:log' }
      }
    ]
  },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' }
]

const router = createRouter({ history: createWebHashHistory(), routes })

router.beforeEach(async (to) => {
  const store = useUserStore()
  if (to.meta.public) return true

  if (!store.isLogin) return { name: 'Login' }
  if (!store.profile) await store.loadProfile()
  if (!store.profile) return { name: 'Login' }

  // 权限点校验：无权限时退回首页看板
  const perm = to.meta.perm as string | undefined
  if (perm && !store.perms.includes(perm)) {
    return { name: 'Dashboard' }
  }
  return true
})

export default router
