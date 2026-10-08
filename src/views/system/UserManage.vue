<template>
  <div class="page-wrap">
    <div class="page-card">
      <div class="toolbar">
        <n-button type="primary" size="small" @click="openForm()">新增用户</n-button>
        <n-input v-model:value="query.keyword" placeholder="账号 / 姓名" clearable style="width:180px" />
        <n-select v-model:value="query.roleCode" :options="roleOptions" clearable placeholder="角色" style="width:140px" />
        <n-button size="small" @click="load">查询</n-button>
      </div>

      <n-data-table :columns="columns" :data="rows" :loading="loading" :pagination="pagination"
        remote @update:page="onPage" />
    </div>

    <n-modal v-model:show="showForm" preset="card" :title="editing ? '编辑用户' : '新增用户'" style="width:480px">
      <n-form :model="form" label-placement="top">
        <n-form-item label="登录账号"><n-input v-model:value="form.username" :disabled="!!editing" /></n-form-item>
        <n-form-item label="姓名"><n-input v-model:value="form.realName" /></n-form-item>
        <n-form-item label="手机号"><n-input v-model:value="form.phone" /></n-form-item>
        <n-form-item label="角色">
          <n-select v-model:value="form.roleCode" :options="roleOptions" />
        </n-form-item>
        <n-form-item label="所属区域">
          <n-select v-model:value="form.region" :options="regionOptions" />
        </n-form-item>
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
import { NButton, NDataTable, NInput, NSelect, NModal, NForm, NFormItem, NSpace, NTag, NSwitch, useMessage, useDialog } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { api } from '@/api'

const message = useMessage()
const dialog = useDialog()
const rows = ref<any[]>([])
const roles = ref<any[]>([])
const loading = ref(false)
const page = ref(1)
const pagination = reactive({ page: 1, pageSize: 20, itemCount: 0 })
const query = reactive({ keyword: '', roleCode: '' })

const REGIONS = ['一号产业园', '二号产业园', '智能制造区', '研发综合楼', '仓储物流区', '全部区域']
const regionOptions = REGIONS.map((v) => ({ label: v, value: v }))
const roleOptions = computed(() => roles.value.map((r) => ({ label: `${r.name}（${r.code}）`, value: r.code })))

const showForm = ref(false)
const saving = ref(false)
const editing = ref<any>(null)
const form = reactive({ username: '', realName: '', phone: '', roleCode: 'operator', region: REGIONS[0] })

const ROLE_TYPE: Record<string, any> = { admin: 'error', manager: 'warning', operator: 'info' }
const ROLE_NAME: Record<string, string> = { admin: '系统管理员', manager: '运维主管', operator: '运维专员' }

const columns: DataTableColumns<any> = [
  { title: '账号', key: 'username', width: 110 },
  { title: '姓名', key: 'real_name', width: 90 },
  { title: '手机号', key: 'phone', width: 130 },
  {
    title: '角色', key: 'role_code', width: 110,
    render: (r) => h(NTag, { size: 'small', round: true, type: ROLE_TYPE[r.role_code] }, () => ROLE_NAME[r.role_code] || r.role_code)
  },
  { title: '区域', key: 'region', width: 120 },
  {
    title: '状态', key: 'status', width: 90,
    render: (r) => h(NSwitch, { size: 'small', value: !!r.status, onUpdateValue: (v: boolean) => toggle(r, v) })
  },
  { title: '创建时间', key: 'created_at', width: 170 },
  {
    title: '操作', key: 'a', width: 170, fixed: 'right',
    render: (r) => h(NSpace, {}, () => [
      h(NButton, { size: 'tiny', text: true, onClick: () => openForm(r) }, () => '编辑'),
      h(NButton, { size: 'tiny', text: true, onClick: () => reset(r) }, () => '重置密码'),
      h(NButton, { size: 'tiny', text: true, type: 'error', onClick: () => remove(r) }, () => '删除')
    ])
  }
]

async function load() {
  loading.value = true
  try {
    const res = await api.users({ ...query, page: page.value, pageSize: 20 })
    rows.value = res.list
    pagination.itemCount = res.total
    pagination.page = page.value
  } catch (e: any) { message.error(e.message) }
  finally { loading.value = false }
}
function onPage(p: number) { page.value = p; load() }

function openForm(row?: any) {
  editing.value = row || null
  Object.assign(form, row
    ? { username: row.username, realName: row.real_name, phone: row.phone, roleCode: row.role_code, region: row.region }
    : { username: '', realName: '', phone: '', roleCode: 'operator', region: REGIONS[0] })
  showForm.value = true
}

async function save() {
  if (!form.username || !form.realName) return message.warning('账号与姓名必填')
  saving.value = true
  try {
    await api.saveUser(editing.value ? { ...form, id: editing.value.id } : form)
    message.success('保存成功')
    showForm.value = false
    load()
  } catch (e: any) { message.error(e.message) }
  finally { saving.value = false }
}

async function toggle(row: any, v: boolean) {
  try { await api.toggleUser(row.id, v); message.success('状态已更新'); load() }
  catch (e: any) { message.error(e.message) }
}

function reset(row: any) {
  dialog.warning({
    title: '重置密码', content: `将「${row.real_name}」的密码重置为 123456，确定吗？`,
    positiveText: '重置', negativeText: '取消',
    onPositiveClick: async () => {
      try { await api.resetPwd(row.id); message.success('已重置为 123456') }
      catch (e: any) { message.error(e.message) }
    }
  })
}

function remove(row: any) {
  dialog.warning({
    title: '删除用户', content: `确定删除用户「${row.username}」吗？`,
    positiveText: '删除', negativeText: '取消',
    onPositiveClick: async () => {
      try { await api.delUser(row.id); message.success('已删除'); load() }
      catch (e: any) { message.error(e.message) }
    }
  })
}

onMounted(async () => {
  roles.value = await api.roles()
  load()
})
</script>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
</style>
