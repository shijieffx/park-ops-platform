<template>
  <div class="page-wrap">
    <div class="page-card">
      <!-- 筛选区 -->
      <n-form inline :model="query" class="no-print">
        <n-form-item label="关键词">
          <n-input v-model:value="query.keyword" placeholder="设备编号 / 名称" clearable style="width:170px" />
        </n-form-item>
        <n-form-item label="类型">
          <n-select v-model:value="query.category" :options="categoryOptions" clearable style="width:140px" />
        </n-form-item>
        <n-form-item label="区域">
          <n-select v-model:value="query.region" :options="regionOptions" clearable style="width:140px" />
        </n-form-item>
        <n-form-item label="状态">
          <n-select v-model:value="query.status" :options="statusOptions" clearable style="width:120px" />
        </n-form-item>
        <n-form-item>
          <n-button type="primary" @click="load">查询</n-button>
          <n-button style="margin-left:8px" @click="reset">重置</n-button>
        </n-form-item>
      </n-form>

      <!-- 操作栏 -->
      <div class="toolbar no-print">
        <n-button type="primary" size="small" @click="openForm()">新增设备</n-button>
        <n-button size="small" @click="pickFile">批量导入 Excel</n-button>
        <n-button size="small" @click="downloadTemplate">下载导入模板</n-button>
        <n-button size="small" @click="exportExcel">导出 Excel</n-button>
        <n-button size="small" @click="printTable">打印台账</n-button>
        <span class="total">共 {{ total }} 条</span>
        <input ref="fileRef" type="file" accept=".xlsx,.xls" style="display:none" @change="onFile" />
      </div>

      <!-- 导入结果：逐行回显失败原因 -->
      <n-alert v-if="importResult" :type="importResult.fail ? 'warning' : 'success'" style="margin:10px 0" closable
        @close="importResult = null">
        导入完成：成功 <b>{{ importResult.ok }}</b> 条，失败 <b>{{ importResult.fail }}</b> 条
        <div v-if="importResult.errors.length" class="err-list">
          <div v-for="(e, i) in importResult.errors.slice(0, 6)" :key="i">第 {{ e.row }} 行：{{ e.msg }}</div>
          <div v-if="importResult.errors.length > 6" class="err-more">
            …… 另有 {{ importResult.errors.length - 6 }} 条
          </div>
        </div>
      </n-alert>

      <!-- 台账表格 -->
      <div id="print-area">
        <div class="print-title">园区设备台账</div>
        <n-data-table
          :columns="columns" :data="rows" :loading="loading" :bordered="false"
          :pagination="pagination" :scroll-x="1080" remote @update:page="onPage"
        />
      </div>
    </div>

    <!-- 新增 / 编辑抽屉 -->
    <n-drawer v-model:show="showForm" :width="440" placement="right">
      <n-drawer-content :title="editing ? '编辑设备' : '新增设备'">
        <n-form :model="form" label-placement="top">
          <n-form-item label="设备编号"><n-input v-model:value="form.code" :disabled="!!editing" /></n-form-item>
          <n-form-item label="设备名称"><n-input v-model:value="form.name" /></n-form-item>
          <n-form-item label="设备类型">
            <n-select v-model:value="form.category" :options="categoryOptions" />
          </n-form-item>
          <n-form-item label="所属区域">
            <n-select v-model:value="form.region" :options="regionOptions" />
          </n-form-item>
          <n-form-item label="运行状态">
            <n-select v-model:value="form.status" :options="statusOptions" />
          </n-form-item>
          <n-form-item label="厂商"><n-input v-model:value="form.vendor" /></n-form-item>
          <n-form-item label="安装日期"><n-date-picker v-model:value="form.installDate" clearable style="width:100%" /></n-form-item>
          <n-form-item label="负责人"><n-input v-model:value="form.owner" /></n-form-item>
          <n-form-item label="备注"><n-input v-model:value="form.remark" type="textarea" /></n-form-item>
        </n-form>
        <template #footer>
          <n-space>
            <n-button @click="showForm = false">取消</n-button>
            <n-button type="primary" :loading="saving" @click="save">保存</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted, h } from 'vue'
import {
  NForm, NFormItem, NInput, NSelect, NButton, NDataTable, NDrawer, NDrawerContent,
  NSpace, NDatePicker, NAlert, NTag, useMessage, useDialog
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'
import { exportXlsx, readXlsx } from '@/utils/excel'
import { useUserStore } from '@/store/user'

const message = useMessage()
const dialog = useDialog()
const user = useUserStore()

const rows = ref<any[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const fileRef = ref<HTMLInputElement>()
const importResult = ref<{ ok: number; fail: number; errors: any[] } | null>(null)

const query = reactive({ keyword: '', category: '', region: '', status: '' })
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })

const CATEGORIES = ['环境监控', '安防摄像头', '配电柜', '门禁闸机', '消防主机', '能耗计量', '照明控制']
const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区']
const STATUSES = ['运行中', '告警', '检修中', '已停用']
const opts = (arr: string[]) => arr.map((v) => ({ label: v, value: v }))
const categoryOptions = opts(CATEGORIES)
const regionOptions = opts(REGIONS)
const statusOptions = opts(STATUSES)

const showForm = ref(false)
const saving = ref(false)
const editing = ref<any>(null)
const emptyForm = () => ({
  code: '', name: '', category: '环境监控', region: REGIONS[0],
  status: '运行中', vendor: '', installDate: null as any, owner: '', remark: ''
})
const form = reactive(emptyForm())

const STATUS_TYPE: Record<string, any> = {
  运行中: 'success', 告警: 'error', 检修中: 'warning', 已停用: 'default'
}

const columns: DataTableColumns<any> = [
  { title: '设备编号', key: 'code', width: 110, fixed: 'left' },
  { title: '设备名称', key: 'name', width: 150 },
  { title: '类型', key: 'category', width: 100 },
  { title: '区域', key: 'region', width: 110 },
  {
    title: '状态', key: 'status', width: 90,
    render: (r) => h(NTag, { size: 'small', type: STATUS_TYPE[r.status] || 'default', round: true }, () => r.status)
  },
  { title: '厂商', key: 'vendor', width: 110 },
  { title: '安装日期', key: 'install_date', width: 110 },
  { title: '负责人', key: 'owner', width: 90 },
  {
    title: '操作', key: 'actions', width: 130, fixed: 'right',
    className: 'no-print',
    render: (r) => h(NSpace, {}, () => [
      h(NButton, { size: 'tiny', text: true, onClick: () => openForm(r) }, () => '编辑'),
      h(NButton, {
        size: 'tiny', text: true, type: 'error',
        onClick: () => remove(r)
      }, () => '删除')
    ])
  }
]

async function load() {
  loading.value = true
  try {
    const res = await api.devices({ ...query, page: page.value, pageSize: 20 })
    rows.value = res.list
    total.value = res.total
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) {
    message.error(e.message || '加载失败')
  } finally { loading.value = false }
}

function onPage(p: number) { page.value = p; load() }
function reset() {
  Object.assign(query, { keyword: '', category: '', region: '', status: '' })
  page.value = 1; load()
}

function openForm(row?: any) {
  editing.value = row || null
  Object.assign(form, row
    ? { ...row, installDate: row.install_date ? new Date(row.install_date).getTime() : null }
    : emptyForm())
  showForm.value = true
}

async function save() {
  if (!form.code || !form.name) return message.warning('设备编号与名称必填')
  saving.value = true
  try {
    const payload = {
      ...form,
      installDate: form.installDate ? new Date(form.installDate).toISOString().slice(0, 10) : ''
    }
    if (editing.value) await api.updateDevice(editing.value.id, payload)
    else await api.saveDevice(payload)
    message.success('保存成功')
    showForm.value = false
    load()
  } catch (e: any) {
    message.error(e.message || '保存失败')
  } finally { saving.value = false }
}

function remove(row: any) {
  dialog.warning({
    title: '删除确认',
    content: `确定删除设备「${row.name}（${row.code}）」吗？`,
    positiveText: '删除', negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.delDevice(row.id)
        message.success('已删除')
        load()
      } catch (e: any) { message.error(e.message) }
    }
  })
}

/* ---------- Excel 导入 / 导出 ---------- */

const IMPORT_COLS = [
  { header: '设备编号', key: 'code' }, { header: '设备名称', key: 'name' },
  { header: '设备类型', key: 'category' }, { header: '所属区域', key: 'region' },
  { header: '运行状态', key: 'status' }, { header: '厂商', key: 'vendor' },
  { header: '安装日期', key: 'installDate' }, { header: '负责人', key: 'owner' }
]

function pickFile() { fileRef.value?.click() }

function downloadTemplate() {
  exportXlsx(
    [{ code: 'DEV-0001', name: '示例设备', category: CATEGORIES[0], region: REGIONS[0],
      status: '运行中', vendor: '海康威视', installDate: '2025-01-01', owner: '赵伟' }],
    IMPORT_COLS, '设备导入模板'
  )
}

async function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const list = await readXlsx(file) as Record<string, any>[]
    let ok = 0
    const errors: any[] = []
    for (let i = 0; i < list.length; i++) {
      const r = list[i]
      try {
        if (!r['设备编号'] || !r['设备名称']) throw new Error('设备编号与名称必填')
        await api.saveDevice({
          code: String(r['设备编号']), name: String(r['设备名称']),
          category: r['设备类型'] || CATEGORIES[0], region: r['所属区域'] || REGIONS[0],
          status: r['运行状态'] || '运行中', vendor: r['厂商'] || '',
          installDate: r['安装日期'] ? String(r['安装日期']).slice(0, 10) : '',
          owner: r['负责人'] || '', remark: ''
        })
        ok++
      } catch (err: any) {
        errors.push({ row: i + 2, msg: err.message || '导入失败' })
      }
    }
    importResult.value = { ok, fail: errors.length, errors }
    load()
  } catch (err: any) {
    message.error('文件解析失败：' + err.message)
  } finally {
    if (fileRef.value) fileRef.value.value = ''
  }
}

async function exportExcel() {
  try {
    const all = await api.allDevices()
    exportXlsx(
      all.map((d) => ({
        code: d.code, name: d.name, category: d.category, region: d.region,
        status: d.status, vendor: d.vendor, installDate: d.install_date, owner: d.owner
      })),
      IMPORT_COLS, `设备台账_${new Date().toISOString().slice(0, 10)}`
    )
    message.success(`已导出 ${all.length} 条`)
  } catch (e: any) { message.error(e.message) }
}

function printTable() { window.print() }

onMounted(() => {
  load()
  void user
})
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.total { margin-left: auto; font-size: 12px; color: #79838c; }
.err-list { margin-top: 6px; font-size: 12px; line-height: 1.7; }
.err-more { color: #98a2ad; }
.print-title { display: none; }

@media print {
  .print-title {
    display: block; font-size: 18px; font-weight: 700;
    text-align: center; margin-bottom: 12px;
  }
}
</style>
