<template>
  <div class="page-wrap">
    <!-- 概览 -->
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
        <!-- ───────── 巡检任务 ───────── -->
        <n-tab-pane name="task" tab="巡检任务">
          <n-form inline :model="query" class="no-print">
            <n-form-item label="状态">
              <n-select v-model:value="query.status" :options="statusOptions" clearable style="width:120px" />
            </n-form-item>
            <n-form-item label="所属计划">
              <n-select v-model:value="query.planId" :options="planOptions" clearable style="width:200px" />
            </n-form-item>
            <n-form-item label="关键词">
              <n-input v-model:value="query.keyword" placeholder="任务号 / 计划 / 巡检人" clearable style="width:190px" />
            </n-form-item>
            <n-form-item>
              <n-button type="primary" @click="loadTasks">查询</n-button>
              <n-button v-if="canEdit" style="margin-left:8px" @click="doGenerate">生成今日任务</n-button>
            </n-form-item>
          </n-form>

          <n-data-table
            :columns="taskColumns" :data="tasks" :loading="loading"
            :scroll-x="1080" :pagination="pagination" remote @update:page="onPage"
          />
          <div class="foot-note">
            业务闭环：计划 → 生成任务 → 现场执行登记 → 异常项自动生成告警与工单（含 SLA 时限）
          </div>
        </n-tab-pane>

        <!-- ───────── 巡检计划 ───────── -->
        <n-tab-pane name="plan" tab="巡检计划">
          <div style="margin-bottom:12px" class="no-print">
            <n-button v-if="canPlan" type="primary" @click="openPlan()">新建计划</n-button>
          </div>
          <n-data-table :columns="planColumns" :data="plans" :loading="planLoading" :scroll-x="1000" />
        </n-tab-pane>
      </n-tabs>
    </div>

    <!-- 执行巡检 -->
    <n-drawer v-model:show="showExec" :width="580" placement="right">
      <n-drawer-content :title="`执行巡检 · ${execTask?.code || ''}`" closable>
        <template v-if="execTask">
          <n-descriptions bordered :column="2" label-placement="left" size="small">
            <n-descriptions-item label="巡检计划" :span="2">{{ execTask.plan_name }}</n-descriptions-item>
            <n-descriptions-item label="区域">{{ execTask.region }}</n-descriptions-item>
            <n-descriptions-item label="计划日期">{{ execTask.plan_date }}</n-descriptions-item>
            <n-descriptions-item label="巡检人">{{ execTask.inspector || '未指派' }}</n-descriptions-item>
            <n-descriptions-item label="检查项">{{ execTask.items?.length || 0 }} 项</n-descriptions-item>
          </n-descriptions>

          <div class="sec-title">检查项登记</div>
          <div v-for="(row, i) in execForm" :key="i" class="exec-row">
            <div class="exec-head">
              <span class="idx">{{ i + 1 }}</span>
              <span class="exec-name">{{ row.item }}</span>
            </div>
            <n-radio-group v-model:value="row.result" size="small">
              <n-radio-button value="正常">正常</n-radio-button>
              <n-radio-button value="异常">异常</n-radio-button>
            </n-radio-group>
            <n-input
              v-model:value="row.note" size="small" style="margin-top:6px"
              :placeholder="row.result === '异常' ? '请描述异常现象（提交后带入工单）' : '备注（可选）'"
            />
            <n-input
              v-model:value="row.deviceCode" size="small" style="margin-top:6px"
              placeholder="关联设备编号（可选）"
            />
          </div>

          <n-alert v-if="abnormalCount" type="warning" style="margin-top:14px">
            检测到 <b>{{ abnormalCount }}</b> 项异常 —— 提交后系统将自动生成对应告警与工单（优先级「高」，按 SLA 计时）。
          </n-alert>
          <n-alert v-else type="success" style="margin-top:14px">
            当前全部为正常项，提交后任务将标记为已完成。
          </n-alert>
        </template>

        <template #footer>
          <n-space justify="end">
            <n-button @click="showExec = false">取消</n-button>
            <n-button type="primary" :loading="submitting" @click="doSubmit">提交巡检结果</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 巡检结果详情 -->
    <n-drawer v-model:show="showDetail" :width="520" placement="right">
      <n-drawer-content :title="`巡检结果 · ${detail?.code || ''}`" closable>
        <template v-if="detail">
          <n-descriptions bordered :column="2" label-placement="left" size="small">
            <n-descriptions-item label="计划" :span="2">{{ detail.plan_name }}</n-descriptions-item>
            <n-descriptions-item label="区域">{{ detail.region }}</n-descriptions-item>
            <n-descriptions-item label="巡检人">{{ detail.inspector || '—' }}</n-descriptions-item>
            <n-descriptions-item label="计划日期">{{ detail.plan_date }}</n-descriptions-item>
            <n-descriptions-item label="完成时间">{{ detail.finished_at || '—' }}</n-descriptions-item>
            <n-descriptions-item label="检查项">{{ detail.total }} 项</n-descriptions-item>
            <n-descriptions-item label="异常项">
              <n-tag size="small" :type="detail.abnormal ? 'error' : 'success'" round>
                {{ detail.abnormal }} 项
              </n-tag>
            </n-descriptions-item>
          </n-descriptions>

          <div class="sec-title">检查明细</div>
          <n-table :bordered="false" size="small">
            <thead>
              <tr><th>检查项</th><th style="width:90px">设备</th><th style="width:70px">结果</th><th>备注</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in detail.records" :key="r.id">
                <td>{{ r.item }}</td>
                <td>{{ r.device_code || '—' }}</td>
                <td>
                  <n-tag size="tiny" :type="r.result === '异常' ? 'error' : 'success'" round>{{ r.result }}</n-tag>
                </td>
                <td class="muted">{{ r.note || '—' }}</td>
              </tr>
            </tbody>
          </n-table>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 计划编辑 -->
    <n-modal v-model:show="showPlan" preset="card" :title="planForm.id ? '编辑巡检计划' : '新建巡检计划'" style="width:560px">
      <n-form :model="planForm" label-placement="top">
        <n-form-item label="计划名称">
          <n-input v-model:value="planForm.name" placeholder="如：一号产业园配电日常巡检" />
        </n-form-item>
        <n-form-item label="巡检区域">
          <n-select v-model:value="planForm.region" :options="regionOptions" />
        </n-form-item>
        <n-form-item label="设备类型">
          <n-select v-model:value="planForm.category" :options="categoryOptions" clearable placeholder="留空表示不限" />
        </n-form-item>
        <n-form-item label="巡检周期">
          <n-radio-group v-model:value="planForm.cycle">
            <n-radio-button v-for="c in CYCLES" :key="c" :value="c">{{ c }}</n-radio-button>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="负责人">
          <n-select v-model:value="planForm.owner" :options="staffOptions" clearable />
        </n-form-item>
        <n-form-item label="检查项（每行一项，或用顿号分隔）">
          <n-input
            v-model:value="planForm.itemsText" type="textarea" :rows="4"
            placeholder="指示灯与仪表状态&#10;接线端子有无松动&#10;柜内温度与异响"
          />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showPlan = false">取消</n-button>
          <n-button type="primary" :loading="planSaving" @click="submitPlan">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import {
  NGrid, NGi, NTabs, NTabPane, NForm, NFormItem, NInput, NSelect, NButton,
  NDataTable, NDrawer, NDrawerContent, NDescriptions, NDescriptionsItem,
  NSpace, NTag, NRadioGroup, NRadioButton, NAlert, NModal, NTable, useMessage, useDialog
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

const message = useMessage()
const dialog = useDialog()
const user = useUserStore()

const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区']
const CATEGORIES = ['环境监控', '安防摄像头', '配电柜', '门禁闸机', '消防主机', '能耗计量', '照明控制']
const CYCLES = ['每日', '每周', '每月']
const opts = (a: string[]) => a.map((v) => ({ label: v, value: v }))

const regionOptions = opts(REGIONS)
const categoryOptions = opts(CATEGORIES)
const statusOptions = [
  { label: '待执行', value: 'PENDING' },
  { label: '已完成', value: 'DONE' }
]

const canEdit = computed(() => user.hasPerm('inspection:edit'))
/** 计划维护是管理动作，与「执行巡检」分开授权 */
const canPlan = computed(() => user.hasPerm('inspection:plan'))

const tab = ref('task')
const stats = ref<any>({})
const plans = ref<any[]>([])
const tasks = ref<any[]>([])
const staffOptions = ref<any[]>([])
const planLoading = ref(false)
const loading = ref(false)
const page = ref(1)
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })
const query = reactive({ status: '', planId: null as number | null, keyword: '' })

const planOptions = computed(() => plans.value.map((p) => ({ label: p.name, value: p.id })))

const cards = computed(() => {
  const s = stats.value || {}
  return [
    { label: '待执行任务', value: s.pending ?? '-', sub: '需要现场执行的巡检', color: '#1f5f8b' },
    { label: '已完成任务', value: s.done ?? '-', sub: '历史累计完成', color: '#3b6d11' },
    { label: '含异常的任务', value: s.abnormalTasks ?? '-', sub: '执行中发现异常项', color: '#c9302c' },
    { label: '覆盖计划', value: plans.value.filter((p) => p.status).length, sub: `共 ${plans.value.length} 个计划`, color: '#854f0b' }
  ]
})

const taskColumns: DataTableColumns<any> = [
  { title: '任务编号', key: 'code', width: 150 },
  { title: '巡检计划', key: 'plan_name', ellipsis: { tooltip: true } },
  { title: '区域', key: 'region', width: 110 },
  { title: '巡检人', key: 'inspector', width: 90, render: (r) => r.inspector || '未指派' },
  {
    title: '状态', key: 'status', width: 90,
    render: (r) => h(NTag, {
      size: 'small', round: true, type: r.status === 'DONE' ? 'success' : 'warning'
    }, () => (r.status === 'DONE' ? '已完成' : '待执行'))
  },
  { title: '计划日期', key: 'plan_date', width: 110 },
  {
    title: '异常', key: 'abnormal', width: 80,
    render: (r) => (r.abnormal > 0
      ? h(NTag, { size: 'small', round: true, type: 'error' }, () => `${r.abnormal} 项`)
      : h('span', { class: 'muted' }, '—'))
  },
  {
    title: '操作', key: 'a', width: 130, fixed: 'right',
    render: (r) => (r.status === 'DONE'
      ? h(NButton, { size: 'tiny', text: true, onClick: () => openDetail(r.id) }, () => '查看结果')
      : h(NButton, {
        size: 'tiny', text: true, type: 'primary', disabled: !canEdit.value,
        onClick: () => openExec(r.id)
      }, () => '执行巡检'))
  }
]

const planColumns: DataTableColumns<any> = [
  { title: '计划名称', key: 'name', ellipsis: { tooltip: true } },
  { title: '区域', key: 'region', width: 110 },
  { title: '设备类型', key: 'category', width: 100, render: (r) => r.category || '不限' },
  { title: '周期', key: 'cycle', width: 70 },
  {
    title: '检查项', key: 'items', width: 200,
    render: (r) => h('span', { class: 'muted' }, (r.items || []).join('、'))
  },
  { title: '负责人', key: 'owner', width: 90, render: (r) => r.owner || '—' },
  {
    title: '任务进度', key: 'p', width: 120,
    render: (r) => `${r.taskDone}/${r.taskTotal}${r.taskPending ? `（待 ${r.taskPending}）` : ''}`
  },
  {
    title: '状态', key: 'status', width: 80,
    render: (r) => h(NTag, {
      size: 'small', round: true, type: r.status ? 'success' : 'default'
    }, () => (r.status ? '启用' : '停用'))
  },
  {
    title: '操作', key: 'a', width: 150, fixed: 'right',
    render: (r) => (canPlan.value
      ? h(NSpace, { size: 8 }, () => [
        h(NButton, { size: 'tiny', text: true, onClick: () => openPlan(r) }, () => '编辑'),
        h(NButton, { size: 'tiny', text: true, onClick: () => togglePlan(r) }, () => (r.status ? '停用' : '启用')),
        h(NButton, { size: 'tiny', text: true, type: 'error', onClick: () => removePlan(r) }, () => '删除')
      ])
      : h('span', { class: 'muted' }, '只读'))
  }
]

/* ───────── 数据加载 ───────── */

async function loadStats() {
  try { stats.value = await api.inspectionStats() } catch { /* 概览失败不阻塞列表 */ }
}

async function loadPlans() {
  planLoading.value = true
  try { plans.value = await api.inspectionPlans() }
  catch (e: any) { message.error(e.message) }
  finally { planLoading.value = false }
}

async function loadTasks() {
  loading.value = true
  try {
    const res = await api.inspectionTasks({
      status: query.status, planId: query.planId, keyword: query.keyword,
      page: page.value, pageSize: 20
    })
    tasks.value = res.list
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}

function onPage(p: number) { page.value = p; loadTasks() }

/* ───────── 生成任务 ───────── */

function doGenerate() {
  dialog.warning({
    title: '生成今日巡检任务',
    content: '将按所有「启用中」的巡检计划生成当日任务，已存在的会自动跳过。',
    positiveText: '生成',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const res: any = await api.generateTasks()
        message.success(`已生成 ${res.created} 个任务${res.skipped ? `，跳过 ${res.skipped} 个已存在` : ''}`)
        loadTasks(); loadPlans(); loadStats()
      } catch (e: any) { message.error(e.message) }
    }
  })
}

/* ───────── 执行巡检 ───────── */

const showExec = ref(false)
const submitting = ref(false)
const execTask = ref<any>(null)
const execForm = ref<any[]>([])

const abnormalCount = computed(() => execForm.value.filter((r) => r.result === '异常').length)

async function openExec(id: number) {
  try {
    const d = await api.inspectionTaskDetail(id)
    execTask.value = d
    execForm.value = (d.items || []).map((item: string) => ({
      item, result: '正常', note: '', deviceCode: ''
    }))
    showExec.value = true
  } catch (e: any) { message.error(e.message) }
}

async function doSubmit() {
  if (!execForm.value.length) return message.warning('没有可登记的检查项')
  submitting.value = true
  try {
    const res: any = await api.submitInspection(execTask.value.id, { results: execForm.value })
    message.success(res.abnormal
      ? `提交成功：${res.abnormal} 项异常，已自动生成 ${res.orders.length} 张工单`
      : '提交成功，本次巡检全部正常')
    showExec.value = false
    loadTasks(); loadPlans(); loadStats()
  } catch (e: any) { message.error(e.message) }
  finally { submitting.value = false }
}

/* ───────── 结果详情 ───────── */

const showDetail = ref(false)
const detail = ref<any>(null)

async function openDetail(id: number) {
  try {
    detail.value = await api.inspectionTaskDetail(id)
    showDetail.value = true
  } catch (e: any) { message.error(e.message) }
}

/* ───────── 计划维护 ───────── */

const showPlan = ref(false)
const planSaving = ref(false)
const planForm = reactive({
  id: 0, name: '', region: REGIONS[0], category: '', cycle: '每日', owner: '', itemsText: ''
})

function openPlan(row?: any) {
  Object.assign(planForm, {
    id: row?.id || 0,
    name: row?.name || '',
    region: row?.region || REGIONS[0],
    category: row?.category || '',
    cycle: row?.cycle || '每日',
    owner: row?.owner || '',
    itemsText: row ? (row.items || []).join('\n') : ''
  })
  showPlan.value = true
}

async function submitPlan() {
  if (!planForm.name) return message.warning('请填写计划名称')
  const items = planForm.itemsText.split(/[\n、,，]/).map((s) => s.trim()).filter(Boolean)
  if (!items.length) return message.warning('请至少填写一个检查项')

  planSaving.value = true
  try {
    await api.savePlan({
      id: planForm.id || undefined,
      name: planForm.name,
      region: planForm.region,
      category: planForm.category,
      cycle: planForm.cycle,
      owner: planForm.owner,
      items
    })
    message.success('保存成功')
    showPlan.value = false
    loadPlans()
  } catch (e: any) { message.error(e.message) }
  finally { planSaving.value = false }
}

async function togglePlan(row: any) {
  try {
    await api.togglePlan(row.id, !row.status)
    message.success(row.status ? '已停用' : '已启用')
    loadPlans()
  } catch (e: any) { message.error(e.message) }
}

function removePlan(row: any) {
  dialog.warning({
    title: '删除巡检计划',
    content: `确定删除「${row.name}」吗？已产生任务的计划不允许删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api.delPlan(row.id)
        message.success('已删除')
        loadPlans()
      } catch (e: any) { message.error(e.message) }
    }
  })
}

onMounted(async () => {
  await Promise.all([loadPlans(), loadStats()])
  loadTasks()
  try { staffOptions.value = (await api.staff()).map((s: any) => ({ label: s.realName, value: s.realName })) }
  catch { /* 人员列表失败不影响主流程 */ }
})
</script>

<style scoped>
.sec-title { font-size: 13px; font-weight: 600; margin: 18px 0 10px; }
.foot-note { margin-top: 10px; font-size: 12px; color: #98a2ad; }
.muted { color: #98a2ad; }
.exec-row {
  border: 1px solid #eef1f4; border-radius: 8px;
  padding: 10px 12px; margin-bottom: 10px;
}
.exec-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.exec-name { font-size: 13px; font-weight: 500; }
.idx {
  width: 18px; height: 18px; border-radius: 50%; background: #eaf0f5; color: #1f5f8b;
  font-size: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none;
}
</style>
