<template>
  <section class="page" data-module="hydrology">
    <header class="page-head">
      <div>
        <h2>水情调度管理</h2>
        <p class="page-desc">
          取不到的量测项留空并注明原因（区别于真实 0）；连续中断超 1 小时须先补测；
          空值不参与流量平衡；同时段重复上报按观测时间覆盖。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水情记录</button>
        <button class="btn" type="button" @click="doExport">导出明细（与页面条数一致）</button>
        <button class="btn" type="button" @click="showMigration = true">存量迁移缺失清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">今日入库流量合计（空值不参与）</span>
        <strong class="stat-value">{{ view.stats.todayInflow ?? '暂无数据' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">今日出库流量合计（空值不参与）</span>
        <strong class="stat-value">{{ view.stats.todayOutflow ?? '暂无数据' }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待调度记录（与泄洪页同源）</span>
        <strong class="stat-value">{{ view.stats.pendingDispatch }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">含缺测记录 / 真实零 / 用过兜底</span>
        <strong class="stat-value">{{ view.stats.missingRecords }} / {{ view.stats.realZeroCount }} / {{ view.stats.fallbackUsedCount }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>记录编号 / 值守人员 / 观测时间</span>
        <input v-model="filters.keyword" placeholder="按关键字检索" />
      </label>
      <label class="filter-item" style="flex-direction: row; align-items: center; gap: 6px;">
        <input v-model="filters.onlyMissing" type="checkbox" />
        <span>只看含缺测的记录</span>
      </label>
      <button class="btn" type="submit">查询</button>
    </form>

    <h3 class="section-title">
      实数记录（{{ view.complete.length }} 条）
      <span class="hint">四个量测项全部为实数，真实 0 标注「真实零」</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>记录编号</th><th>观测时间</th>
          <th v-for="k in measureKeys" :key="k">{{ k }}</th>
          <th>值守人员</th><th>状态</th><th>调度建议 / 平衡校验</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in view.complete" :key="row.id">
          <td>{{ row.记录编号 }}</td>
          <td>{{ formatTime(row.观测时间) }}</td>
          <td v-for="k in measureKeys" :key="k">
            <span :class="{ 'real-zero': row[k].realZero }">{{ cell(row[k]).text }}</span>
          </td>
          <td>{{ row.值守人员 }}</td>
          <td>{{ row.status }}</td>
          <td style="max-width: 300px;">
            <div v-if="row.dispatchNote" class="notice-box" style="margin: 0; white-space: pre-line;">
              {{ row.dispatchNote.balanceText }}
            </div>
            <span v-else class="null-badge">提交观测后生成</span>
          </td>
          <td class="row-actions" style="flex-direction: column; align-items: flex-start;">
            <template v-for="act in nextActions(row.status)" :key="act.key">
              <button class="link" type="button" :title="act.reason" :disabled="!act.enabled" @click="onAction(act.key, row)">
                {{ act.label }}
              </button>
            </template>
            <button class="link" type="button" @click="openRemeasure(row)">人工补测</button>
          </td>
        </tr>
        <tr v-if="!view.complete.length">
          <td :colspan="measureKeys.length + 5" class="empty-state">暂无实数记录</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">
      空值记录（{{ view.incomplete.length }} 条）
      <span class="hint">取不到的项留空并显示「暂无数据 + 失败原因」，不与实数混排</span>
    </h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>记录编号</th><th>观测时间</th>
          <th v-for="k in measureKeys" :key="k">{{ k }}</th>
          <th>值守人员</th><th>状态</th><th>缺测与兜底说明</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in view.incomplete" :key="row.id">
          <td>{{ row.记录编号 }}</td>
          <td>{{ formatTime(row.观测时间) }}</td>
          <td v-for="k in measureKeys" :key="k">
            <template v-if="cell(row[k]).missing">
              <span class="null-badge">暂无数据</span>
              <span class="reason-text">{{ reasonText(row[k].reason) }}</span>
              <span v-if="interruptMinutes(row.channels[k]) > 0" class="reason-text">
                已连续中断 {{ interruptMinutes(row.channels[k]) }} 分钟
                <template v-if="interruptOverOneHour(row.channels[k])">（超 1 小时，须补测）</template>
              </span>
            </template>
            <span v-else :class="{ 'real-zero': row[k].realZero }">{{ cell(row[k]).text }}</span>
          </td>
          <td>{{ row.值守人员 }}</td>
          <td>{{ row.status }}</td>
          <td style="max-width: 320px;">
            <div v-if="row.dispatchNote" class="notice-box" style="margin: 0; white-space: pre-line;">
              {{ row.dispatchNote.text }}
              {{ row.dispatchNote.balanceText }}
            </div>
            <span v-else class="null-badge">提交观测后生成调度建议</span>
            <div v-if="row.review" class="success-box" style="margin: 4px 0 0;">
              复核：{{ row.review.result }}（{{ row.review.reviewer }}）→ 待办 #{{ row.review.writtenTodoIds.join('、#') }}
            </div>
          </td>
          <td class="row-actions" style="flex-direction: column; align-items: flex-start;">
            <template v-for="act in nextActions(row.status)" :key="act.key">
              <button class="link" type="button" :title="act.reason" :disabled="!act.enabled" @click="onAction(act.key, row)">
                {{ act.label }}
              </button>
            </template>
            <button class="link" type="button" @click="openRemeasure(row)">人工补测</button>
          </td>
        </tr>
        <tr v-if="!view.incomplete.length">
          <td :colspan="measureKeys.length + 5" class="empty-state">暂无空值记录，本时段量测项齐全</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ view.all.length }} 条水情记录（实数 {{ view.complete.length }} / 空值 {{ view.incomplete.length }}）</span>
      <span v-if="message" :class="messageOk ? 'success-box' : 'error-text'" style="padding: 2px 8px;">{{ message }}</span>
    </footer>

    <!-- 登记水情记录（取数模拟 + 一小时中断拦截） -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <h3>登记水情记录</h3>
        <div class="form-grid">
          <div class="form-field">
            <label>观测时间（精确到分钟，同时段重复上报将覆盖）</label>
            <input v-model="form.observedAt" type="datetime-local" />
          </div>
          <div class="form-field">
            <label>值守人员</label>
            <input v-model="form.operator" placeholder="值班员姓名" />
          </div>
        </div>

        <div style="margin: 12px 0 6px; font-size: 13px; color: var(--muted);">
          量测项取数：点「取数」模拟遥测；取不到请「重试」，仍取不到则保留空值并选择原因。
          连续中断超过 1 小时仍为空的项不允许提交，须人工补测。
        </div>

        <div v-for="key in measureKeys" :key="key" class="measure-row" :class="{ blocked: blockedFields.includes(key) }">
          <div class="measure-head">
            <span class="measure-name">{{ key }}</span>
            <span>
              <button class="btn tiny" type="button" @click="simulateFetch(key)">取数</button>
              <button class="btn tiny" type="button" @click="simulateFetch(key, true)">重试</button>
              <button class="btn tiny danger" type="button" @click="forceOffline(key)">模拟该测站长时间离线</button>
            </span>
          </div>
          <div class="measure-body">
            <label>取值：
              <input
                :value="form.measures[key].value ?? ''"
                type="number"
                style="width: 110px;"
                placeholder="空=暂无数据"
                @input="onValueInput(key, ($event.target as HTMLInputElement).value)"
              />
            </label>
            <label v-if="form.measures[key].value === 0">
              <input type="checkbox" :checked="form.measures[key].realZero" @change="toggleRealZero(key, ($event.target as HTMLInputElement).checked)" />
              确认真实零（不勾则 0 按空值处理）
            </label>
            <label v-if="form.measures[key].value === null">缺测原因：
              <select v-model="form.measures[key].reason">
                <option value="sensor_timeout">遥测采集超时</option>
                <option value="sensor_offline">测站设备离线</option>
                <option value="link_interrupt">通信链路中断</option>
                <option value="value_unreliable">回传值失真弃用</option>
              </select>
            </label>
            <span v-if="form.channels[key].failingSince" class="fetch-fail">
              通道中断 {{ interruptMinutes(form.channels[key]) }} 分钟
              <template v-if="interruptOverOneHour(form.channels[key])">（已超 1 小时，禁止提交）</template>
            </span>
            <span v-else-if="form.measures[key].value !== null" class="fetch-ok">取数正常</span>
          </div>
        </div>

        <div v-if="formNotice" :class="formOk ? 'success-box' : 'blocked-box'">{{ formNotice }}</div>

        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
          <button class="btn" type="button" @click="validateOnly">校验一小时规则</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitForm">
            {{ submitting ? '提交中…' : '提交观测' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 人工补测 -->
    <div v-if="remeasureTarget" class="modal-mask" @click.self="remeasureTarget = null">
      <div class="modal" style="width: 560px;">
        <h3>人工补测 — {{ remeasureTarget.记录编号 }}</h3>
        <p class="page-desc">补测成功后清除通道连续中断计时，空值改为实测实数。</p>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>补测项目</label>
          <select v-model="remeasureField">
            <option v-for="key in missingOf(remeasureTarget)" :key="key" :value="key">{{ key }}（{{ reasonText(remeasureTarget[key].reason) }}）</option>
          </select>
        </div>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>实测值</label>
          <input v-model.number="remeasureValue" type="number" />
        </div>
        <label v-if="remeasureValue === 0">
          <input v-model="remeasureRealZero" type="checkbox" /> 确认真实零
        </label>
        <div v-if="remeasureMsg" :class="remeasureOk ? 'success-box' : 'error-text'">{{ remeasureMsg }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="remeasureTarget = null">关闭</button>
          <button class="btn primary" type="button" @click="confirmRemeasure">确认补测</button>
        </div>
      </div>
    </div>

    <!-- 复核回写 -->
    <div v-if="reviewTarget" class="modal-mask" @click.self="reviewTarget = null">
      <div class="modal" style="width: 560px;">
        <h3>提交复核 — {{ reviewTarget.记录编号 }}</h3>
        <p class="page-desc">复核结论将回写到泄洪操作的调度待办，两边待调度条数同口径。</p>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>回写到哪条泄洪操作</label>
          <select v-model="reviewFloodId">
            <option v-for="f in floodRows" :key="f.id" :value="f.id">
              {{ f.操作编号 }}（{{ f.泄洪闸号 }} / {{ f.status }}）
            </option>
          </select>
        </div>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>复核结论</label>
          <select v-model="reviewResult">
            <option value="通过">通过</option>
            <option value="有条件通过">有条件通过</option>
            <option value="不通过">不通过</option>
          </select>
        </div>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>复核意见</label>
          <textarea v-model="reviewOpinion" rows="3"></textarea>
        </div>
        <div class="form-field" style="margin-bottom: 10px;">
          <label>复核人</label>
          <input v-model="reviewer" placeholder="复核人姓名" />
        </div>
        <div v-if="reviewMsg" class="error-text">{{ reviewMsg }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="reviewTarget = null">取消</button>
          <button class="btn primary" type="button" @click="confirmReview">提交并回写调度待办</button>
        </div>
      </div>
    </div>

    <!-- 存量迁移缺失清单 -->
    <div v-if="showMigration" class="modal-mask" @click.self="showMigration = false">
      <div class="modal">
        <h3>存量迁移：缺失字段清单</h3>
        <div class="notice-box">
          迁移顺序：水情记录 → 泄洪操作 → 缺陷处置（隐患清单随缺陷建立）；各模块按业务日期升序回填。
          水情裸 0 一律按「缺数写成 0」识别为空，原值保留；无法解析的脏值同样置空。缺失字段单独罗列，导出条数与本弹窗一致。
        </div>
        <table class="data-table">
          <thead><tr><th>模块</th><th>记录编号</th><th>业务日期</th><th>问题</th><th>缺失字段</th></tr></thead>
          <tbody>
            <tr v-for="(issue, idx) in migrationIssues" :key="idx">
              <td>{{ moduleName(issue.module) }}</td>
              <td>{{ issue.recordNo }}</td>
              <td>{{ issue.businessDate }}</td>
              <td>{{ issueKindText(issue.kind) }}</td>
              <td>{{ issue.fields.join('、') }}</td>
            </tr>
            <tr v-if="!migrationIssues.length"><td colspan="5" class="empty-state">迁移无缺失项</td></tr>
          </tbody>
        </table>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="showMigration = false">关闭</button>
          <button class="btn" type="button" @click="exportIssues">导出缺失清单（{{ migrationIssues.length }} 条）</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { exportHydrology, exportMigrationIssues, hydrologyView, migrationView } from '@/domain/views'
import { loadState, updateState } from '@/domain/store'
import {
  advanceHydrology,
  applyRemeasure,
  blockedByInterrupt,
  buildDispatchNote,
  interruptMinutes,
  interruptOverOneHour,
  measureDisplay,
  reasonText,
  submitObservation,
  submitReview,
} from '@/domain/hydrology-service'
import type { ChannelState, FetchReason, HydrologyRecord, HydStatus, MeasureKey } from '@/domain/types'
import type { MeasureInput } from '@/domain/hydrology-service'
import { MEASURE_KEYS } from '@/domain/types'

const measureKeys = MEASURE_KEYS
const statuses: HydStatus[] = ['待观测', '已观测', '已调度', '已复核']

const view = ref(hydrologyView({ keyword: '', onlyMissing: false }))
const filters = reactive({ keyword: '', onlyMissing: false })
const message = ref('')
const messageOk = ref(false)

const showCreate = ref(false)
const showMigration = ref(false)
const submitting = ref(false)
const formNotice = ref('')
const formOk = ref(false)

type FormMeasure = { value: number | null; reason: FetchReason; realZero: boolean }
const emptyChannels = (): Record<MeasureKey, ChannelState> => ({
  上游水位: { failingSince: null, lastReason: null },
  下游水位: { failingSince: null, lastReason: null },
  入库流量: { failingSince: null, lastReason: null },
  出库流量: { failingSince: null, lastReason: null },
})
const emptyFormMeasures = (): Record<MeasureKey, FormMeasure> => ({
  上游水位: { value: null, reason: 'sensor_timeout', realZero: false },
  下游水位: { value: null, reason: 'sensor_timeout', realZero: false },
  入库流量: { value: null, reason: 'sensor_timeout', realZero: false },
  出库流量: { value: null, reason: 'sensor_timeout', realZero: false },
})

const nowDefault = () => {
  const d = new Date()
  d.setSeconds(0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const form = reactive({
  observedAt: nowDefault(),
  operator: '',
  measures: emptyFormMeasures(),
  channels: emptyChannels(),
  clientToken: '',
})

const blockedFields = computed(() =>
  blockedByInterrupt(
    Object.fromEntries(
      MEASURE_KEYS.map((k) => [k, { value: form.measures[k].value, reason: form.measures[k].reason }]),
    ) as Record<MeasureKey, MeasureInput>,
    form.channels,
  ),
)

const remeasureTarget = ref<HydrologyRecord | null>(null)
const remeasureField = ref<MeasureKey>('上游水位')
const remeasureValue = ref<number | null>(null)
const remeasureRealZero = ref(false)
const remeasureMsg = ref('')
const remeasureOk = ref(false)

const reviewTarget = ref<HydrologyRecord | null>(null)
const reviewFloodId = ref<number | null>(null)
const reviewResult = ref<'通过' | '有条件通过' | '不通过'>('通过')
const reviewOpinion = ref('')
const reviewer = ref('')
const reviewMsg = ref('')

const floodRows = computed(() => loadState().flood)
const migrationIssues = ref(migrationView())

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: view.value.all.filter((r) => r.status === status).length })),
)

function reload() {
  view.value = hydrologyView({ keyword: filters.keyword, onlyMissing: filters.onlyMissing })
  migrationIssues.value = migrationView()
}
onMounted(reload)

function formatTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}
function cell(v: HydrologyRecord[MeasureKey]) {
  return measureDisplay(v)
}
function missingOf(row: HydrologyRecord): MeasureKey[] {
  return MEASURE_KEYS.filter((k) => row[k].value === null)
}

function nextActions(status: HydStatus) {
  // 顺序闸门：只有当前状态的下一步可点，其余置灰并说明缺哪一步
  const idx = statuses.indexOf(status)
  const defs: { key: 'observe' | 'dispatch' | 'review'; label: string; step: HydStatus }[] = [
    { key: 'observe', label: '提交观测', step: '已观测' },
    { key: 'dispatch', label: '下达调度', step: '已调度' },
    { key: 'review', label: '提交复核', step: '已复核' },
  ]
  return defs.map((d, i) => {
    if (idx === statuses.length - 1) {
      return { ...d, enabled: false, reason: '已到终态「已复核」' }
    }
    const enabled = i === idx
    return {
      ...d,
      enabled,
      reason: enabled ? '' : `顺序未到：需先完成 ${statuses.slice(idx + 1, i + 1).join('、') || status}`,
    }
  })
}

function flash(text: string, ok = true) {
  message.value = text
  messageOk.value = ok
}

function onAction(key: 'observe' | 'dispatch' | 'review', row: HydrologyRecord) {
  if (key === 'observe') {
    // 一小时中断拦截在服务层统一执行；拦截时提示先人工补测
    const res = advanceHydrology(row.id, '已观测')
    flash(res.message, res.ok)
    if (res.ok) {
      // 为该记录补算调度建议（兜底 + 平衡）
      const state = loadState()
      const fresh = state.hydrology.find((r) => r.id === row.id)
      if (fresh && !fresh.dispatchNote) {
        const note = buildDispatchNote(fresh, state.hydrology)
        saveNote(row.id, note)
      }
    }
  } else if (key === 'dispatch') {
    const res = advanceHydrology(row.id, '已调度')
    flash(res.message, res.ok)
  } else {
    openReview(row)
  }
  reload()
}

function saveNote(id: number, note: HydrologyRecord['dispatchNote']) {
  updateState((draft) => {
    const row = draft.hydrology.find((r) => r.id === id)
    if (row) row.dispatchNote = note
  })
}

/* ---------- 登记弹窗 ---------- */

function resetForm() {
  form.observedAt = nowDefault()
  form.operator = ''
  form.measures = emptyFormMeasures()
  form.channels = emptyChannels()
  form.clientToken = `tok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  formNotice.value = ''
}

function openCreate() {
  resetForm()
  showCreate.value = true
}

function onValueInput(key: MeasureKey, raw: string) {
  if (raw === '') {
    form.measures[key].value = null
    form.measures[key].realZero = false
    // 手动清空视同取不到：通道从现在开始计中断
    if (!form.channels[key].failingSince) {
      form.channels[key].failingSince = new Date().toISOString()
      form.channels[key].lastReason = form.measures[key].reason
    }
    return
  }
  const num = Number(raw)
  form.measures[key].value = Number.isFinite(num) ? num : null
  form.channels[key].failingSince = null
  form.channels[key].lastReason = null
}

function toggleRealZero(key: MeasureKey, checked: boolean) {
  form.measures[key].realZero = checked
}

// 取数模拟：默认约 70% 成功；forceFail=true 时必失败（演示用）
function simulateFetch(key: MeasureKey, isRetry = false, forceFail = false) {
  const failed = forceFail || Math.random() < (isRetry ? 0.25 : 0.3)
  if (failed) {
    const reasons: FetchReason[] = ['sensor_timeout', 'sensor_offline', 'link_interrupt', 'value_unreliable']
    const reason = reasons[Math.floor(Math.random() * reasons.length)]
    form.measures[key].value = null
    form.measures[key].reason = reason
    if (!form.channels[key].failingSince) {
      form.channels[key].failingSince = new Date().toISOString()
    }
    form.channels[key].lastReason = reason
  } else {
    const base = { 上游水位: 246.5, 下游水位: 211.8, 入库流量: 1500, 出库流量: 1480 }[key]
    const jitter = key === '上游水位' || key === '下游水位'
      ? Math.round((Math.random() - 0.5) * 40) / 100
      : Math.round((Math.random() - 0.5) * 60)
    form.measures[key].value = Math.round((base + jitter) * 100) / 100
    form.measures[key].realZero = false
    form.channels[key].failingSince = null
    form.channels[key].lastReason = null
  }
}

// 演示「连续中断超过 1 小时」：把失败时间拨到 95 分钟前
function forceOffline(key: MeasureKey) {
  form.measures[key].value = null
  form.measures[key].reason = 'sensor_offline'
  form.channels[key].failingSince = new Date(Date.now() - 95 * 60_000).toISOString()
  form.channels[key].lastReason = 'sensor_offline'
}

function validateOnly() {
  const blocked = blockedFields.value
  if (blocked.length) {
    formNotice.value = `以下量测项连续中断超过 1 小时仍为空：${blocked.join('、')}。提交将被拦截，请先人工补测。`
    formOk.value = false
  } else {
    formNotice.value = '校验通过：没有超 1 小时未补测的缺项，可以提交（空值会保留并注明原因）。'
    formOk.value = true
  }
}

function submitForm() {
  formNotice.value = ''
  if (!form.observedAt) {
    formNotice.value = '请选择观测时间'
    formOk.value = false
    return
  }
  if (!form.operator.trim()) {
    formNotice.value = '请填写值守人员'
    formOk.value = false
    return
  }
  submitting.value = true
  const outcome = submitObservation({
    observedAt: new Date(form.observedAt).toISOString(),
    operator: form.operator.trim(),
    measures: Object.fromEntries(
      MEASURE_KEYS.map((k) => [
        k,
        {
          value: form.measures[k].value,
          reason: form.measures[k].reason,
          realZero: form.measures[k].realZero,
        },
      ]),
    ) as Record<MeasureKey, MeasureInput>,
    channels: JSON.parse(JSON.stringify(form.channels)),
    clientToken: form.clientToken,
  })
  submitting.value = false
  formOk.value = outcome.ok
  formNotice.value = outcome.message
  if (outcome.ok) {
    reload()
    setTimeout(() => {
      showCreate.value = false
    }, 900)
  }
}

/* ---------- 人工补测 ---------- */

function openRemeasure(row: HydrologyRecord) {
  const miss = missingOf(row)
  remeasureTarget.value = row
  remeasureField.value = miss[0] ?? '上游水位'
  remeasureValue.value = null
  remeasureRealZero.value = false
  remeasureMsg.value = ''
}

function confirmRemeasure() {
  if (!remeasureTarget.value || remeasureValue.value === null || Number.isNaN(remeasureValue.value)) {
    remeasureMsg.value = '请填写实测值'
    remeasureOk.value = false
    return
  }
  const res = applyRemeasure(
    remeasureTarget.value.id,
    remeasureField.value,
    remeasureValue.value,
    remeasureRealZero.value,
  )
  remeasureMsg.value = res.message
  remeasureOk.value = res.ok
  if (res.ok) reload()
}

/* ---------- 复核回写 ---------- */

function openReview(row: HydrologyRecord) {
  if (row.status !== '已调度') {
    flash(`顺序未到：当前「${row.status}」，须先下达调度才能提交复核。`, false)
    return
  }
  reviewTarget.value = row
  reviewFloodId.value = floodRows.value.find((f) => f.status !== '已结束')?.id ?? floodRows.value[0]?.id ?? null
  reviewResult.value = '通过'
  reviewOpinion.value = ''
  reviewer.value = ''
  reviewMsg.value = ''
}

function confirmReview() {
  if (!reviewTarget.value) return
  const res = submitReview(reviewTarget.value.id, {
    result: reviewResult.value,
    opinion: reviewOpinion.value,
    reviewer: reviewer.value,
    floodRecordId: reviewFloodId.value,
  })
  reviewMsg.value = res.message
  if (res.ok) {
    reload()
    setTimeout(() => {
      reviewTarget.value = null
    }, 800)
  }
}

/* ---------- 导出 / 迁移 ---------- */

function doExport() {
  exportHydrology(view.value)
  flash(`已导出 ${view.value.all.length} 条明细（与当前页面条数一致）`)
}

function exportIssues() {
  exportMigrationIssues(migrationIssues.value)
}

function moduleName(key: string): string {
  return { hydrology: '水情记录', flood: '泄洪操作', defect: '缺陷处置' }[key] ?? key
}
function issueKindText(kind: string): string {
  return {
    legacy_zero: '裸 0 识别为缺数',
    legacy_unparsable: '脏值无法解析',
    missing_fields: '字段缺失',
  }[kind] ?? kind
}
</script>
