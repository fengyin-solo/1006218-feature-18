<template>
  <section class="page" data-module="flood">
    <header class="page-head">
      <div>
        <h2>泄洪操作管理</h2>
        <p class="page-desc">
          水情复核结论回写到本页调度待办；待调度条数与水情页同口径，未处理待办单独列出。
          环节按 待审批→已批准→泄洪中→已结束 顺序推进，跳级直接拦下。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="doExport">导出明细与待办（与页面条数一致）</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待审批操作</span>
        <strong class="stat-value">{{ view.stats.pendingApproval }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">泄洪中闸门</span>
        <strong class="stat-value">{{ view.stats.discharging }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">今日泄洪量合计（空值不参与）</span>
        <strong class="stat-value">{{ view.stats.todayDischarge ?? '暂无数据' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待调度（与水情页一致）/ 未处理待办</span>
        <strong class="stat-value">{{ view.stats.pendingDispatch }} / {{ view.stats.openTodoCount }}</strong>
      </article>
    </div>

    <h3 class="section-title">
      调度待办（{{ view.openTodos.length }} 条）
      <span class="hint">来源：水情记录复核回写，处理结论在此关闭</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr><th>待办号</th><th>所属操作单</th><th>来源水情记录</th><th>观测时间</th><th>事项</th><th>复核结论</th><th>操作</th></tr>
      </thead>
      <tbody>
        <tr v-for="{ todo, floodNo, floodId } in view.openTodos" :key="todo.id">
          <td>#{{ todo.id }}</td>
          <td>{{ floodNo }}</td>
          <td>{{ todo.sourceRecordNo }}</td>
          <td>{{ formatTime(todo.observedAt) }}</td>
          <td>{{ todo.title }}</td>
          <td>
            <span v-if="todo.conclusion">
              {{ todo.conclusion.result }}（{{ todo.conclusion.reviewer }}）
              <span class="reason-text">{{ todo.conclusion.opinion }}</span>
            </span>
            <span v-else class="null-badge">暂无结论</span>
          </td>
          <td><button class="link" type="button" @click="closeTodo(floodId, todo.id)">标记已处理</button></td>
        </tr>
        <tr v-if="!view.openTodos.length">
          <td colspan="7" class="empty-state">暂无未处理的调度待办</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">
      泄洪操作明细（{{ view.all.length }} 条）
      <span class="hint">取不到的孔数/流量显示「暂无数据」，不按 0 计</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>操作编号</th><th>泄洪闸号</th><th>开启孔数</th><th>泄洪流量</th>
          <th>下游预警</th><th>操作时间</th><th>操作人员</th><th>状态</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in view.all" :key="row.id">
          <td>{{ row.操作编号 }}</td>
          <td>{{ row.泄洪闸号 || '暂无数据' }}</td>
          <td>
            <span v-if="row.开启孔数 === null" class="null-badge">暂无数据</span>
            <span v-else>{{ row.开启孔数 }}</span>
          </td>
          <td>
            <span v-if="row.泄洪流量 === null" class="null-badge">暂无数据</span>
            <span v-else>{{ row.泄洪流量 }}</span>
          </td>
          <td>{{ row.下游预警 || '暂无数据' }}</td>
          <td>{{ formatTime(row.操作时间) }}</td>
          <td>{{ row.操作人员 || '暂无数据' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="act in nextActions(row.status)"
              :key="act.target"
              class="link"
              type="button"
              :disabled="!act.enabled"
              :title="act.reason"
              @click="doAdvance(row.id, act.target)"
            >
              {{ act.label }}
            </button>
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>
        操作单 {{ view.all.length }} 条 · 未处理调度待办 {{ view.openTodos.length }} 条 ·
        待调度口径 {{ view.stats.pendingDispatch }} 条（=水情页未复核记录 {{ view.stats.pendingDispatch - view.stats.openTodoCount }} 条 + 未处理待办 {{ view.stats.openTodoCount }} 条，与水情页同一函数统计）
      </span>
      <span v-if="message" class="error-text">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { advanceFlood, resolveTodo } from '@/domain/flood-service'
import { exportFlood, floodView } from '@/domain/views'
import type { FloodStatus } from '@/domain/types'

const statuses: FloodStatus[] = ['待审批', '已批准', '泄洪中', '已结束']
const labels: Record<FloodStatus, string> = {
  待审批: '提交审批',
  已批准: '开启泄洪',
  泄洪中: '结束泄洪',
  已结束: '已结束',
}

const view = ref(floodView())
const message = ref('')

function reload() {
  view.value = floodView()
}
onMounted(reload)

function formatTime(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : iso
}

function nextActions(status: FloodStatus) {
  const idx = statuses.indexOf(status)
  return statuses.slice(1).map((target, i) => {
    const enabled = i === idx
    return {
      target,
      label: labels[statuses[i]],
      enabled,
      reason: enabled ? '' : `顺序未到：需先完成 ${statuses.slice(idx + 1, i + 1).join('、')}`,
    }
  })
}

function doAdvance(id: number, target: FloodStatus) {
  const res = advanceFlood(id, target)
  message.value = res.message
  if (res.ok) message.value = ''
  reload()
}

function closeTodo(floodId: number, todoId: number) {
  const res = resolveTodo(floodId, todoId)
  message.value = res.ok ? '' : res.message
  reload()
}

function doExport() {
  exportFlood(view.value)
}
</script>
