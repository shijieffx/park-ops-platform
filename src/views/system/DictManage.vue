<template>
  <div class="page-wrap">
    <div class="page-card">
      <n-select v-model:value="type" :options="typeOptions" style="width:200px;margin-bottom:12px" />
      <n-data-table :columns="columns" :data="rows" :loading="loading" />
      <div class="foot">数据字典用于下拉选项的统一维护（设备类型、状态、告警等级、工单优先级等）</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { NDataTable, NSelect } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'

const rows = ref<any[]>([])
const loading = ref(false)
const type = ref('device_status')

const typeOptions = [
  { label: '设备状态', value: 'device_status' },
  { label: '设备类型', value: 'device_category' },
  { label: '告警等级', value: 'alarm_level' },
  { label: '工单优先级', value: 'order_priority' }
]

const columns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 70 },
  { title: '字典类型', key: 'type', width: 140 },
  { title: '显示名', key: 'label', width: 140 },
  { title: '值', key: 'value', width: 140 },
  { title: '排序', key: 'sort', width: 90 }
]

async function load() {
  loading.value = true
  try { rows.value = await api.dicts(type.value) }
  finally { loading.value = false }
}

watch(type, load)
onMounted(load)
void computed
</script>

<style scoped>
.foot { margin-top: 10px; font-size: 12px; color: #98a2ad; }
</style>
