/**
 * 水情记录业务规则（全部在这一处，页面只负责渲染与取数模拟）：
 *
 * 1. 取不到的量测项留空（value=null + reason），绝不写 0；真实的 0 必须显式确认真实零。
 * 2. 某量测项通道连续中断超过 1 小时且仍为空 → 禁止提交观测，先人工补测。
 * 3. 流量平衡校验只让实数参与：入库/出库任一为空就不出平衡差，只说明哪些项缺失。
 * 4. 调度建议兜底：上游水位或入库流量缺失时，取观测时间更早的最近一时段实数兜底，
 *    结果标注 fallback=true 并记录来源记录编号；找不到前值则不给兜底值，要求补测。
 * 5. 同一观测时间（精确到分钟）重复上报只保留最后一次，按观测时间覆盖旧值；
 *    clientToken 保证重试提交幂等——上一次已落库就直接回放，不重复登记。
 * 6. 复核结论回写到泄洪操作的调度待办（DispatchTodo），两边待调度条数同源统计。
 * 7. 环节只能顺序推进：待观测→已观测→已调度→已复核，跳级直接拦下并说明缺哪一步。
 */
import { loadState, updateState } from './store'
import type {
  ChannelState,
  DispatchNote,
  DispatchTodo,
  FetchReason,
  HydrologyRecord,
  HydStatus,
  HydValue,
  MeasureKey,
  ReviewConclusion,
  SubmitOutcome,
} from './types'
import { MEASURE_KEYS, REASON_TEXT } from './types'

export const HYDROLOGY_FLOW: HydStatus[] = ['待观测', '已观测', '已调度', '已复核']
const INTERRUPT_LIMIT_MS = 60 * 60 * 1000

// 允许的偏差阈值（m³/s）：入库与出库差超过该值给出不平衡提示，但空值不参与。
const BALANCE_TOLERANCE = 50

export type MeasureInput = {
  value: number | null
  reason?: FetchReason | null
  /** 显式确认这是真实的零（UI 勾选），未勾选时 value=0 会被拒绝，防止随手填 0。 */
  realZero?: boolean
}

export type SubmitObservationInput = {
  observedAt: string
  operator: string
  measures: Record<MeasureKey, MeasureInput>
  /** 各通道当前连续中断状态（由页面的取数模拟器维护）。 */
  channels: Record<MeasureKey, ChannelState>
  /** 提交令牌：同令牌重试直接回放已落库结果。 */
  clientToken: string
  recordNo?: string
}

export function reasonText(reason: FetchReason | null): string {
  return reason ? REASON_TEXT[reason] : ''
}

export function isMissing(v: HydValue): boolean {
  return v.value === null
}

/** 连续中断是否已超过一小时（取不到数且通道失败时间已知）。 */
export function interruptOverOneHour(channel: ChannelState, now: number = Date.now()): boolean {
  if (!channel.failingSince) return false
  const t = Date.parse(channel.failingSince)
  return Number.isFinite(t) && now - t > INTERRUPT_LIMIT_MS
}

export function interruptMinutes(channel: ChannelState, now: number = Date.now()): number {
  if (!channel.failingSince) return 0
  const t = Date.parse(channel.failingSince)
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60000)) : 0
}

function emptyValue(reason: FetchReason | null): HydValue {
  return { value: null, reason: reason ?? 'sensor_timeout', realZero: false, fallback: false, fallbackFrom: null }
}

function toHydValue(input: MeasureInput): HydValue {
  if (input.value === null || input.value === undefined || Number.isNaN(input.value)) {
    return { ...emptyValue(input.reason ?? null), legacyRaw: null }
  }
  if (input.value === 0 && !input.realZero) {
    // 随手填 0 与「取不到」必须分开：未显式确认真实零的 0 一律不接受
    return emptyValue('sensor_timeout')
  }
  return {
    value: input.value,
    reason: null,
    realZero: input.value === 0 && Boolean(input.realZero),
    fallback: false,
    fallbackFrom: null,
  }
}

function sameSlotKey(observedAt: string): string {
  const t = Date.parse(observedAt)
  if (!Number.isFinite(t)) return observedAt
  // 精确到分钟作为「同一时段」业务键
  return new Date(t - (t % 60000)).toISOString()
}

/** 取观测时间更早的最近一条实数记录（用于兜底）。 */
function findFallbackSource(
  rows: HydrologyRecord[],
  observedAt: string,
  field: MeasureKey,
): HydrologyRecord | null {
  const target = Date.parse(observedAt)
  const candidates = rows
    .filter((r) => {
      const t = Date.parse(r.观测时间)
      return Number.isFinite(t) && t < target && r[field].value !== null
    })
    .sort((a, b) => Date.parse(b.观测时间) - Date.parse(a.观测时间))
  return candidates[0] ?? null
}

/**
 * 生成调度建议：上游水位/入库流量缺失时按前一时段兜底；
 * 流量平衡只统计实数，缺项明确列出。
 */
export function buildDispatchNote(record: HydrologyRecord, all: HydrologyRecord[]): DispatchNote {
  const fallbackFields: MeasureKey[] = []
  const lines: string[] = []

  // 兜底不改动观测原值，只在调度建议里给出带标记的建议值
  for (const field of ['上游水位', '入库流量'] as MeasureKey[]) {
    if (isMissing(record[field])) {
      const source = findFallbackSource(all, record.观测时间, field)
      if (source && source[field].value !== null) {
        fallbackFields.push(field)
        lines.push(
          `${field}本次缺测（${reasonText(record[field].reason)}），调度建议按前一时段兜底取值 ${source[field].value}` +
            `（兜底值，来源 ${source.记录编号} @ ${source.观测时间}），补测后以实测为准。`,
        )
      } else {
        lines.push(`${field}本次缺测且找不到前一时段实数兜底，必须先补测再调度。`)
      }
    }
  }
  for (const field of ['下游水位', '出库流量'] as MeasureKey[]) {
    if (isMissing(record[field])) {
      lines.push(`${field}本次缺测（${reasonText(record[field].reason)}），不做兜底，按空值参与统计。`)
    }
  }

  const inflow = record.入库流量.value
  const outflow = record.出库流量.value
  let balanceGap: number | null = null
  let balanceText: string
  if (inflow === null || outflow === null) {
    const miss = [inflow === null ? '入库流量' : null, outflow === null ? '出库流量' : null]
      .filter(Boolean)
      .join('、')
    balanceText = `流量平衡校验未执行：${miss}缺测，空值不参与平衡校验。`
  } else {
    balanceGap = Math.round((inflow - outflow) * 100) / 100
    balanceText =
      Math.abs(balanceGap) <= BALANCE_TOLERANCE
        ? `流量平衡：入库 ${inflow} − 出库 ${outflow} = ${balanceGap} m³/s，偏差在阈值 ±${BALANCE_TOLERANCE} 内。`
        : `流量平衡预警：入库 ${inflow} − 出库 ${outflow} = ${balanceGap} m³/s，超过阈值 ±${BALANCE_TOLERANCE}，请核对。`
  }

  return {
    text: lines.length ? lines.join('\n') : '四个量测项均为实数，无需兜底。',
    balanceGap,
    balanceText,
    fallbackFields,
  }
}

/** 连续中断超过 1 小时仍缺测的量测项（提交拦截口径）。 */
export function blockedByInterrupt(
  measures: Record<MeasureKey, MeasureInput>,
  channels: Record<MeasureKey, ChannelState>,
  now: number = Date.now(),
): MeasureKey[] {
  const blocked: MeasureKey[] = []
  for (const key of MEASURE_KEYS) {
    const input = measures[key]
    const empty = input.value === null || input.value === undefined || Number.isNaN(input.value)
    if (empty && interruptOverOneHour(channels[key], now)) {
      blocked.push(key)
    }
  }
  return blocked
}

function nextRecordNo(rows: HydrologyRecord[]): string {
  const max = rows.reduce((acc, r) => {
    const m = /HYDR-(\d+)/.exec(r.记录编号)
    return m ? Math.max(acc, Number(m[1])) : acc
  }, 0)
  return `HYDR-${String(max + 1).padStart(4, '0')}`
}

function summarizeMeasures(measures: Record<MeasureKey, MeasureInput>): string {
  return MEASURE_KEYS.map((k) => {
    const v = measures[k]
    return `${k}:${v.value === null || v.value === undefined ? '空' : v.value}`
  }).join('，')
}

/** 提交观测（含中断拦截、同时段覆盖、提交令牌幂等）。 */
export function submitObservation(
  input: SubmitObservationInput,
  now: number = Date.now(),
): SubmitOutcome<HydrologyRecord> {
  if (!input.observedAt || !Number.isFinite(Date.parse(input.observedAt))) {
    return { ok: false, message: '观测时间无效，无法登记' }
  }

  // 幂等：同一提交令牌重试，直接回放已落库记录，绝不重复登记
  const state = loadState()
  const seen = state.submitTokens[input.clientToken]
  if (seen && seen.module === 'hydrology') {
    const existed = state.hydrology.find((r) => r.id === seen.recordId)
    if (existed) {
      return {
        ok: true,
        mode: 'idempotent_replayed',
        record: existed,
        message: `上一次提交已落库（${existed.记录编号}），本次为重试回放，未重复登记。`,
      }
    }
  }

  const blocked = blockedByInterrupt(input.measures, input.channels, now)
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      message:
        `以下量测项连续中断已超过 1 小时仍取不到数，禁止提交观测：${blocked.join('、')}。` +
        '请先人工补测，补测成功后再走调度。',
    }
  }

  const slot = sameSlotKey(input.observedAt)
  let outcomeRecord: HydrologyRecord = null as unknown as HydrologyRecord
  let mode: 'created' | 'overwritten' = 'created'
  let message = ''

  updateState((draft) => {
    const existingIdx = draft.hydrology.findIndex((r) => sameSlotKey(r.观测时间) === slot)
    const measures = {} as Record<MeasureKey, HydValue>
    for (const key of MEASURE_KEYS) measures[key] = toHydValue(input.measures[key])

    const baseRecord: HydrologyRecord = {
      id: 0,
      记录编号: input.recordNo ?? '',
      观测时间: new Date(Date.parse(input.observedAt)).toISOString(),
      ...measures,
      值守人员: input.operator,
      status: '已观测',
      abnormal: MEASURE_KEYS.some((k) => measures[k].value === null),
      channels: JSON.parse(JSON.stringify(input.channels)),
      dispatchNote: null,
      review: null,
      revisions: [],
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }

    if (existingIdx >= 0) {
      // 同一时段重复上报：只保留最后一次，按观测时间覆盖；原复核结论作废需重走
      mode = 'overwritten'
      const old = draft.hydrology[existingIdx]
      const covered: HydrologyRecord = {
        ...baseRecord,
        id: old.id,
        记录编号: old.记录编号,
        createdAt: old.createdAt,
        revisions: [
          ...old.revisions,
          {
            at: new Date(now).toISOString(),
            operator: input.operator,
            summary: `同时段覆盖：${summarizeMeasures(input.measures)}`,
          },
        ],
      }
      covered.dispatchNote = buildDispatchNote(covered, draft.hydrology.filter((r) => r.id !== old.id))
      draft.hydrology[existingIdx] = covered
      outcomeRecord = covered
      // 覆盖会清掉旧的调度/复核结论，对应泄洪待办标记为已被覆盖失效
      for (const floodRow of draft.flood) {
        for (const todo of floodRow.todos) {
          if (todo.sourceRecordNo === covered.记录编号 && !todo.handled) {
            todo.title = `【已被同时段覆盖】${todo.title}`
          }
        }
      }
      message = `观测时间 ${covered.观测时间} 已有记录，已按最后一次上报覆盖（保留记录号 ${covered.记录编号}），原调度/复核结论需重走。`
    } else {
      mode = 'created'
      const created: HydrologyRecord = {
        ...baseRecord,
        id: draft.hydrology.reduce((max, r) => Math.max(max, r.id), 0) + 1,
        记录编号: baseRecord.记录编号 || nextRecordNo(draft.hydrology),
      }
      created.dispatchNote = buildDispatchNote(created, draft.hydrology)
      draft.hydrology.push(created)
      outcomeRecord = created
      message = `水情记录 ${created.记录编号} 已落库，状态「已观测」。`
    }

    draft.submitTokens[input.clientToken] = {
      module: 'hydrology',
      recordId: outcomeRecord.id,
      at: new Date(now).toISOString(),
    }
  })

  return { ok: true, mode, record: outcomeRecord, message }
}

/** 顺序闸门：只允许 待观测→已观测→已调度→已复核。 */
export function advanceHydrology(
  id: number,
  target: HydStatus,
  now: number = Date.now(),
): { ok: boolean; message: string } {
  const state = loadState()
  const record = state.hydrology.find((r) => r.id === id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的水情记录` }
  const fromIdx = HYDROLOGY_FLOW.indexOf(record.status)
  const toIdx = HYDROLOGY_FLOW.indexOf(target)
  if (toIdx <= fromIdx) {
    return { ok: false, message: `水情记录当前已是「${record.status}」，不能重复或回退推进` }
  }
  if (toIdx !== fromIdx + 1) {
    const stepActions = ['提交观测', '下达调度', '提交复核']
    const missing = HYDROLOGY_FLOW.slice(fromIdx + 1, toIdx).map((s, i) => `「${s}」(先${stepActions[fromIdx + i]})`)
    return {
      ok: false,
      message: `跳级被拦下：「${record.status}」不能直接到「${target}」，请先完成 ${missing.join('、')} 环节。`,
    }
  }

  // 提交观测环节：连续中断超过 1 小时仍缺测的量测项必须先人工补测
  if (target === '已观测') {
    const overdue = MEASURE_KEYS.filter((k) => record[k].value === null && interruptOverOneHour(record.channels[k], now))
    if (overdue.length) {
      return {
        ok: false,
        message:
          `${overdue.join('、')}连续中断已超过 1 小时仍取不到数，禁止提交观测。` +
          '请先人工补测，补测成功后再走调度。',
      }
    }
  }

  if (target === '已调度') {
    // 调度前必须生成建议；缺测且无兜底来源时拦下，要求先补测
    const note = record.dispatchNote
    const noFallback = (['上游水位', '入库流量'] as MeasureKey[]).filter((f) => {
      return record[f].value === null && !note?.fallbackFields.includes(f)
    })
    if (noFallback.length) {
      return {
        ok: false,
        message: `${noFallback.join('、')}缺测且没有前值可兜底，不能调度，请先补测。`,
      }
    }
  }

  let result: { ok: boolean; message: string } = { ok: true, message: '' }
  updateState((draft) => {
    const row = draft.hydrology.find((r) => r.id === id)
    if (!row) {
      result = { ok: false, message: `没有找到编号为 ${id} 的水情记录` }
      return
    }
    row.status = target
    row.updatedAt = new Date(now).toISOString()
    result = { ok: true, message: `水情记录已推进到「${target}」` }
  })
  return result
}

export type ReviewInput = {
  result: ReviewConclusion['result']
  opinion: string
  reviewer: string
  /** 回写到哪一条泄洪操作的调度待办；不传则挂到最早一条未结束的泄洪操作上。 */
  floodRecordId?: number | null
}

/** 提交复核：结论回写泄洪操作调度待办，两边待调度条数同源。 */
export function submitReview(
  id: number,
  input: ReviewInput,
  now: number = Date.now(),
): { ok: boolean; message: string; todoId?: number } {
  const state = loadState()
  const record = state.hydrology.find((r) => r.id === id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的水情记录` }
  if (record.status !== '已调度') {
    return {
      ok: false,
      message: `跳级被拦下：只有「已调度」的记录才能提交复核，当前为「${record.status}」。`,
    }
  }
  if (!input.reviewer.trim()) return { ok: false, message: '请填写复核人' }

  let todoId = 0
  let message = ''
  let okFlag = true
  updateState((draft) => {
    const row = draft.hydrology.find((r) => r.id === id)
    if (!row) {
      okFlag = false
      message = `没有找到编号为 ${id} 的水情记录`
      return
    }
    // 选回写目标：指定 > 最早未结束
    let target =
      input.floodRecordId != null
        ? draft.flood.find((f) => f.id === input.floodRecordId)
        : draft.flood.find((f) => f.status !== '已结束')
    if (!target && draft.flood.length) target = draft.flood[0]
    if (!target) {
      okFlag = false
      message = '没有可回写的泄洪操作单，无法完成复核回写'
      return
    }

    const conclusion: ReviewConclusion = {
      result: input.result,
      opinion: input.opinion || '（未填写意见）',
      reviewer: input.reviewer,
      reviewedAt: new Date(now).toISOString(),
      writtenTodoIds: [],
    }
    todoId = draft.flood.reduce((max, f) => Math.max(max, ...f.todos.map((t) => t.id)), 0) + 1
    const todo: DispatchTodo = {
      id: todoId,
      sourceType: 'hydrology_review',
      sourceRecordNo: row.记录编号,
      observedAt: row.观测时间,
      title: `水情 ${row.记录编号} 复核${input.result}（${new Date(row.观测时间).toLocaleString('zh-CN', { hour12: false })}）`,
      conclusion,
      createdAt: new Date(now).toISOString(),
      // 复核回写后进入未处理调度待办，由泄洪操作侧处置后关闭，保证两边条数对得上
      handled: false,
    }
    target.todos.push(todo)
    conclusion.writtenTodoIds = [todoId]
    row.review = conclusion
    row.status = '已复核'
    row.updatedAt = new Date(now).toISOString()
    message = `复核结论「${input.result}」已回写到泄洪操作 ${target.操作编号} 的调度待办（待办 #${todoId}）。`
  })
  return { ok: okFlag, message, todoId: todoId || undefined }
}

/**
 * 待调度条数：水情页与泄洪页共用这一口径，保证两边对得上。
 * = 尚未复核（已观测/已调度）的水情记录 + 复核回写后尚未处理的调度待办。
 */
export function pendingDispatchCount(): number {
  const state = loadState()
  const awaitingReview = state.hydrology.filter((r) => r.status === '已观测' || r.status === '已调度').length
  const openTodos = state.flood.reduce((n, f) => n + f.todos.filter((t) => !t.handled).length, 0)
  return awaitingReview + openTodos
}

/** 未处理调度待办（泄洪页展示用；与水情待调度统计同一份底层数据）。 */
export function openDispatchTodos(): { todo: DispatchTodo; floodNo: string; floodId: number }[] {
  const state = loadState()
  const list: { todo: DispatchTodo; floodNo: string; floodId: number }[] = []
  for (const floodRow of state.flood) {
    for (const todo of floodRow.todos) {
      if (!todo.handled) list.push({ todo, floodNo: floodRow.操作编号, floodId: floodRow.id })
    }
  }
  return list.sort((a, b) => a.todo.id - b.todo.id)
}

/** 人工补测：把某个量测项改成实测实数，并清除该通道的连续中断状态。 */
export function applyRemeasure(
  id: number,
  field: MeasureKey,
  value: number,
  realZero: boolean,
  now: number = Date.now(),
): { ok: boolean; message: string } {
  if (value === 0 && !realZero) {
    return { ok: false, message: `${field}为 0 时必须显式勾选「确认真实零」，未确认的 0 按空值处理。` }
  }
  let result: { ok: boolean; message: string } = { ok: true, message: '' }
  updateState((draft) => {
    const row = draft.hydrology.find((r) => r.id === id)
    if (!row) {
      result = { ok: false, message: `没有找到编号为 ${id} 的水情记录` }
      return
    }
    row[field] = {
      value,
      reason: null,
      realZero: value === 0 && realZero,
      fallback: false,
      fallbackFrom: null,
    }
    row.channels[field] = { failingSince: null, lastReason: null }
    row.abnormal = MEASURE_KEYS.some((k) => row[k].value === null)
    row.updatedAt = new Date(now).toISOString()
    if (row.status === '已观测' || row.status === '已调度' || row.status === '已复核') {
      row.dispatchNote = buildDispatchNote(row, draft.hydrology.filter((r) => r.id !== row.id))
    }
    result = { ok: true, message: `${field}已人工补测为 ${value}，通道连续中断已清除。` }
  })
  return result
}

export function measureDisplay(v: HydValue): { text: string; missing: boolean } {
  if (v.value === null) return { text: '暂无数据', missing: true }
  if (v.fallback) return { text: `${v.value}（兜底）`, missing: false }
  if (v.realZero) return { text: '0（真实零）', missing: false }
  return { text: String(v.value), missing: false }
}
