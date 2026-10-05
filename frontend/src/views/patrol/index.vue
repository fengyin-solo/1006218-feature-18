<template>
  <section class="page" data-module="patrol">
    <header class="page-head">
      <div>
        <h2>现场巡视 · 隐患清单</h2>
        <p class="page-desc">
          水情复核的处理结论回写本清单；现场登记时同业务日期、同点位、同描述的重复上报只认第一次取值，
          后到的按重复处理；历史数据按业务日期补数，缺失字段单独罗列。导出条数与页面一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出隐患清单</button>
        <button class="btn" type="button" @click="resetPatrol">重置示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">清单隐患（页面=导出条数）</span>
        <strong class="stat-value">{{ hazards.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待处理</span>
        <strong class="stat-value">{{ recon.pendingHazards }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">水情回写隐患</span>
        <strong class="stat-value">{{ fromHydro }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">被判重的重复上报（不计入清单）</span>
        <strong class="stat-value">{{ rejected.length }}</strong>
      </article>
    </div>

    <!-- 现场登记：重复时只认第一次 -->
    <section class="panel">
      <div class="panel-head"><h3>现场隐患登记</h3></div>
      <div class="register-grid">
        <label><span>业务日期</span><input v-model="form.业务日期" type="date" /></label>
        <label><span>巡视点位</span><input v-model="form.巡视点位" placeholder="如：坝顶 0+200" /></label>
        <label><span>隐患描述</span><input v-model="form.隐患描述" placeholder="如：防浪墙裂缝" /></label>
        <label>
          <span>隐患等级</span>
          <select v-model="form.隐患等级">
            <option>一般</option>
            <option>较大</option>
            <option>重大</option>
          </select>
        </label>
      </div>
      <button class="btn primary" type="button" @click="submitHazard">登记隐患</button>
      <span v-if="message" :class="lastOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </section>

    <h3 class="table-title">隐患清单（{{ hazards.length }}）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>缺失字段（历史补数单列）</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in hazards" :key="String(row.id)" :class="row.来源 === '水情回写' ? 'hydro-row' : ''">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            <span v-if="row.missingFields.length" class="missing-tag">{{ row.missingFields.join('、') }}</span>
            <span v-else class="muted">完整</span>
          </td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!hazards.length">
          <td :colspan="columns.length + 2" class="empty-state">
            <div class="empty-title">暂无内容</div>
            <div class="empty-reason">当前没有隐患记录。</div>
          </td>
        </tr>
      </tbody>
    </table>

    <h3 class="table-title muted">重复上报记录（{{ rejected.length }}，只认第一次取值，未计入清单与导出）</h3>
    <table class="data-table rejected-table">
      <thead>
        <tr><th>驳回编号</th><th>业务日期</th><th>巡视点位</th><th>隐患描述</th><th>判重原因</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rejected" :key="String(row.id)">
          <td>{{ row.隐患编号 }}</td>
          <td>{{ row.业务日期 }}</td>
          <td>{{ row.巡视点位 }}</td>
          <td>{{ row.隐患描述 }}</td>
          <td class="error-text">与第一次登记重复，按重复处理，取值以第一次为准</td>
        </tr>
        <tr v-if="!rejected.length">
          <td colspan="5" class="empty-state">暂无重复上报</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>清单 {{ hazards.length }} 条，导出 CSV 同为 {{ hazards.length }} 条（重复上报不导出）</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadCsv } from '@/api/local-service'
import { listHazards, reconcile, registerHazard, rejectedHazards } from '@/api/hydro-service'
import { resetRows } from '@/data/local-store'
import type { HazardRecord } from '@/data/types'

const columns = ['隐患编号', '业务日期', '巡视点位', '隐患描述', '隐患等级', '处理结论', '来源', '关联记录']
const hazards = ref<HazardRecord[]>([])
const rejected = ref<HazardRecord[]>([])
const message = ref('')
const lastOk = ref(true)

const form = reactive({
  业务日期: new Date().toISOString().slice(0, 10),
  巡视点位: '',
  隐患描述: '',
  隐患等级: '一般',
})

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

const fromHydro = computed(() => hazards.value.filter((row) => row.来源 === '水情回写').length)

function notify(ok: boolean, text: string) {
  lastOk.value = ok
  message.value = text
}

function submitHazard() {
  if (!form.业务日期 || !form.巡视点位.trim() || !form.隐患描述.trim()) {
    notify(false, '业务日期、巡视点位、隐患描述都不能为空')
    return
  }
  const result = registerHazard({ ...form })
  notify(result.ok, result.message)
  if (result.ok) {
    form.巡视点位 = ''
    form.隐患描述 = ''
  }
  refresh()
}

function exportRows() {
  const header = [...columns, '缺失字段', '状态']
  const lines = [header.join(',')]
  const esc = (v: unknown) => {
    const text = v === null || v === undefined || v === '' ? '暂无数据' : String(v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  for (const row of hazards.value) {
    lines.push([
      ...columns.map((c) => esc(row[c])),
      esc(row.missingFields.join('、') || '完整'),
      esc(row.status),
    ].join(','))
  }
  downloadCsv('现场巡视-隐患清单.csv', `﻿${lines.join('\n')}`)
  notify(true, `已导出 ${hazards.value.length} 条，与页面清单条数一致`)
}

function resetPatrol() {
  resetRows('patrol')
  refresh()
  notify(true, '隐患清单已重置为示例数据')
}

function refresh() {
  hazards.value = listHazards()
  rejected.value = rejectedHazards()
  recon.value = reconcile()
}

onMounted(refresh)
</script>

<style scoped>
.panel { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.panel-head h3 { margin: 0 0 8px; font-size: 15px; }
.register-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px; }
.register-grid span { display: block; font-size: 12px; color: #64748b; }
.register-grid input, .register-grid select { width: 100%; border: 1px solid #d8dee6; border-radius: 6px; padding: 6px 8px; }
.table-title { font-size: 14px; margin: 16px 0 8px; }
.muted { color: #64748b; }
.ok-text { color: #15803d; }
.error-text { color: #b42318; }
.hydro-row { background: #eff8ff; }
.missing-tag { font-size: 12px; color: #b54708; background: #fffaeb; border-radius: 4px; padding: 1px 6px; }
.rejected-table { opacity: 0.85; }
.empty-title { font-weight: 700; }
.empty-reason { font-size: 12px; color: #64748b; }
</style>
