<template>
  <div class="page-wrap">
    <!-- 低库存预警 -->
    <n-alert v-if="stats.lowCount" type="warning" style="margin-bottom:12px" class="no-print">
      有 <b>{{ stats.lowCount }}</b> 种备件低于安全库存，建议及时补货：
      <span class="low-names">{{ lowNames }}</span>
    </n-alert>

    <n-grid :cols="4" :x-gap="12" :y-gap="12" class="no-print">
      <n-gi v-for="c in cards" :key="c.label">
        <div class="stat-card">
          <div class="label">{{ c.label }}</div>
          <div class="value" :style="{ color: c.color }">{{ c.value }}</div>
          <div class="sub">{{ c.sub }}</div>
        </div>
      </n-gi>
    </n-grid>

    <div class="page-card" style="margin-top:12px">
      <n-tabs v-model:value="tab" type="line" animated>
        <!-- ───────── 备件台账 ───────── -->
        <n-tab-pane name="stock" tab="备件台账">
          <n-form inline :model="query" class="no-print">
            <n-form-item label="关键词">
              <n-input v-model:value="query.keyword" placeholder="编码 / 名称 / 规格" clearable style="width:200px" />
            </n-form-item>
            <n-form-item label="库存状态">
              <n-select v-model:value="query.onlyLow" :options="lowOptions" clearable style="width:140px" />
            </n-form-item>
            <n-form-item>
              <n-button type="primary" @click="loadParts">查询</n-button>
              <n-button v-if="canEdit" style="margin-left:8px" @click="openPart()">新增备件</n-button>
            </n-form-item>
          </n-form>

          <n-data-table
            :columns="partColumns" :data="parts" :loading="loading"
            :scroll-x="1180" :pagination="pagination" remote @update:page="onPage"
          />
          <div class="foot-note">
            库存低于安全库存自动预警；工单领用备件时校验库存并即时扣减，全流程留痕可追溯
          </div>
        </n-tab-pane>

        <!-- ───────── 出入库流水 ───────── -->
        <n-tab-pane name="record" tab="出入库流水">
          <n-form inline :model="recQuery" class="no-print">
            <n-form-item label="类型">
              <n-select v-model:value="recQuery.type" :options="typeOptions" clearable style="width:120px" />
            </n-form-item>
            <n-form-item label="关联工单">
              <n-input v-model:value="recQuery.orderCode" placeholder="工单号" clearable style="width:160px" />
            </n-form-item>
            <n-form-item><n-button type="primary" @click="loadRecords">查询</n-button></n-form-item>
          </n-form>

          <n-data-table
            :columns="recordColumns" :data="records" :loading="recLoading"
            :scroll-x="980" :pagination="recPagination" remote @update:page="onRecPage"
          />
        </n-tab-pane>
      </n-tabs>
    </div>

    <!-- 出入库 -->
    <n-modal v-model:show="showStock" preset="card" :title="`${stockForm.type === 'IN' ? '入库' : '出库'} · ${stockForm.partName}`" style="width:460px">
      <n-form label-placement="top">
        <n-form-item label="操作类型">
          <n-radio-group v-model:value="stockForm.type">
            <n-radio-button value="IN">入库</n-radio-button>
            <n-radio-button value="OUT">出库</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item :label="`数量（当前库存 ${stockForm.stock}${stockForm.unit}）`">
          <n-input-number v-model:value="stockForm.qty" :min="1" style="width:100%" />
        </n-form-item>
        <n-form-item label="备注">
          <n-input v-model:value="stockForm.note" type="textarea" :rows="2" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showStock = false">取消</n-button>
          <n-button type="primary" :loading="stockSaving" @click="submitStock">确认</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- 备件编辑 -->
    <n-modal v-model:show="showPart" preset="card" :title="partForm.id ? '编辑备件' : '新增备件'" style="width:540px">
      <n-form :model="partForm" label-placement="top">
        <n-grid :cols="2" :x-gap="12">
          <n-gi><n-form-item label="备件编码"><n-input v-model:value="partForm.code" placeholder="PT-0001" /></n-form-item></n-gi>
          <n-gi><n-form-item label="备件名称"><n-input v-model:value="partForm.name" /></n-form-item></n-gi>
          <n-gi><n-form-item label="规格型号"><n-input v-model:value="partForm.spec" /></n-form-item></n-gi>
          <n-gi><n-form-item label="单位"><n-input v-model:value="partForm.unit" /></n-form-item></n-gi>
          <n-gi><n-form-item label="当前库存"><n-input-number v-model:value="partForm.stock" :min="0" style="width:100%" /></n-form-item></n-gi>
          <n-gi><n-form-item label="安全库存"><n-input-number v-model:value="partForm.safetyStock" :min="0" style="width:100%" /></n-form-item></n-gi>
          <n-gi><n-form-item label="单价（元）"><n-input-number v-model:value="partForm.price" :min="0" style="width:100%" /></n-form-item></n-gi>
          <n-gi><n-form-item label="供应商"><n-input v-model:value="partForm.vendor" /></n-form-item></n-gi>
        </n-grid>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showPart = false">取消</n-button>
          <n-button type="primary" :loading="partSaving" @click="submitPart">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import {
  NGrid, NGi, NTabs, NTabPane, NForm, NFormItem, NInput, NInputNumber, NSelect,
  NButton, NDataTable, NTag, NSpace, NAlert, NModal, NRadioGroup, NRadioButton,
  useMessage, useDialog
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

const message = useMessage()
const dialog = useDialog()
const user = useUserStore()

const canEdit = computed(() => user.hasPerm('part:edit'))

const tab = ref('stock')
const stats = ref<any>({})
const parts = ref<any[]>([])
const records = ref<any[]>([])
const loading = ref(false)
const recLoading = ref(false)
const page = ref(1)
const recPage = ref(1)
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })
const recPagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })

const query = reactive({ keyword: '', onlyLow: '' })
const recQuery = reactive({ type: '', orderCode: '' })
const lowOptions = [{ label: '仅低于安全库存', value: '1' }]
const typeOptions = [
  { label: '入库', value: 'IN' },
  { label: '出库', value: 'OUT' }
]

const lowNames = computed(() =>
  (stats.value.lowList || []).slice(0, 6)
    .map((p: any) => `${p.name}（${p.stock}/${p.safety_stock}${p.unit}）`)
    .join('、'))

const cards = computed(() => {
  const s = stats.value || {}
  return [
    { label: '备件种类', value: s.totalParts ?? '-', sub: '在册备件', color: '#1f5f8b' },
    { label: '低库存预警', value: s.lowCount ?? '-', sub: '低于安全库存', color: '#c9302c' },
    { label: '库存总值', value: s.stockValue != null ? `¥${s.stockValue.toLocaleString()}` : '-', sub: '按单价估算', color: '#3b6d11' },
    { label: '累计出库', value: s.outQty ?? '-', sub: `累计入库 ${s.inQty ?? 0}`, color: '#854f0b' }
  ]
})

const partColumns: DataTableColumns<any> = [
  { title: '备件编码', key: 'code', width: 100 },
  { title: '名称', key: 'name', width: 140 },
  { title: '规格型号', key: 'spec', width: 130, render: (r) => r.spec || '—' },
  {
    title: '库存', key: 'stock', width: 110,
    render: (r) => h('span', { class: r.low ? 'low' : 'ok' }, `${r.stock} ${r.unit}`)
  },
  { title: '安全库存', key: 'safety_stock', width: 90, render: (r) => `${r.safety_stock} ${r.unit}` },
  {
    title: '库存状态', key: 's', width: 100,
    render: (r) => h(NTag, {
      size: 'small', round: true, type: r.low ? 'error' : 'success'
    }, () => (r.low ? '库存偏低' : '充足'))
  },
  { title: '单价', key: 'price', width: 90, render: (r) => `¥${r.price}` },
  { title: '供应商', key: 'vendor', width: 110, render: (r) => r.vendor || '—' },
  {
    title: '操作', key: 'a', width: 190, fixed: 'right',
    render: (r) => (canEdit.value
      ? h(NSpace, { size: 8 }, () => [
        h(NButton, { size: 'tiny', text: true, type: 'primary', onClick: () => openStock(r, 'IN') }, () => '入库'),
        h(NButton, { size: 'tiny', text: true, onClick: () => openStock(r, 'OUT') }, () => '出库'),
        h(NButton, { size: 'tiny', text: true, onClick: () => openPart(r) }, () => '编辑'),
        h(NButton, { size: 'tiny', text: true, type: 'error', onClick: () => removePart(r) }, () => '删除')
      ])
      : h(NButton, {
        size: 'tiny', text: true, onClick: () => {
          recQuery.orderCode = ''; tab.value = 'record'; loadRecords()
        }
      }, () => '查看流水'))
  }
]

const recordColumns: DataTableColumns<any> = [
  { title: '时间', key: 'created_at', width: 160 },
  { title: '备件编码', key: 'part_code', width: 100 },
  { title: '备件名称', key: 'part_name', width: 140 },
  {
    title: '类型', key: 'type', width: 80,
    render: (r) => h(NTag, {
      size: 'small', round: true, type: r.type === 'OUT' ? 'warning' : 'success'
    }, () => (r.type === 'OUT' ? '出库' : '入库'))
  },
  { title: '数量', key: 'qty', width: 80 },
  {
    title: '库存变化', key: 'chg', width: 130,
    render: (r) => `${r.before_stock} → ${r.after_stock}`
  },
  { title: '关联工单', key: 'order_code', width: 110, render: (r) => r.order_code || '—' },
  { title: '操作人', key: 'operator', width: 90 },
  { title: '备注', key: 'note', ellipsis: { tooltip: true } }
]

/* ───────── 加载 ───────── */

async function loadStats() {
  try { stats.value = await api.partStats() } catch { /* 概览失败不阻塞 */ }
}

async function loadParts() {
  loading.value = true
  try {
    const res = await api.parts({
      keyword: query.keyword, onlyLow: query.onlyLow, page: page.value, pageSize: 20
    })
    parts.value = res.list
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}

async function loadRecords() {
  recLoading.value = true
  try {
    const res = await api.partRecords({
      type: recQuery.type, orderCode: recQuery.orderCode, page: recPage.value, pageSize: 20
    })
    records.value = res.list
    recPagination.itemCount = res.total
    recPagination.page = recPage.value
  } catch (e: any) { message.error(e.message) }
  finally { recLoading.value = false }
}

function onPage(p: number) { page.value = p; loadParts() }
function onRecPage(p: number) { recPage.value = p; loadRecords() }

/* ───────── 出入库 ───────── */

const showStock = ref(false)
const stockSaving = ref(false)
const stockForm = reactive({ id: 0, partName: '', unit: '个', stock: 0, type: 'IN' as 'IN' | 'OUT', qty: 1, note: '' })

function openStock(row: any, type: 'IN' | 'OUT') {
  Object.assign(stockForm, {
    id: row.id, partName: row.name, unit: row.unit, stock: row.stock,
    type, qty: 1, note: type === 'IN' ? '采购入库' : '手动出库'
  })
  showStock.value = true
}

async function submitStock() {
  stockSaving.value = true
  try {
    await api.partStock(stockForm.id, {
      type: stockForm.type, qty: stockForm.qty, note: stockForm.note
    })
    message.success('操作成功')
    showStock.value = false
    loadParts(); loadStats(); loadRecords()
  } catch (e: any) { message.error(e.message) }
  finally { stockSaving.value = false }
}

/* ───────── 备件维护 ───────── */

const showPart = ref(false)
const partSaving = ref(false)
const partForm = reactive({
  id: 0, code: '', name: '', spec: '', unit: '个',
  stock: 0, safetyStock: 0, price: 0, vendor: ''
})

function openPart(row?: any) {
  Object.assign(partForm, {
    id: row?.id || 0,
    code: row?.code || '',
    name: row?.name || '',
    spec: row?.spec || '',
    unit: row?.unit || '个',
    stock: row?.stock ?? 0,
    safetyStock: row?.safety_stock ?? 0,
    price: row?.price ?? 0,
    vendor: row?.vendor || ''
  })
  showPart.value = true
}

async function submitPart() {
  if (!partForm.code || !partForm.name) return message.warning('备件编码与名称必填')
  partSaving.value = true
  try {
    await api.savePart({ ...partForm, id: partForm.id || undefined })
    message.success('保存成功')
    showPart.value = false
    loadParts(); loadStats()
  } catch (e: any) { message.error(e.message) }
  finally { partSaving.value = false }
}

function removePart(row: any) {
  dialog.warning({
    title: '删除备件',
    content: `确定删除「${row.name}」吗？已有出入库记录的备件不允许删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.delPart(row.id)
        message.success('已删除')
        loadParts(); loadStats()
      } catch (e: any) { message.error(e.message) }
    }
  })
}

onMounted(() => { loadStats(); loadParts() })
</script>

<style scoped>
.foot-note { margin-top: 10px; font-size: 12px; color: #98a2ad; }
.low-names { color: #854f0b; }
.low { color: #c9302c; font-weight: 600; }
.ok { color: #3b6d11; }
</style>
