<template>
  <div class="page-wrap">
    <!-- 角色数据范围提示：直观体现 RBAC 数据权限 -->
    <n-alert type="info" :show-icon="false" style="margin-bottom:14px" class="no-print">
      当前角色 <b>{{ roleName }}</b> —— {{ scopeText }}。
      切换 admin / manager / operator 账号登录，可看到下方所有图表的数据范围发生变化。
    </n-alert>

    <n-grid :cols="4" :x-gap="12" :y-gap="12">
      <n-gi v-for="c in cards" :key="c.label">
        <div class="stat-card">
          <div class="label">{{ c.label }}</div>
          <div class="value" :style="{ color: c.color }">{{ c.value }}</div>
          <div class="sub">{{ c.sub }}</div>
        </div>
      </n-gi>
    </n-grid>

    <!-- 待办与预警：把各模块「需要处理的量」集中呈现，点击直达 -->
    <n-grid :cols="4" :x-gap="12" :y-gap="12" style="margin-top:12px" class="no-print">
      <n-gi v-for="t in todos" :key="t.label">
        <div class="todo-card" :class="{ warn: t.warn }" @click="go(t.path)">
          <div class="todo-top">
            <span class="todo-label">{{ t.label }}</span>
            <span class="todo-value" :style="{ color: t.color }">{{ t.value }}</span>
          </div>
          <div class="todo-sub">{{ t.sub }}</div>
        </div>
      </n-gi>
    </n-grid>

    <n-grid :cols="2" :x-gap="12" :y-gap="12" style="margin-top:12px">
      <n-gi>
        <div class="page-card">
          <div class="card-title">近 14 天告警趋势</div>
          <EChart :option="trendOption" :height="260" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">工单状态分布</div>
          <EChart :option="orderOption" :height="260" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">设备区域分布</div>
          <EChart :option="regionOption" :height="260" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">设备类型构成</div>
          <EChart :option="categoryOption" :height="260" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">近 14 天巡检完成量</div>
          <EChart :option="inspectOption" :height="260" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">近 14 天备件出库量</div>
          <EChart :option="partOption" :height="260" />
        </div>
      </n-gi>
    </n-grid>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NGrid, NGi, NAlert, useMessage, NSkeleton } from 'naive-ui'
import EChart from '@/components/EChart.vue'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

const message = useMessage()
const user = useUserStore()
const data = ref<any>(null)

const ROLE: Record<string, string> = { admin: '系统管理员', manager: '运维主管', operator: '运维专员' }
const roleName = computed(() => ROLE[user.profile?.roleCode || ''] || '-')
const scopeText = computed(() => {
  if (user.profile?.roleCode === 'admin') return '可见全部区域数据'
  if (user.profile?.roleCode === 'manager') return `仅可见「${user.profile?.region}」的数据`
  return '仅可见与本人相关的数据'
})

const cards = computed(() => {
  const c = data.value?.cards || {}
  return [
    { label: '设备总数', value: c.deviceTotal ?? '-', sub: '在管设备', color: '#1f5f8b' },
    { label: '告警设备', value: c.deviceAlarm ?? '-', sub: '当前处于告警状态', color: '#d9534f' },
    { label: '待受理工单', value: c.orderPending ?? '-', sub: `处理中 ${c.orderProcessing ?? 0}`, color: '#e8912d' },
    { label: '未处理告警', value: c.alarmOpen ?? '-', sub: `其中紧急 ${c.alarmP1 ?? 0}`, color: '#c9302c' }
  ]
})

const pie = (name: string, rows: any[]) => ({
  tooltip: { trigger: 'item' },
  legend: { bottom: 0, itemWidth: 10, itemHeight: 10, textStyle: { fontSize: 11 } },
  series: [{
    name, type: 'pie', radius: ['38%', '62%'], center: ['50%', '45%'],
    label: { fontSize: 11, formatter: '{b}\n{c}' },
    data: (rows || []).map((r) => ({ name: r.name, value: r.value }))
  }]
})

const trendOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 40, right: 16, top: 24, bottom: 30 },
  xAxis: { type: 'category', data: (data.value?.alarmTrend || []).map((r: any) => r.date?.slice(5)), axisLabel: { fontSize: 10 } },
  yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
  series: [{
    type: 'line', smooth: true, areaStyle: { opacity: .12 },
    itemStyle: { color: '#1f5f8b' },
    data: (data.value?.alarmTrend || []).map((r: any) => r.value)
  }]
}))

const orderOption = computed(() => pie('工单状态', data.value?.orderByStatus))
const regionOption = computed(() => pie('区域分布', data.value?.byRegion))
const categoryOption = computed(() => pie('设备类型', data.value?.byCategory))

/** 待办与预警：点击可直达对应模块 */
const todos = computed(() => {
  const c = data.value?.cards || {}
  return [
    {
      label: '待执行巡检', value: c.inspectPending ?? '-',
      sub: `逾期未执行 ${c.inspectOverdue ?? 0} 个`, color: '#1f5f8b',
      path: '/inspection', warn: (c.inspectOverdue || 0) > 0
    },
    {
      label: '超时工单', value: c.orderOverdue ?? '-',
      sub: '已超出处理时限', color: '#c9302c',
      path: '/order', warn: (c.orderOverdue || 0) > 0
    },
    {
      label: '低库存备件', value: c.lowParts ?? '-',
      sub: '低于安全库存', color: '#e8912d',
      path: '/part', warn: (c.lowParts || 0) > 0
    },
    {
      label: '待保养设备', value: c.maintainDue ?? '-',
      sub: '7 天内到期', color: '#854f0b',
      path: '/device', warn: (c.maintainDue || 0) > 0
    }
  ]
})

/** 通用折线图 */
const lineOption = (rows: any[], color: string) => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 40, right: 16, top: 24, bottom: 30 },
  xAxis: {
    type: 'category',
    data: (rows || []).map((r: any) => String(r.date || '').slice(5)),
    axisLabel: { fontSize: 10 }
  },
  yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
  series: [{
    type: 'line', smooth: true, areaStyle: { opacity: 0.12 },
    itemStyle: { color },
    data: (rows || []).map((r: any) => r.value)
  }]
})

const inspectOption = computed(() => lineOption(data.value?.inspectTrend, '#3b6d11'))
const partOption = computed(() => lineOption(data.value?.partTrend, '#e8912d'))

const router = useRouter()
function go(path: string) { router.push(path) }

onMounted(async () => {
  try { data.value = await api.dashboard() }
  catch (e: any) { message.error(e.message || '看板数据加载失败') }
})
void NSkeleton
</script>

<style scoped>
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.stat-card .sub { font-size: 11px; color: #98a2ad; margin-top: 2px; }
.todo-card {
  background: #fff; border: 1px solid #eef1f4; border-radius: 8px;
  padding: 12px 14px; cursor: pointer; transition: all .15s;
}
.todo-card:hover { border-color: #cdd8e2; box-shadow: 0 2px 8px rgba(31, 95, 139, .08); }
.todo-card.warn { border-left: 3px solid #e8912d; }
.todo-top { display: flex; align-items: baseline; justify-content: space-between; }
.todo-label { font-size: 12px; color: #5f6b76; }
.todo-value { font-size: 22px; font-weight: 600; line-height: 1.2; }
.todo-sub { font-size: 11px; color: #98a2ad; margin-top: 4px; }
</style>
