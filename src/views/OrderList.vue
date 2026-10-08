<template>
  <div class="page-wrap">
    <div class="page-card">
      <n-form inline :model="query">
        <n-form-item label="状态">
          <n-select v-model:value="query.status" :options="statusOptions" clearable style="width:120px" />
        </n-form-item>
        <n-form-item label="类型">
          <n-select v-model:value="query.type" :options="typeOptions" clearable style="width:130px" />
        </n-form-item>
        <n-form-item label="优先级">
          <n-select v-model:value="query.priority" :options="priorityOptions" clearable style="width:100px" />
        </n-form-item>
        <n-form-item label="关键词">
          <n-input v-model:value="query.keyword" placeholder="工单号 / 标题" clearable style="width:170px" />
        </n-form-item>
        <n-form-item>
          <n-button type="primary" @click="load">查询</n-button>
          <n-button style="margin-left:8px" @click="openCreate">新建工单</n-button>
        </n-form-item>
      </n-form>

      <n-data-table :columns="columns" :data="rows" :loading="loading" :scroll-x="1100"
        :pagination="pagination" remote @update:page="onPage" />

      <div class="flow-tip">
        状态机：待受理 → 处理中 → 待验收 → 已闭环（待验收可打回处理中）
      </div>
    </div>

    <!-- 详情抽屉：状态流转 + 时间轴 -->
    <n-drawer v-model:show="showDetail" :width="520" placement="right">
      <n-drawer-content :title="`工单 ${detail?.code || ''}`" closable>
        <template v-if="detail">
          <n-descriptions bordered :column="2" label-placement="left" size="small">
            <n-descriptions-item label="标题" :span="2">{{ detail.title }}</n-descriptions-item>
            <n-descriptions-item label="类型">{{ detail.type }}</n-descriptions-item>
            <n-descriptions-item label="优先级">{{ detail.priority }}</n-descriptions-item>
            <n-descriptions-item label="当前状态">
              <n-tag size="small" :type="STATUS_TYPE[detail.status]" round>{{ STATUS_TEXT[detail.status] }}</n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="处理人">{{ detail.handler || '未指派' }}</n-descriptions-item>
            <n-descriptions-item label="关联设备">{{ detail.device_code || '-' }}</n-descriptions-item>
            <n-descriptions-item label="所属区域">{{ detail.region || '-' }}</n-descriptions-item>
          </n-descriptions>

          <div class="sec-title">流转操作</div>
          <n-space>
            <n-button
              v-for="to in nextActions" :key="to" size="small" type="primary"
              :disabled="!canEdit" @click="flow(to)"
            >
              流转至「{{ STATUS_TEXT[to] }}」
            </n-button>
            <span v-if="!nextActions.length" class="done">已闭环，无后续流转</span>
            <span v-if="!canEdit" class="done">当前角色只读</span>
          </n-space>

          <div class="sec-title">流转记录</div>
          <n-timeline>
            <n-timeline-item
              v-for="t in detail.timeline" :key="t.id"
              :title="t.action" :content="t.note" :time="t.created_at"
              :type="t.action === '验收闭环' ? 'success' : 'default'"
            >
              <template #default>{{ t.note }}</template>
              <template #footer><span class="who">{{ t.operator }}</span></template>
            </n-timeline-item>
          </n-timeline>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- 新建工单 -->
    <n-modal v-model:show="showCreate" preset="card" title="新建工单" style="width:520px">
      <n-form :model="form" label-placement="top">
        <n-form-item label="工单标题"><n-input v-model:value="form.title" /></n-form-item>
        <n-form-item label="工单类型">
          <n-select v-model:value="form.type" :options="typeOptions" />
        </n-form-item>
        <n-form-item label="优先级">
          <n-select v-model:value="form.priority" :options="priorityOptions" />
        </n-form-item>
        <n-form-item label="关联设备编号"><n-input v-model:value="form.deviceCode" placeholder="可留空" /></n-form-item>
        <n-form-item label="所属区域">
          <n-select v-model:value="form.region" :options="regionOptions" />
        </n-form-item>
        <n-form-item label="备注"><n-input v-model:value="form.remark" type="textarea" /></n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showCreate = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="submitCreate">提交</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import {
  NForm, NFormItem, NInput, NSelect, NButton, NDataTable, NDrawer, NDrawerContent,
  NDescriptions, NDescriptionsItem, NSpace, NTag, NTimeline, NTimelineItem, NModal,
  useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'
import { useUserStore } from '@/store/user'

const message = useMessage()
const user = useUserStore()

const rows = ref<any[]>([])
const loading = ref(false)
const page = ref(1)
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })

const STATUS_TEXT: Record<string, string> = {
  PENDING: '待受理', PROCESSING: '处理中', CHECKING: '待验收', CLOSED: '已闭环'
}
const STATUS_TYPE: Record<string, any> = {
  PENDING: 'warning', PROCESSING: 'info', CHECKING: 'default', CLOSED: 'success'
}
const NEXT: Record<string, string[]> = {
  PENDING: ['PROCESSING'], PROCESSING: ['CHECKING'], CHECKING: ['CLOSED', 'PROCESSING'], CLOSED: []
}
const TYPES = ['故障报修', '巡检任务', '保养计划', '改造施工']
const PRIORITIES = ['高', '中', '低']
const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区']
const opts = (a: string[]) => a.map((v) => ({ label: v, value: v }))

const statusOptions = Object.entries(STATUS_TEXT).map(([v, l]) => ({ label: l, value: v }))
const typeOptions = opts(TYPES)
const priorityOptions = opts(PRIORITIES)
const regionOptions = opts(REGIONS)

const query = reactive({ status: '', type: '', priority: '', keyword: '' })
const canEdit = computed(() => user.hasPerm('order:edit'))

const showDetail = ref(false)
const detail = ref<any>(null)
const nextActions = computed(() => (detail.value ? NEXT[detail.value.status] || [] : []))

const showCreate = ref(false)
const saving = ref(false)
const form = reactive({ title: '', type: TYPES[0], priority: '中', deviceCode: '', region: REGIONS[0], remark: '' })

const columns: DataTableColumns<any> = [
  { title: '工单号', key: 'code', width: 110 },
  { title: '标题', key: 'title', ellipsis: { tooltip: true } },
  { title: '类型', key: 'type', width: 100 },
  {
    title: '优先级', key: 'priority', width: 80,
    render: (r) => h(NTag, {
      size: 'small', round: true,
      type: r.priority === '高' ? 'error' : r.priority === '中' ? 'warning' : 'default'
    }, () => r.priority)
  },
  {
    title: '状态', key: 'status', width: 90,
    render: (r) => h(NTag, { size: 'small', round: true, type: STATUS_TYPE[r.status] }, () => STATUS_TEXT[r.status])
  },
  { title: '处理人', key: 'handler', width: 90, render: (r) => r.handler || '—' },
  { title: '区域', key: 'region', width: 110 },
  { title: '创建时间', key: 'created_at', width: 110 },
  {
    title: '操作', key: 'a', width: 90, fixed: 'right',
    render: (r) => h(NButton, { size: 'tiny', text: true, onClick: () => openDetail(r.id) }, () => '详情')
  }
]

async function load() {
  loading.value = true
  try {
    const res = await api.orders({ ...query, page: page.value, pageSize: 20 })
    rows.value = res.list
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}
function onPage(p: number) { page.value = p; load() }

async function openDetail(id: number) {
  try {
    detail.value = await api.orderDetail(id)
    showDetail.value = true
  } catch (e: any) { message.error(e.message) }
}

async function flow(to: string) {
  try {
    await api.flowOrder(detail.value.id, {
      to, handler: detail.value.handler || user.profile?.realName, note: `${STATUS_TEXT[to]}`
    })
    message.success('流转成功')
    detail.value = await api.orderDetail(detail.value.id)
    load()
  } catch (e: any) { message.error(e.message) }
}

function openCreate() {
  Object.assign(form, { title: '', type: TYPES[0], priority: '中', deviceCode: '', region: REGIONS[0], remark: '' })
  showCreate.value = true
}

async function submitCreate() {
  if (!form.title) return message.warning('请填写工单标题')
  saving.value = true
  try {
    await api.createOrder(form)
    message.success('工单已创建')
    showCreate.value = false
    load()
  } catch (e: any) { message.error(e.message) }
  finally { saving.value = false }
}

onMounted(load)
</script>

<style scoped>
.sec-title { font-size: 13px; font-weight: 600; margin: 18px 0 10px; }
.done { font-size: 12px; color: #98a2ad; }
.who { font-size: 12px; color: #79838c; }
.flow-tip { margin-top: 10px; font-size: 12px; color: #98a2ad; }
</style>
