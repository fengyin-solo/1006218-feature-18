<template>
  <section class="page hydro-page" data-module="hydrology">
    <header class="page-head">
      <div>
        <h2>水情调度管理</h2>
        <p class="page-desc">
          取不到的遥测项留空（null）而不是填 0：页面显示「暂无数据」及失败原因，可重试；
          连续中断超 60 分钟必须先人工补测；空值不参与流量平衡，缺失时按前时段兜底并注明。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="resetHydro">重置示例数据</button>
        <button class="btn" type="button" @click="exportRows">导出水情调度清单</button>
      </div>
    </header>

    <!-- 对账口径：与泄洪页面读同一份调度待办明细，两处待调度条数必须对得上 -->
    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">今日入库流量（缺测不计 0）</span>
        <strong class="stat-value">{{ today.inflow === null ? '暂无数据' : today.inflow + ' m³/s' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">今日出库流量（缺测不计 0）</span>
        <strong class="stat-value">{{ today.outflow === null ? '暂无数据' : today.outflow + ' m³/s' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待调度记录（= 泄洪待调度待办）</span>
        <strong class="stat-value">{{ recon.pendingDispatchHydro }} / {{ recon.pendingDispatchTodos }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">空值记录（单列）/ 兜底使用</span>
        <strong class="stat-value">{{ recon.missingRecords }} 条 / {{ recon.fallbackRecords }} 次</strong>
      </article>
    </div>

    <p class="reconcile-bar" :class="recon.matched ? 'ok' : 'bad'">
      对账：水情待调度 <strong>{{ recon.pendingDispatchHydro }}</strong> 条，泄洪调度待办
      <strong>{{ recon.pendingDispatchTodos }}</strong> 条，{{ recon.matched ? '两处一致 ✅' : '不一致 ❌' }}；
      待办明细共 {{ recon.totalTodos }} 条（已复核 {{ recon.reviewedTodos }}）；
      现场巡视待处理隐患 {{ recon.pendingHazards }} 条。
      <span class="muted">口径与明细同源，同时变化。</span>
    </p>

    <!-- 取数面板：模拟汛期遥测，失败展示空态 + 原因 + 重试 -->
    <section class="panel">
      <div class="panel-head">
        <h3>遥测取数 · 当前时段 {{ draft?.slot ?? currentSlot }}</h3>
        <div class="panel-tools">
          <button class="btn" type="button" @click="startFetch(false)">一键取数</button>
          <button class="btn" type="button" @click="startFetch(true)">模拟上游通道故障</button>
          <button class="btn" type="button" @click="simulateLongOutage">模拟中断 70 分钟</button>
          <button class="btn ghost" type="button" @click="restoreOutage">恢复通信</button>
        </div>
      </div>
      <p class="outage-line" :class="outageMin > 0 ? 'bad' : 'ok'">
        通信状态：{{ outageMin > 0 ? `已连续中断 ${outageMin} 分钟` : '链路正常' }}
        <template v-if="outageMin > 60"> · 已超 60 分钟，自动取数提交已锁定，请走人工补测</template>
      </p>
      <div class="channel-grid">
        <div v-for="channel in draft?.channels ?? []" :key="channel.field" class="channel-card" :class="channel.status">
          <div class="channel-name">{{ channel.field }}（{{ unitOf(channel.field) }}）</div>
          <div v-if="channel.status === 'idle'" class="channel-value muted">未取数</div>
          <div v-else-if="channel.status === 'loading'" class="channel-value muted">取数中…</div>
          <div v-else-if="channel.status === 'ok'" class="channel-value real">{{ channel.value }}</div>
          <div v-else class="channel-value empty">
            <div class="empty-title">暂无数据</div>
            <div class="empty-reason">{{ channel.reason }}</div>
          </div>
          <div class="channel-actions">
            <button class="link" type="button" @click="retry(channel.field)">
              {{ channel.status === 'failed' ? '重试取数' : '重新取数' }}
            </button>
          </div>
        </div>
      </div>
      <div class="submit-line">
        <label>
          观测时间
          <input v-model="observedAt" type="datetime-local" />
        </label>
        <label>
          值守人员
          <input v-model="operator" />
        </label>
        <button class="btn primary" type="button" :disabled="outageMin > 60" @click="submitDraft">
          提交观测
        </button>
        <span v-if="message" :class="lastOk ? 'ok-text' : 'error-text'">{{ message }}</span>
      </div>
    </section>

    <!-- 缺测记录的人工补测：中断超 60 分钟后这是唯一合法入口（也可对任意缺测行补测） -->
    <section v-if="manualTarget || outageMin > 60" class="panel warn-panel">
      <div class="panel-head">
        <h3>
          人工补测（先补测，再走调度）<template v-if="manualTarget"> · {{ manualTarget.记录编号 }}（{{ manualTarget.观测时间 }}）</template>
        </h3>
      </div>
      <p v-if="outageMin > 60" class="error-text">遥测已连续中断 {{ outageMin }} 分钟，自动取数提交已锁定。</p>
      <p class="muted">补到哪项就把哪项从缺测清单里摘掉；仍未补到的项继续留空并保留失败原因。</p>
      <div class="manual-grid">
        <label v-for="field in hydroFields" :key="field">
          <span>{{ field }}（{{ unitOf(field) }}）</span>
          <input v-model.number="manualForm[field]" type="number" placeholder="补测值，留空表示仍缺测" />
        </label>
      </div>
      <button class="btn primary" type="button" @click="submitManual">提交补测结果</button>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <!-- 实数表：四项齐全或仅含兜底/回填标注的值 -->
    <h3 class="table-title">实测记录（{{ measuredRows.length }}）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>取值说明</th>
          <th>平衡校验</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in measuredRows" :key="String(row.id)">
          <td>{{ row.记录编号 }}</td>
          <td>{{ row.观测时间 }}</td>
          <td v-for="field in telemetryFields" :key="field" :class="cellOf(row, field).tone">
            {{ cellOf(row, field).text }}
          </td>
          <td>{{ row.值守人员 }}</td>
          <td class="source-cell">
            <span v-for="field in telemetryFields" :key="field" class="src-tag" :class="row.sources[field] ?? ''">
              {{ field.slice(0, 2) }}:{{ row.sources[field] ?? '—' }}
            </span>
          </td>
          <td :class="row.balanceChecked ? (row.balancePassed ? 'ok-text' : 'error-text') : 'muted'">
            {{ balanceText(row) }}
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('提交观测', row)">提交观测</button>
            <button class="link" type="button" @click="runAction('下达调度', row)">下达调度</button>
            <button class="link" type="button" @click="openReview(row)">提交复核</button>
          </td>
        </tr>
        <tr v-if="!measuredRows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            <div class="empty-title">暂无内容</div>
            <div class="empty-reason">当前没有四项齐全的实测记录（缺测记录在下方单列，不混入实数）。</div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 缺测表：空值记录单独列出 -->
    <h3 class="table-title warn">缺测/空值记录（{{ missingRows.length }}，不参与实数统计与流量平衡）</h3>
    <table class="data-table missing-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>缺测项与取数失败原因</th>
          <th>迁移标记</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in missingRows" :key="String(row.id)">
          <td>{{ row.记录编号 }}</td>
          <td>{{ row.观测时间 }}</td>
          <td v-for="field in telemetryFields" :key="field" :class="cellOf(row, field).tone">
            {{ cellOf(row, field).text }}
          </td>
          <td>{{ row.值守人员 }}</td>
          <td class="reason-cell">
            <div v-for="(reason, field) in row.missingReasons" :key="field" class="reason-line">
              <strong>{{ field }}</strong>：{{ reason }}
            </div>
            <div v-if="!Object.keys(row.missingReasons).length" class="muted">—</div>
          </td>
          <td>
            <span v-if="row.legacyZero?.length" class="legacy-tag">迁移识别的随手填零：{{ row.legacyZero.join('、') }}</span>
            <span v-else class="muted">—</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="startManualFor(row)">人工补测本行</button>
            <button class="link" type="button" @click="runAction('提交观测', row)">补测后提交观测</button>
            <button class="link" type="button" @click="runAction('下达调度', row)">下达调度（缺失项兜底）</button>
            <button class="link" type="button" @click="openReview(row)">提交复核</button>
          </td>
        </tr>
        <tr v-if="!missingRows.length">
          <td :colspan="columns.length + 3" class="empty-state">
            <div class="empty-title">暂无内容</div>
            <div class="empty-reason">没有缺测记录；汛期取数失败的项会留空并列在本处，可重试或人工补测。</div>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- 调度建议/复核弹窗区（页面内联，不用第三方弹窗） -->
    <section v-if="adviceTarget" class="panel advice-panel">
      <div class="panel-head">
        <h3>调度建议 · {{ adviceTarget.记录编号 }}（{{ adviceTarget.观测时间 }}）</h3>
        <button class="link" type="button" @click="adviceTarget = null">收起</button>
      </div>
      <p :class="adviceResult?.ok ? 'ok-text' : 'error-text'">{{ adviceResult?.message }}</p>
      <p v-if="adviceResult?.advice" class="advice-text">{{ adviceResult.advice }}</p>
      <p class="muted">{{ adviceResult?.balanceDetail }}</p>
      <button v-if="adviceResult?.ok" class="btn primary" type="button" @click="confirmDispatch">确认下达调度</button>
    </section>

    <section v-if="reviewTarget" class="panel advice-panel">
      <div class="panel-head">
        <h3>复核结论 · {{ reviewTarget.记录编号 }}（{{ reviewTarget.观测时间 }}）</h3>
        <button class="link" type="button" @click="reviewTarget = null">收起</button>
      </div>
      <textarea v-model="reviewConclusion" rows="3" placeholder="复核结论将回写到泄洪操作的调度待办；若存在缺测/不平衡，同时在现场巡视隐患清单开一条隐患" />
      <label class="check-line">
        <input v-model="openHazard" type="checkbox" /> 本次处理结论在现场巡视隐患清单登记/更新一条隐患
      </label>
      <div>
        <button class="btn primary" type="button" @click="confirmReview">提交复核并回写</button>
      </div>
    </section>

    <footer class="page-foot">
      <span>实数 {{ measuredRows.length }} 条，空值记录 {{ missingRows.length }} 条，合计 {{ rows.length }} 条</span>
      <span v-if="message" :class="lastOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import { downloadCsv } from '@/api/local-service'
import {
  FAILURE_REASONS,
  buildDispatchAdvice,
  fetchAll,
  fetchChannel,
  getDraft,
  issueDispatch,
  listHydro,
  listSplitHydro,
  outageMinutes,
  reconcile,
  resetDraft,
  simulateOutage,
  clearOutage,
  submitManualMeasurement,
  submitObservation,
  submitReview,
} from '@/api/hydro-service'
import { HYDRO_FIELDS, checkBalance, displayCell, fieldUnit, nowSlot, slotOf } from '@/data/hydrology'
import { resetRows } from '@/data/local-store'
import type { ChannelState, HydroFieldKey, HydroRecord } from '@/data/types'

const columns = ['记录编号', '观测时间', '上游水位', '下游水位', '入库流量', '出库流量', '值守人员']
const telemetryFields: HydroFieldKey[] = HYDRO_FIELDS.map((item) => item.key)
const hydroFields = telemetryFields

const rows = ref<HydroRecord[]>([])
const measuredRows = ref<HydroRecord[]>([])
const missingRows = ref<HydroRecord[]>([])
const message = ref('')
const lastOk = ref(true)

const draft = ref<{ slot: string; channels: ChannelState[] } | null>(null)
const observedAt = ref(new Date().toISOString().slice(0, 16))
const operator = ref('值班管理员')
const outageMin = ref(0)
const currentSlot = computed(() => slotOf(observedAt.value || new Date().toISOString()))

const adviceTarget = ref<HydroRecord | null>(null)
const adviceResult = ref<ReturnType<typeof buildDispatchAdvice> | null>(null)
const reviewTarget = ref<HydroRecord | null>(null)
const reviewConclusion = ref('')
const openHazard = ref(false)

const manualTarget = ref<HydroRecord | null>(null)
const manualForm = reactive<Record<HydroFieldKey, number | ''>>({
  上游水位: '',
  下游水位: '',
  入库流量: '',
  出库流量: '',
})

const statusSummary = computed(() =>
  ['待观测', '已观测', '已调度', '已复核'].map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

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

const todayStr = new Date().toISOString().slice(0, 10)
const today = computed(() => {
  const todays = rows.value.filter((row) => row.观测时间.slice(0, 10) === todayStr)
  const inflows = todays.map((row) => row.入库流量).filter((v): v is number => v !== null)
  const outflows = todays.map((row) => row.出库流量).filter((v): v is number => v !== null)
  return {
    inflow: inflows.length ? Math.round(inflows.reduce((a, b) => a + b, 0) / inflows.length) : null,
    outflow: outflows.length ? Math.round(outflows.reduce((a, b) => a + b, 0) / outflows.length) : null,
  }
})

function notify(ok: boolean, text: string) {
  lastOk.value = ok
  message.value = text
}

function unitOf(field: HydroFieldKey): string {
  return fieldUnit(field)
}

function cellOf(row: HydroRecord, field: HydroFieldKey) {
  return displayCell(row, field)
}

function balanceText(row: HydroRecord): string {
  if (row.balanceChecked) {
    const b = checkBalance(row)
    return row.balancePassed ? '平衡 ✅' : `${b.detail}`
  }
  return checkBalance(row).detail
}

function refresh() {
  rows.value = listHydro()
  const split = listSplitHydro(rows.value)
  measuredRows.value = split.measured
  missingRows.value = split.missing
  recon.value = reconcile()
  draft.value = getDraft()
  outageMin.value = outageMinutes()
}

function ensureDraft(): { slot: string; channels: ChannelState[] } {
  if (!draft.value) {
    draft.value = resetDraft(slotOf(observedAt.value || new Date().toISOString()))
  }
  return draft.value
}

let timer: ReturnType<typeof setInterval> | null = null

function startFetch(forceFail: boolean) {
  ensureDraft()
  fetchAll(forceFail ? { forceFailFields: ['上游水位', '入库流量'] } : {})
  refresh()
  notify(true, forceFail ? '已模拟上游水位、入库流量通道故障，失败项显示空态与原因，可重试' : '取数完成，失败通道可重试')
}

function retry(field: HydroFieldKey) {
  ensureDraft()
  fetchChannel(field, {})
  refresh()
  notify(true, `${field}重试完成`)
}

function simulateLongOutage() {
  ensureDraft()
  simulateOutage(70)
  // 同时制造一次失败取数，让空态原因可见
  fetchAll({ forceFailFields: ['上游水位', '入库流量'] })
  refresh()
  notify(false, FAILURE_REASONS['上游水位'])
}

function restoreOutage() {
  clearOutage()
  HYDRO_FIELDS.forEach(({ key }) => fetchChannel(key, {}))
  refresh()
  notify(true, '通信已恢复，缺测项重新取数成功')
}

function valuesFromDraft(): { values: Record<HydroFieldKey, number | null>; reasons: Record<HydroFieldKey, string> } {
  const d = ensureDraft()
  const values = {} as Record<HydroFieldKey, number | null>
  const reasons = {} as Record<HydroFieldKey, string>
  for (const channel of d.channels) {
    values[channel.field] = channel.status === 'ok' ? channel.value : null
    if (channel.status === 'failed') reasons[channel.field] = channel.reason
  }
  return { values, reasons }
}

function submitDraft() {
  ensureDraft()
  const { values, reasons } = valuesFromDraft()
  const token = `obs-${Date.now()}`
  const result = submitObservation({
    observedAt: observedAt.value || new Date().toISOString(),
    operator: operator.value,
    values,
    reasons,
    clientToken: token,
  })
  notify(result.ok, result.message)
  if (result.ok) {
    // 落库后取数面板切到下一时段，避免值班员拿旧草稿重复提交。
    draft.value = resetDraft(nowSlot())
  }
  refresh()
}

function startManualFor(row: HydroRecord) {
  manualTarget.value = row
  for (const field of hydroFields) {
    manualForm[field] = row[field] === null ? '' : Number(row[field])
  }
  notify(true, `请补测 ${row.记录编号} 的缺测项：${Object.keys(row.missingReasons).join('、') || '（可修正任意项）'}`)
}

function submitManual() {
  const target = manualTarget.value
  const manualObservedAt = target ? target.观测时间 : (observedAt.value || new Date().toISOString())
  const values = {} as Record<HydroFieldKey, number | null>
  for (const field of hydroFields) {
    values[field] = manualForm[field] === '' ? null : Number(manualForm[field])
  }
  // 仍缺测的项沿用原来的失败原因；新补到的项标人工补测。
  const reasons = { ...(target?.missingReasons ?? {}) } as Record<HydroFieldKey, string>
  const sources = { ...(target?.sources ?? {}) } as Record<HydroFieldKey, '人工补测'>
  for (const field of hydroFields) {
    if (values[field] !== null) {
      sources[field] = '人工补测'
      delete reasons[field]
    } else if (!reasons[field]) {
      reasons[field] = FAILURE_REASONS[field]
    }
  }
  const result = submitManualMeasurement({
    observedAt: manualObservedAt,
    operator: target?.值守人员 || operator.value,
    values,
    reasons,
    sources,
  })
  notify(result.ok, result.message)
  if (result.ok) {
    for (const field of hydroFields) manualForm[field] = ''
    manualTarget.value = null
    clearOutage()
  }
  refresh()
}

function runAction(action: '提交观测' | '下达调度' | '提交复核', row: HydroRecord) {
  if (action === '下达调度') {
    openAdvice(row)
    return
  }
  if (action === '提交复核') {
    openReview(row)
    return
  }
  // 待观测的存量记录允许直接补测提交（迁移回填的记录用人工补测入口语义）
  const values = {
    上游水位: row.上游水位,
    下游水位: row.下游水位,
    入库流量: row.入库流量,
    出库流量: row.出库流量,
  } as Record<HydroFieldKey, number | null>
  const result = submitObservation({
    observedAt: row.观测时间,
    operator: row.值守人员,
    values,
    reasons: row.missingReasons,
    sources: row.sources,
    manual: true,
  })
  notify(result.ok, result.message)
  refresh()
}

function openAdvice(row: HydroRecord) {
  adviceTarget.value = row
  adviceResult.value = buildDispatchAdvice(Number(row.id))
}

function confirmDispatch() {
  if (!adviceTarget.value) return
  const result = issueDispatch(Number(adviceTarget.value.id))
  notify(result.ok, result.message)
  adviceTarget.value = null
  refresh()
}

function openReview(row: HydroRecord) {
  if (row.status !== '已调度') {
    notify(false, `环节不能跳级：提交复核要求记录处于「已调度」，当前为「${row.status}」，请先下达调度`)
    return
  }
  reviewTarget.value = row
  reviewConclusion.value = row.复核结论 ?? ''
  openHazard.value = Object.keys(row.missingReasons).length > 0
}

function confirmReview() {
  if (!reviewTarget.value) return
  const result = submitReview(Number(reviewTarget.value.id), reviewConclusion.value, {
    openHazard: openHazard.value,
  })
  notify(result.ok, result.message)
  if (result.ok) reviewTarget.value = null
  refresh()
}

function exportRows() {
  // 导出与页面同口径：实数、缺测都在，但缺测项导出为「暂无数据（原因）」，绝不导出 0。
  const header = [
    '记录编号', '观测时间', '上游水位', '下游水位', '入库流量', '出库流量',
    '值守人员', '取值方式', '缺测项与原因', '平衡校验', '调度建议', '复核结论', '状态',
  ]
  const lines = [header.join(',')]
  const esc = (v: unknown) => {
    const text = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  for (const row of rows.value) {
    const cell = (field: HydroFieldKey) => (row[field] === null ? `暂无数据（${row.missingReasons[field] ?? '缺测'}）` : String(row[field]))
    const src = telemetryFields.map((f) => `${f}:${row.sources[f] ?? '缺测'}`).join('；')
    const reasons = Object.entries(row.missingReasons).map(([f, r]) => `${f}:${r}`).join('；')
    const balance = row.balanceChecked ? (row.balancePassed ? '平衡' : '不平衡') : '空值未参与校验'
    lines.push([
      row.记录编号, row.观测时间, cell('上游水位'), cell('下游水位'), cell('入库流量'), cell('出库流量'),
      esc(row.值守人员), esc(src), esc(reasons), balance, esc(row.调度建议), esc(row.复核结论), row.status,
    ].join(','))
  }
  downloadCsv('水情调度-清单.csv', `﻿${lines.join('\n')}`)
  notify(true, `已导出 ${rows.value.length} 条（实数 ${measuredRows.value.length}、空值 ${missingRows.value.length}），与页面条数一致`)
}

function resetHydro() {
  resetRows('hydrology')
  refresh()
  notify(true, '水情记录已重置为示例数据')
}

onMounted(() => {
  void nowSlot
  resetDraft(currentSlot.value)
  refresh()
  // 中断计时是实时时钟，页面上每 20 秒刷新一次分钟数。
  timer = setInterval(() => {
    outageMin.value = outageMinutes()
  }, 20000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped>
.hydro-page .muted { color: #64748b; }
.ok-text { color: #15803d; }
.reconcile-bar { font-size: 13px; padding: 8px 12px; border-radius: 6px; margin: 0 0 12px; }
.reconcile-bar.ok { background: #ecfdf3; color: #15803d; border: 1px solid #abefc6; }
.reconcile-bar.bad { background: #fef3f2; color: #b42318; border: 1px solid #fda29b; }
.panel { background: #fff; border: 1px solid #d8dee6; border-radius: 8px; padding: 12px 14px; margin-bottom: 14px; }
.panel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.panel-head h3 { margin: 0; font-size: 15px; }
.panel-tools { display: flex; gap: 8px; }
.outage-line { font-size: 13px; margin: 4px 0 10px; }
.outage-line.ok { color: #15803d; }
.outage-line.bad { color: #b42318; font-weight: 600; }
.channel-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.channel-card { border: 1px solid #d8dee6; border-radius: 6px; padding: 10px; }
.channel-card.failed { border-color: #fda29b; background: #fef3f2; }
.channel-card.ok { border-color: #abefc6; background: #f6fef9; }
.channel-name { font-size: 12px; color: #475467; margin-bottom: 6px; }
.channel-value { font-size: 18px; font-weight: 600; }
.channel-value.real { color: #15803d; }
.channel-value.empty { color: #b42318; font-size: 13px; font-weight: 400; }
.empty-title { font-weight: 700; }
.empty-reason { font-size: 12px; color: #b42318; margin-top: 2px; }
.channel-card.ok .empty-reason { color: inherit; }
.channel-actions { margin-top: 6px; }
.submit-line { display: flex; gap: 12px; align-items: flex-end; margin-top: 12px; flex-wrap: wrap; }
.submit-line label span, .manual-grid span { display: block; font-size: 12px; color: #64748b; }
.submit-line input, .manual-grid input, textarea { border: 1px solid #d8dee6; border-radius: 6px; padding: 6px 8px; }
.warn-panel { border-color: #fda29b; background: #fffcf9; }
.manual-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px; }
.table-title { font-size: 14px; margin: 16px 0 8px; }
.table-title.warn { color: #b42318; }
.missing-table { border-color: #fda29b; }
td.empty { color: #b42318; }
td.fallback { color: #b54708; }
td.legacy { color: #7c3aed; }
.source-cell { max-width: 260px; }
.src-tag { display: inline-block; font-size: 11px; background: #eef2f7; border-radius: 4px; padding: 1px 6px; margin: 1px; }
.src-tag.兜底 { background: #fffaeb; color: #b54708; }
.src-tag.人工补测 { background: #eff8ff; color: #175cd3; }
.src-tag.迁移回填 { background: #f4f3ff; color: #6941c6; }
.reason-cell { min-width: 260px; }
.reason-line { font-size: 12px; color: #b42318; margin-bottom: 2px; }
.legacy-tag { font-size: 12px; color: #7c3aed; }
.advice-panel { border-color: #1f6feb; }
.advice-text { font-size: 14px; }
.check-line { display: block; font-size: 13px; margin: 8px 0; }
textarea { width: 100%; margin: 6px 0; }
</style>
