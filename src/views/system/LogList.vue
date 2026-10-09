<template>
  <div class="page-wrap">
    <div class="page-card">
      <n-form inline :model="query">
        <n-form-item label="关键词">
          <n-input v-model:value="query.keyword" placeholder="动作 / 详情" clearable style="width:220px" />
        </n-form-item>
        <n-form-item label="操作人">
          <n-input v-model:value="query.username" placeholder="登录账号" clearable style="width:160px" />
        </n-form-item>
        <n-form-item><n-button type="primary" @click="load">查询</n-button></n-form-item>
      </n-form>

      <n-data-table
        :columns="columns" :data="rows" :loading="loading"
        :scroll-x="900" :pagination="pagination"
      />
      <div class="foot-note">
        共 {{ pagination.itemCount }} 条记录（最多展示最近 300 条）。登录、增删改、工单流转、巡检执行、备件出入库等关键动作均会留痕。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, h } from 'vue'
import { NForm, NFormItem, NInput, NButton, NDataTable, NTag, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'

const message = useMessage()
const rows = ref<any[]>([])
const loading = ref(false)
const query = reactive({ keyword: '', username: '' })
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })

/** 按动作关键字着色，便于快速扫读 */
const TYPE_MAP: [RegExp, any][] = [
  [/删除|停用/, 'error'],
  [/新增|创建|入库/, 'success'],
  [/编辑|维护|导入/, 'info'],
  [/登录/, 'default'],
  [/巡检|流转|派单|领用|出库/, 'warning']
]

function tagType(action: string) {
  for (const [re, type] of TYPE_MAP) if (re.test(action)) return type
  return 'default'
}

const columns: DataTableColumns<any> = [
  { title: '时间', key: 'created_at', width: 170 },
  { title: '账号', key: 'username', width: 110 },
  {
    title: '动作', key: 'action', width: 120,
    render: (r: any) => h(NTag, { size: 'small', round: true, type: tagType(r.action || '') },
      () => r.action || '—')
  },
  { title: '详情', key: 'detail', ellipsis: { tooltip: true } }
]

async function load() {
  loading.value = true
  try {
    const res = await api.logs({ keyword: query.keyword, username: query.username })
    rows.value = res.list
    pagination.itemCount = res.total
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}

onMounted(load)
</script>

<style scoped>
.foot-note { margin-top: 10px; font-size: 12px; color: #98a2ad; }
</style>
