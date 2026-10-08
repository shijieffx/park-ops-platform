<template>
  <div class="page-wrap">
    <div class="page-card">
      <div class="toolbar">
        <n-button type="primary" size="small" @click="openForm()">新增角色</n-button>
        <span class="hint">数据范围：ALL 全部数据 ｜ REGION 本区域 ｜ SELF 仅本人相关</span>
      </div>

      <n-data-table :columns="columns" :data="rows" :loading="loading" />

      <!-- 权限矩阵：直观展示每个角色可见的菜单 -->
      <div class="sec-title">角色 × 菜单权限矩阵</div>
      <n-data-table :columns="matrixColumns" :data="matrixRows" :bordered="false" size="small" />
    </div>

    <n-modal v-model:show="showForm" preset="card" :title="editing ? '编辑角色' : '新增角色'" style="width:460px">
      <n-form :model="form" label-placement="top">
        <n-form-item label="角色名称"><n-input v-model:value="form.name" /></n-form-item>
        <n-form-item label="角色编码"><n-input v-model:value="form.code" :disabled="!!editing" placeholder="如 operator" /></n-form-item>
        <n-form-item label="数据范围">
          <n-select v-model:value="form.dataScope" :options="scopeOptions" />
        </n-form-item>
        <n-form-item label="说明"><n-input v-model:value="form.remark" type="textarea" /></n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showForm = false">取消</n-button>
          <n-button type="primary" :loading="saving" @click="save">保存</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, h } from 'vue'
import { NButton, NDataTable, NInput, NSelect, NModal, NForm, NFormItem, NSpace, NTag, useMessage, useDialog } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'

const message = useMessage()
const dialog = useDialog()
const rows = ref<any[]>([])
const loading = ref(false)
const menus = ref<any[]>([])

const scopeOptions = [
  { label: 'ALL — 全部数据', value: 'ALL' },
  { label: 'REGION — 本区域', value: 'REGION' },
  { label: 'SELF — 仅本人相关', value: 'SELF' }
]

const showForm = ref(false)
const saving = ref(false)
const editing = ref<any>(null)
const form = reactive({ name: '', code: '', dataScope: 'SELF', remark: '' })

const ROLE_PERMS: Record<string, string[]> = {
  admin: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view', 'system:view', 'system:user', 'system:role', 'system:dict'],
  manager: ['dashboard:view', 'device:view', 'device:edit', 'order:view', 'order:edit',
    'alarm:view', 'report:view'],
  operator: ['dashboard:view', 'device:view', 'order:view', 'order:edit', 'alarm:view']
}

const columns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '角色名称', key: 'name', width: 120 },
  { title: '角色编码', key: 'code', width: 110 },
  {
    title: '数据范围', key: 'data_scope', width: 110,
    render: (r) => h(NTag, {
      size: 'small', round: true,
      type: r.data_scope === 'ALL' ? 'error' : r.data_scope === 'REGION' ? 'warning' : 'info'
    }, () => r.data_scope)
  },
  { title: '说明', key: 'remark' },
  {
    title: '操作', key: 'a', width: 130, fixed: 'right',
    render: (r) => h(NSpace, {}, () => [
      h(NButton, { size: 'tiny', text: true, onClick: () => openForm(r) }, () => '编辑'),
      h(NButton, { size: 'tiny', text: true, type: 'error', onClick: () => remove(r) }, () => '删除')
    ])
  }
]

const matrixRows = computed(() => rows.value.map((r) => {
  const obj: Record<string, any> = { role: `${r.name}（${r.code}）` }
  menus.value.forEach((m) => {
    obj[m.perm] = (ROLE_PERMS[r.code] || []).includes(m.perm) ? '✓' : '—'
  })
  return obj
}))

const matrixColumns = computed<DataTableColumns<any>>(() => [
  { title: '角色', key: 'role', width: 170, fixed: 'left' },
  ...menus.value.map((m) => ({
    title: m.title, key: m.perm, width: 100, align: 'center' as const,
    render: (r: any) => h('span', {
      style: { color: r[m.perm] === '✓' ? '#18a058' : '#c0c6cc', fontWeight: 600 }
    }, r[m.perm])
  }))
])

async function load() {
  loading.value = true
  try {
    rows.value = await api.roles()
    menus.value = await api.menus()
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}

function openForm(row?: any) {
  editing.value = row || null
  Object.assign(form, row
    ? { name: row.name, code: row.code, dataScope: row.data_scope, remark: row.remark || '' }
    : { name: '', code: '', dataScope: 'SELF', remark: '' })
  showForm.value = true
}

async function save() {
  if (!form.name || !form.code) return message.warning('角色名称与编码必填')
  saving.value = true
  try {
    await api.saveRole(editing.value ? { ...form, id: editing.value.id } : form)
    message.success('保存成功')
    showForm.value = false
    load()
  } catch (e: any) { message.error(e.message) }
  finally { saving.value = false }
}

function remove(row: any) {
  dialog.warning({
    title: '删除角色', content: `确定删除角色「${row.name}」吗？`,
    positiveText: '删除', negativeText: '取消',
    onPositiveClick: async () => {
      try { await api.delRole(row.id); message.success('已删除'); load() }
      catch (e: any) { message.error(e.message) }
    }
  })
}

onMounted(load)
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.hint { font-size: 12px; color: #98a2ad; }
.sec-title { font-size: 13px; font-weight: 600; margin: 20px 0 10px; }
</style>
