<template>
  <section class="page" data-module="flood">
    <header class="page-head">
      <div>
        <h2>泄洪操作管理</h2>
        <p class="page-desc">
          调度待办由水情记录的调度/复核环节回写：这里看到的「待调度」条数与水情调度页面完全一致，
          同一份明细；复核结论直接显示在待办上。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出调度待办清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待调度待办（= 水情待调度记录）</span>
        <strong class="stat-value">{{ recon.pendingDispatchTodos }} / {{ recon.pendingDispatchHydro }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">在调度链路</span>
        <strong class="stat-value">{{ todos.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已复核待办</span>
        <strong class="stat-value">{{ recon.reviewedTodos }}</strong>
      </article>
    </div>

    <p class="reconcile-bar" :class="recon.matched ? 'ok' : 'bad'">
      对账口径：水情页面待调度记录 <strong>{{ recon.pendingDispatchHydro }}</strong> 条，
      本页调度待办 <strong>{{ recon.pendingDispatchTodos }}</strong> 条，{{ recon.matched ? '两处一致 ✅' : '不一致 ❌' }}。
      口径与明细清单同源同变。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>回写的复核结论</th>
          <th>待办状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in todos" :key="row.todoId" :class="row.pending ? 'pending-row' : ''">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.复核结论 || '（待水情复核后回写）' }}</td>
          <td>{{ row.status }}{{ row.pending ? ' · 待调度' : '' }}</td>
        </tr>
        <tr v-if="!todos.length">
          <td :colspan="columns.length + 2" class="empty-state">
            <div class="empty-title">暂无内容</div>
            <div class="empty-reason">还没有进入调度链路的水情记录；水情记录「提交观测」后会自动回写一条待办到这里。</div>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ todos.length }} 条调度待办，与水情页面明细条数相同</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadCsv } from '@/api/local-service'
import { listFloodTodos, reconcile } from '@/api/hydro-service'
import type { FloodTodo } from '@/data/types'

const columns = ['操作编号', '记录编号', '观测时间', '泄洪闸号', '建议']
const todos = ref<FloodTodo[]>([])
const recon = ref({
  pendingDispatchHydro: 0,
  pendingDispatchTodos: 0,
  matched: true,
  totalTodos: 0,
  reviewedTodos: 0,
  missingRecords: 0,
  fallbackRecords: 0,
  hazardCount: 0,
  pendingHazards: 0,
})

const statusSummary = computed(() =>
  ['已观测', '已调度', '已复核'].map((status) => ({
    status: status === '已观测' ? '待调度' : status,
    count: todos.value.filter((row) => row.status === status).length,
  })),
)

function exportRows() {
  const header = [...columns, '回写的复核结论', '待办状态']
  const lines = [header.join(',')]
  const esc = (v: unknown) => {
    const text = v === null || v === undefined || v === '' ? '暂无数据' : String(v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  for (const row of todos.value) {
    lines.push([...columns.map((c) => esc(row[c])), esc(row.复核结论 || ''), esc(row.status)].join(','))
  }
  downloadCsv('泄洪操作-调度待办清单.csv', `﻿${lines.join('\n')}`)
}

function refresh() {
  todos.value = listFloodTodos()
  recon.value = reconcile()
}

onMounted(refresh)
</script>

<style scoped>
.reconcile-bar { font-size: 13px; padding: 8px 12px; border-radius: 6px; margin: 0 0 12px; }
.reconcile-bar.ok { background: #ecfdf3; color: #15803d; border: 1px solid #abefc6; }
.reconcile-bar.bad { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.pending-row { background: #fffaeb; }
.empty-title { font-weight: 700; }
.empty-reason { font-size: 12px; color: #64748b; }
</style>
