<template>
  <div class="page-wrap">
    <n-grid :cols="2" :x-gap="12" :y-gap="12">
      <n-gi>
        <div class="page-card">
          <div class="card-title">告警等级分布</div>
          <EChart :option="levelOption" :height="240" />
        </div>
      </n-gi>
      <n-gi>
        <div class="page-card">
          <div class="card-title">近 30 天告警趋势</div>
          <EChart :option="trendOption" :height="240" />
        </div>
      </n-gi>
    </n-grid>

    <div class="page-card" style="margin-top:12px">
      <n-form inline :model="query">
        <n-form-item label="等级">
          <n-select v-model:value="query.level" :options="levelOptions" clearable style="width:110px" />
        </n-form-item>
        <n-form-item label="状态">
          <n-select v-model:value="query.status" :options="statusOptions" clearable style="width:110px" />
        </n-form-item>
        <n-form-item label="关键词">
          <n-input v-model:value="query.keyword" placeholder="设备编号 / 告警内容" clearable style="width:190px" />
        </n-form-item>
        <n-form-item><n-button type="primary" @click="load">查询</n-button></n-form-item>
      </n-form>

      <n-data-table :columns="columns" :data="rows" :loading="loading" :scroll-x="1000"
        :pagination="pagination" remote @update:page="onPage" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import { NGrid, NGi, NForm, NFormItem, NInput, NSelect, NButton, NDataTable, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import EChart from '@/components/EChart.vue'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

const message = useMessage()
const user = useUserStore()
const rows = ref<any[]>([])
const stats = ref<any[]>([])
const trend = ref<any[]>([])
const loading = ref(false)
const page = ref(1)
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })

const LEVELS = ['紧急', '重要', '次要', '提示']
const STATUSES = ['未处理', '已处理']
const opts = (a: string[]) => a.map((v) => ({ label: v, value: v }))
const levelOptions = opts(LEVELS)
const statusOptions = opts(STATUSES)
const LEVEL_TYPE: Record<string, any> = { 紧急: 'error', 重要: 'warning', 次要: 'info', 提示: 'default' }

const query = reactive({ level: '', status: '', keyword: '' })

const columns: DataTableColumns<any> = [
  { title: '设备编号', key: 'device_code', width: 110 },
  { title: '设备名称', key: 'device_name', width: 140 },
  {
    title: '等级', key: 'level', width: 80,
    render: (r) => h(NTag, { size: 'small', round: true, type: LEVEL_TYPE[r.level] }, () => r.level)
  },
  { title: '告警内容', key: 'content', ellipsis: { tooltip: true } },
  { title: '区域', key: 'region', width: 110 },
  { title: '时间', key: 'created_at', width: 110 },
  {
    title: '状态', key: 'status', width: 90,
    render: (r) => h(NTag, {
      size: 'small', round: true, type: r.status === '未处理' ? 'error' : 'success'
    }, () => r.status)
  },
  {
    title: '操作', key: 'a', width: 90, fixed: 'right',
    render: (r) => r.status === '未处理'
      ? h(NButton, { size: 'tiny', text: true, onClick: () => close(r) }, () => '标记已处理')
      : h('span', { class: 'muted' }, '—')
  }
]

const levelOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 50, right: 20, top: 20, bottom: 24 },
  xAxis: { type: 'category', data: stats.value.map((s) => s.name), axisLabel: { fontSize: 11 } },
  yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
  series: [{
    type: 'bar', barWidth: '48%',
    data: stats.value.map((s, i) => ({
      value: s.value,
      itemStyle: { color: ['#c9302c', '#e8912d', '#1f5f8b', '#98a2ad'][i] || '#1f5f8b', borderRadius: [4, 4, 0, 0] }
    }))
  }]
}))

const trendOption = computed(() => ({
  tooltip: { trigger: 'axis' },
  grid: { left: 40, right: 16, top: 20, bottom: 28 },
  xAxis: { type: 'category', data: trend.value.map((t) => t.date?.slice(5)), axisLabel: { fontSize: 10 } },
  yAxis: { type: 'value', axisLabel: { fontSize: 10 } },
  series: [{
    type: 'line', smooth: true, areaStyle: { opacity: .12 },
    itemStyle: { color: '#e8912d' }, data: trend.value.map((t) => t.value)
  }]
}))

async function load() {
  loading.value = true
  try {
    const res = await api.alarms({ ...query, page: page.value, pageSize: 20 })
    rows.value = res.list
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}

async function loadStats() {
  try {
    const [s, t] = await Promise.all([
      fetch('/api/alarms/stats/summary', {
        headers: { Authorization: `Bearer ${user.token}` }
      }).then((r) => r.json()),
      fetch('/api/alarms/stats/trend', {
        headers: { Authorization: `Bearer ${user.token}` }
      }).then((r) => r.json())
    ])
    stats.value = s.data || []
    trend.value = t.data || []
  } catch { /* 统计失败不影响主表 */ }
}

async function close(row: any) {
  try {
    await api.closeAlarm(row.id)
    message.success('已标记为已处理')
    load()
  } catch (e: any) { message.error(e.message) }
}

function onPage(p: number) { page.value = p; load() }
onMounted(() => { load(); loadStats() })
</script>

<style scoped>
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.muted { color: #c0c6cc; }
</style>
