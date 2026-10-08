<template>
  <div class="page-wrap">
    <div class="page-card">
      <n-form inline :model="form" class="no-print">
        <n-form-item label="统计维度">
          <n-select v-model:value="form.dim" :options="dimOptions" style="width:130px" />
        </n-form-item>
        <n-form-item label="指标">
          <n-select v-model:value="form.metric" :options="metricOptions" style="width:150px" />
        </n-form-item>
        <n-form-item label="图表类型">
          <n-radio-group v-model:value="form.chart">
            <n-radio-button value="bar">柱状图</n-radio-button>
            <n-radio-button value="pie">饼图</n-radio-button>
            <n-radio-button value="line">折线图</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item>
          <n-button type="primary" @click="build">生成报表</n-button>
          <n-button style="margin-left:8px" @click="exportExcel">导出 Excel</n-button>
          <n-button style="margin-left:8px" @click="doPrint">打印</n-button>
        </n-form-item>
      </n-form>

      <div class="chart-box">
        <EChart :option="option" :height="360" />
      </div>

      <n-data-table
        :columns="tableColumns" :data="tableRows" :bordered="false"
        :max-height="260" style="margin-top:16px"
      />
      <div class="foot-note">
        报表数据受当前角色数据范围约束（{{ scopeText }}）
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { NForm, NFormItem, NSelect, NButton, NRadioGroup, NRadioButton, NDataTable, useMessage } from 'naive-ui'
import EChart from '@/components/EChart.vue'
import { api } from '@/api'
import { exportXlsx } from '@/utils/excel'
import { useUserStore } from '@/store/user'

const message = useMessage()
const user = useUserStore()
const raw = ref<any>(null)

const form = reactive({ dim: 'region', metric: 'device', chart: 'bar' })
const dimOptions = [
  { label: '按区域', value: 'region' },
  { label: '按设备类型', value: 'category' },
  { label: '按设备状态', value: 'status' },
  { label: '按工单状态', value: 'orderStatus' },
  { label: '按告警等级', value: 'alarmLevel' }
]
const metricOptions = [
  { label: '设备数量', value: 'device' },
  { label: '工单数量', value: 'order' },
  { label: '告警数量', value: 'alarm' }
]

const scopeText = computed(() => {
  if (user.profile?.roleCode === 'admin') return '全部区域'
  if (user.profile?.roleCode === 'manager') return `${user.profile?.region}（本区域）`
  return '仅本人相关'
})

const DATA_MAP = computed(() => {
  const d = raw.value
  return {
    region: d?.byRegion || [],
    category: d?.byCategory || [],
    status: d?.byStatus || [],
    orderStatus: d?.orderByStatus || [],
    alarmLevel: d?.alarmLevel || []
  } as Record<string, any[]>
})

const tableRows = computed(() => DATA_MAP.value[form.dim] || [])
const tableColumns = computed(() => [
  { title: form.dim === 'region' ? '区域' : form.dim === 'category' ? '设备类型'
    : form.dim === 'status' ? '设备状态' : form.dim === 'orderStatus' ? '工单状态' : '告警等级',
    key: 'name' },
  { title: '数量', key: 'value' },
  {
    title: '占比', key: 'pct',
    render: (r: any) => {
      const total = tableRows.value.reduce((s, x) => s + x.value, 0) || 1
      return `${((r.value / total) * 100).toFixed(1)}%`
    }
  }
])

const option = computed(() => {
  const rows = tableRows.value
  const names = rows.map((r) => r.name)
  const values = rows.map((r) => r.value)
  const base = {
    tooltip: { trigger: form.chart === 'pie' ? 'item' : 'axis' },
    grid: { left: 50, right: 20, top: 30, bottom: 40 },
    legend: form.chart === 'pie' ? { bottom: 0, itemWidth: 10, textStyle: { fontSize: 11 } } : undefined,
    xAxis: form.chart === 'pie' ? undefined : {
      type: 'category', data: names, axisLabel: { fontSize: 11, interval: 0, rotate: names.length > 6 ? 30 : 0 }
    },
    yAxis: form.chart === 'pie' ? undefined : { type: 'value', axisLabel: { fontSize: 10 } },
    series: form.chart === 'pie'
      ? [{ type: 'pie', radius: ['38%', '62%'], center: ['50%', '45%'],
        data: rows.map((r) => ({ name: r.name, value: r.value })), label: { fontSize: 11 } }]
      : [{
        type: form.chart, smooth: form.chart === 'line', barWidth: '46%',
        itemStyle: { color: '#1f5f8b', borderRadius: form.chart === 'bar' ? [4, 4, 0, 0] : 0 },
        areaStyle: form.chart === 'line' ? { opacity: .12 } : undefined,
        data: values
      }]
  }
  return base
})

async function build() {
  try {
    raw.value = await api.dashboard()
    message.success('报表已生成')
  } catch (e: any) { message.error(e.message) }
}

async function exportExcel() {
  if (!tableRows.value.length) return message.warning('请先生成报表')
  exportXlsx(tableRows.value,
    [{ header: tableColumns.value[0].title, key: 'name' }, { header: '数量', key: 'value' }],
    `运维报表_${form.dim}`)
}

function doPrint() { window.print() }

onMounted(build)
</script>

<style scoped>
.chart-box { border: 1px solid #eef1f4; border-radius: 8px; padding: 8px; }
.foot-note { margin-top: 10px; font-size: 12px; color: #98a2ad; }
</style>
