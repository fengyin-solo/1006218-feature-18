import {
  BALANCE_TOLERANCE,
  HYDRO_FIELDS,
  OUTAGE_LIMIT_MINUTES,
  checkBalance,
  fallbackValue,
  fieldUnit,
  minutesBetween,
  nowSlot,
  pseudoTelemetry,
  slotOf,
} from '@/data/hydrology'
import { loadState, saveState } from '@/data/local-store'
import type {
  ActionResult,
  ChannelState,
  FloodTodo,
  HazardRecord,
  HydroFieldKey,
  HydroRecord,
  StoreState,
} from '@/data/types'

/**
 * 水情领域服务：取数空态、重试、中断拦截、兜底调度、复核回写、两处对账都在这里。
 * 所有写操作直接落到版本化 StoreState；调度待办/隐患是「派生物 + 回写物」，
 * 统一由 syncDerived 在每次变更后重建，保证泄洪页面和水情页面读到同一份明细。
 */

const FLOW_FIELDS: HydroFieldKey[] = ['入库流量', '出库流量']

function hydroRows(state: StoreState): HydroRecord[] {
  return state.entries.hydrology as HydroRecord[]
}

function persistHydro(state: StoreState, rows: HydroRecord[]): void {
  state.entries.hydrology = rows
  syncDerived(state)
  saveState(state)
}

function sortBySlot(rows: HydroRecord[]): HydroRecord[] {
  return [...rows].sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0))
}

function nextHydroId(rows: HydroRecord[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

// ——————————————————— 取数通道（模拟遥测，失败可重试） ———————————————————

const FAILURE_REASONS: Record<HydroFieldKey, string> = {
  上游水位: '上游水位计传感器故障（返回值超量程）',
  下游水位: '下游水位站遥测帧校验失败（CRC 错误）',
  入库流量: '入库流量站 RTU 无应答（超时 30s）',
  出库流量: '出库流量计与网关链路中断',
}

export function initDraft(slot: string = nowSlot()): { slot: string; channels: ChannelState[] } {
  return {
    slot,
    channels: HYDRO_FIELDS.map(({ key }) => ({
      field: key,
      status: 'idle' as ChannelState['status'],
      value: null,
      reason: '',
    })),
  }
}

export function getDraft(): { slot: string; channels: ChannelState[] } | null {
  return loadState().hydroMeta.draft
}

/** 打开/重置取数面板：按给定观测时段生成一份 idle 草稿（页面未取数时显示空态入口）。 */
export function resetDraft(slot: string = nowSlot()): { slot: string; channels: ChannelState[] } {
  const state = loadState()
  state.hydroMeta.draft = initDraft(slot)
  saveState(state)
  return state.hydroMeta.draft
}

/**
 * 拉取单项遥测：forceFail=true 时模拟该通道取数失败（值班员看到原因，可以重试）。
 * 同一时段同一通道成功值稳定（pseudoTelemetry 按时段散列）。
 * 20% 概率随机失败，用于演示「失败要能重试」；重试时成功即恢复。
 */
export function fetchChannel(
  field: HydroFieldKey,
  opts: { forceFail?: boolean; failReason?: string } = {},
): ChannelState {
  const state = loadState()
  const slot = state.hydroMeta.draft?.slot ?? nowSlot()
  if (!state.hydroMeta.draft) {
    state.hydroMeta.draft = initDraft(slot)
  }
  const channels = state.hydroMeta.draft.channels
  const channel = channels.find((item) => item.field === field)
  if (!channel) throw new Error(`未知取数项：${field}`)

  const failed = opts.forceFail ?? Math.random() < 0.2
  if (failed) {
    channel.status = 'failed'
    channel.value = null
    channel.reason = opts.failReason ?? FAILURE_REASONS[field]
    // 有通道失败：中断计时从第一次失败开始（演示时钟；真实系统取采集链路心跳）。
    if (state.hydroMeta.outageDemoStart === null && state.hydroMeta.outageStart === null) {
      state.hydroMeta.outageStart = new Date().toISOString()
    }
  } else {
    channel.status = 'ok'
    channel.value = pseudoTelemetry(slot, field)
    channel.reason = ''
    // 全部通道恢复成功才算中断结束；仍有失败通道时继续计时。
    if (channels.every((item) => item.status === 'ok')) {
      state.hydroMeta.outageStart = null
      state.hydroMeta.outageDemoStart = null
    }
  }
  saveState(state)
  return { ...channel }
}

export function fetchAll(opts: { forceFailFields?: HydroFieldKey[] } = {}): ChannelState[] {
  const forceSet = new Set(opts.forceFailFields ?? [])
  return HYDRO_FIELDS.map(({ key }) =>
    fetchChannel(key, forceSet.has(key) ? { forceFail: true, failReason: FAILURE_REASONS[key] } : {}),
  )
}

export function outageMinutes(state: StoreState = loadState()): number {
  const start = state.hydroMeta.outageDemoStart ?? state.hydroMeta.outageStart
  if (!start) return 0
  return minutesBetween(start)
}

/** 演示用：模拟通信已中断 N 分钟（真实系统由采集链路时钟给出）。 */
export function simulateOutage(minutes: number): void {
  const state = loadState()
  const start = new Date(Date.now() - minutes * 60000).toISOString()
  state.hydroMeta.outageDemoStart = start
  state.hydroMeta.outageStart = start
  saveState(state)
}

export function clearOutage(): void {
  const state = loadState()
  state.hydroMeta.outageDemoStart = null
  state.hydroMeta.outageStart = null
  saveState(state)
}

// ——————————————————— 观测提交（空值、中断拦截、时段覆盖、幂等） ———————————————————

export type SubmitObservationInput = {
  observedAt: string
  operator: string
  /** 通道实测值（取自取数面板，可能含 null 缺测） */
  values: Partial<Record<HydroFieldKey, number | null>>
  reasons?: Partial<Record<HydroFieldKey, string>>
  sources?: Partial<Record<HydroFieldKey, HydroRecord['sources'][HydroFieldKey]>>
  /** 人工补测：连续中断超 1 小时后，必须先补测；补测值走这个入口 */
  manual?: boolean
  /** 重试幂等键：同 token 重试且上一次已落库时，直接返回原记录，不重复登记 */
  clientToken?: string
}

export function submitObservation(input: SubmitObservationInput): ActionResult & { record?: HydroRecord } {
  const state = loadState()
  const rows = sortBySlot(hydroRows(state))

  // 幂等：同一 clientToken 已经落库 → 重试不重复登记。
  if (input.clientToken) {
    const existing = rows.find((row) => row.clientToken === input.clientToken)
    if (existing) {
      return { ok: true, message: `上一次提交已落库（${existing.记录编号}），本次为重试，未重复登记`, record: existing }
    }
  }

  // 连续中断超过 1 小时：非补测一律拦下，先补测再走调度。
  const downMinutes = outageMinutes(state)
  if (downMinutes > OUTAGE_LIMIT_MINUTES && !input.manual) {
    return {
      ok: false,
      message: `遥测已连续中断 ${downMinutes} 分钟（超过 ${OUTAGE_LIMIT_MINUTES} 分钟），不允许提交观测；请先人工补测后再走调度`,
    }
  }

  const slot = slotOf(input.observedAt)
  const fields = HYDRO_FIELDS.map((item) => item.key)
  const values = input.values ?? {}
  const reasons = input.reasons ?? {}
  const sources = input.sources ?? {}
  const missingReasons: HydroRecord['missingReasons'] = {}
  const resolvedSources: HydroRecord['sources'] = {}
  for (const field of fields) {
    const value = values[field] ?? null
    if (value === null || value === undefined) {
      missingReasons[field] = reasons[field] ?? FAILURE_REASONS[field]
    } else {
      resolvedSources[field] = sources[field] ?? (input.manual ? '人工补测' : '实测')
    }
  }

  const balance = checkBalance({
    入库流量: values['入库流量'] ?? null,
    出库流量: values['出库流量'] ?? null,
  })

  // 同一时段重复上报：按观测时间覆盖，只保留最后一次（更新原行，不新增登记）。
  const sameSlotIndex = rows.findIndex((row) => row.slot === slot)
  if (sameSlotIndex >= 0) {
    const old = rows[sameSlotIndex]
    const covered: HydroRecord = {
      ...old,
      观测时间: input.observedAt,
      上游水位: values['上游水位'] ?? null,
      下游水位: values['下游水位'] ?? null,
      入库流量: values['入库流量'] ?? null,
      出库流量: values['出库流量'] ?? null,
      值守人员: input.operator,
      missingReasons,
      sources: resolvedSources,
      balanceChecked: balance.checked,
      balancePassed: balance.passed,
      clientToken: input.clientToken ?? null,
      status: '已观测',
      pending: true,
      abnormal: false,
    }
    rows[sameSlotIndex] = covered
    persistHydro(state, rows)
    return {
      ok: true,
      message: `同一时段（${slot}）重复上报，已按观测时间覆盖原记录 ${covered.记录编号}，仅保留最后一次取值`,
      record: covered,
    }
  }

  const id = nextHydroId(rows)
  const record: HydroRecord = {
    id,
    status: '已观测',
    pending: true,
    abnormal: false,
    记录编号: `HYDR-${String(id).padStart(4, '0')}`,
    观测时间: input.observedAt,
    slot,
    上游水位: values['上游水位'] ?? null,
    下游水位: values['下游水位'] ?? null,
    入库流量: values['入库流量'] ?? null,
    出库流量: values['出库流量'] ?? null,
    值守人员: input.operator,
    调度建议: '',
    复核结论: '',
    missingReasons,
    sources: resolvedSources,
    legacyZero: [],
    balanceChecked: balance.checked,
    balancePassed: balance.passed,
    clientToken: input.clientToken ?? null,
  }
  rows.push(record)
  persistHydro(state, rows)
  // 提交落库后清掉草稿与中断演示态。
  state.hydroMeta.draft = null
  state.hydroMeta.token = null
  saveState(state)
  return { ok: true, message: `观测已登记：${record.记录编号}`, record }
}

/** 人工补测：中断超 1 小时后唯一合法入口；补到哪项就把哪项的缺测原因清掉。 */
export function submitManualMeasurement(input: SubmitObservationInput): ActionResult & { record?: HydroRecord } {
  return submitObservation({ ...input, manual: true })
}

// ——————————————————— 调度建议（兜底值必须注明） ———————————————————

export type DispatchAdvice = {
  ok: boolean
  message: string
  advice: string
  fallbacks: { field: HydroFieldKey; value: number; fromId: string; fromTime: string }[]
  balanceDetail: string
  usedFields: Record<HydroFieldKey, number>
}

/**
 * 生成调度建议：
 * - 空值不参与流量平衡校验（缺测时跳过，绝不当 0）。
 * - 上游水位、入库流量缺失时按前一时段非空值兜底，并在建议里注明用了哪个时段的兜底值；
 *   连历史值都没有 → 不允许调度，先补测。
 */
export function buildDispatchAdvice(recordId: number): DispatchAdvice {
  const state = loadState()
  const rows = sortBySlot(hydroRows(state))
  const record = rows.find((row) => Number(row.id) === recordId)
  if (!record) return { ok: false, message: '没有找到这条水情记录', advice: '', fallbacks: [], balanceDetail: '', usedFields: {} as Record<HydroFieldKey, number> }

  const usedFields = {} as Record<HydroFieldKey, number>
  const fallbacks: DispatchAdvice['fallbacks'] = []
  const needFallback: HydroFieldKey[] = ['上游水位', '入库流量']
  for (const field of HYDRO_FIELDS.map((item) => item.key)) {
    const value = record[field]
    if (value !== null) {
      usedFields[field] = value
    }
  }
  for (const field of needFallback) {
    if (record[field] === null) {
      const hit = fallbackValue(rows, field, record.观测时间)
      if (!hit) {
        return {
          ok: false,
          message: `${field}缺测且找不到前一时段取值兜底，不能下达调度，请先补测`,
          advice: '',
          fallbacks,
          balanceDetail: checkBalance(record).detail,
          usedFields,
        }
      }
      usedFields[field] = hit.value
      fallbacks.push({ field, ...hit })
    }
  }

  // 平衡校验只用真实在库的值：出库缺测时跳过，不拿兜底流量冒充。
  const balance = checkBalance({
    入库流量: record.入库流量 ?? (fallbacks.find((item) => item.field === '入库流量')?.value ?? null),
    出库流量: record.出库流量,
  })
  const inflow = usedFields['入库流量']
  const outflow = usedFields['出库流量']
  const level = usedFields['上游水位']
  const gateHint = outflow !== undefined && inflow !== undefined
    ? outflow < inflow * (1 - BALANCE_TOLERANCE)
      ? '库水位将抬升，建议增大泄量'
      : outflow > inflow * (1 + BALANCE_TOLERANCE)
        ? '库水位将下降，建议收小泄量'
        : '进出库基本平衡，维持当前闸门开度'
    : '出库流量缺测，本次不对闸门开度给出量化建议'

  const fallbackNote = fallbacks.length
    ? `；其中 ${fallbacks.map((f) => `${f.field}使用前时段 ${f.fromTime}（${f.fromId}）的兜底值 ${f.value}${fieldUnit(f.field)}，非本时段实测`).join('；')}`
    : ''
  const advice = `上游水位按 ${level}m、入库流量按 ${inflow ?? '缺测'}m³/s 评估：${gateHint}${fallbackNote}`
  void level
  return {
    ok: true,
    message: fallbacks.length ? '调度建议已生成（含兜底值，已注明来源时段）' : '调度建议已生成，全部使用本时段实测值',
    advice,
    fallbacks,
    balanceDetail: balance.detail,
    usedFields,
  }
}

/** 环节只能按顺序推进：待观测 → 已观测 → 已调度 → 已复核，跳级直接拦下。 */
function requireStatus(record: HydroRecord, expected: string, action: string, missingStep: string): ActionResult {
  if (record.status !== expected) {
    return {
      ok: false,
      message: `环节不能跳级：「${action}」要求记录处于「${expected}」，当前为「${record.status}」，请先走「${missingStep}」`,
    }
  }
  return { ok: true, message: '' }
}

export function issueDispatch(recordId: number): ActionResult & { record?: HydroRecord } {
  const state = loadState()
  const rows = hydroRows(state)
  const record = rows.find((row) => Number(row.id) === recordId)
  if (!record) return { ok: false, message: '没有找到这条水情记录' }
  const gate = requireStatus(record, '已观测', '下达调度', '提交观测')
  if (!gate.ok) return gate

  const advice = buildDispatchAdvice(recordId)
  if (!advice.ok) return { ok: false, message: advice.message }

  // 兜底字段落库时标记来源为「兜底」，页面角标 + 导出都能看出来。
  for (const fb of advice.fallbacks) {
    ;(record as HydroRecord)[fb.field] = fb.value
    record.sources[fb.field] = '兜底'
  }
  record.调度建议 = advice.advice
  record.status = '已调度'
  record.pending = true
  persistHydro(state, rows)
  return { ok: true, message: `调度已下达：${advice.message}`, record }
}

// ——————————————————— 复核结论回写：调度待办 + 巡视隐患 ———————————————————

export function submitReview(
  recordId: number,
  conclusion: string,
  opts: { openHazard?: boolean; hazardLevel?: string } = {},
): ActionResult & { record?: HydroRecord } {
  const state = loadState()
  const rows = hydroRows(state)
  const record = rows.find((row) => Number(row.id) === recordId)
  if (!record) return { ok: false, message: '没有找到这条水情记录' }
  const gate = requireStatus(record, '已调度', '提交复核', '下达调度')
  if (!gate.ok) return gate
  if (!conclusion.trim()) return { ok: false, message: '复核结论不能为空' }

  record.复核结论 = conclusion.trim()
  record.status = '已复核'
  record.pending = false
  persistHydro(state, rows)

  // 处理结论同步回写现场巡视隐患清单（缺测/不平衡 → 开一条；否则关闭旧的）。
  const balance = checkBalance(record)
  const hasGap = Object.keys(record.missingReasons).length > 0
  if (opts.openHazard || hasGap || (balance.checked && balance.passed === false)) {
    const missingDesc = Object.entries(record.missingReasons)
      .map(([field, reason]) => `${field}缺测（${reason}）`)
      .join('；')
    const parts = [
      `水情复核处理结论：${conclusion.trim()}`,
      missingDesc ? `缺测项：${missingDesc}` : '',
      balance.checked && !balance.passed ? balance.detail : '',
    ].filter(Boolean)
    upsertHazardFromHydro(state, record, parts.join('；'), opts.hazardLevel ?? (hasGap ? '较大' : '一般'))
  } else {
    resolveHazardFromHydro(state, record, conclusion.trim())
  }
  syncDerived(state)
  saveState(state)
  return { ok: true, message: `复核完成，结论已回写到泄洪调度待办与现场巡视隐患清单`, record }
}

function upsertHazardFromHydro(state: StoreState, record: HydroRecord, desc: string, level: string): void {
  const bizDate = record.观测时间.slice(0, 10)
  const dedupeKey = `hydro:${record.记录编号}`
  const existing = state.hazards.find((item) => item.dedupeKey === dedupeKey)
  if (existing) {
    existing.隐患描述 = desc
    existing.处理结论 = record.复核结论
    existing.隐患等级 = level
    existing.关联记录 = record.记录编号
    existing.业务日期 = bizDate
    existing.来源 = '水情回写'
    saveState(state)
    return
  }
  const id = state.hazards.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  state.hazards.push({
    id,
    status: '待处理',
    pending: true,
    abnormal: false,
    隐患编号: `HAZD-${String(id).padStart(4, '0')}`,
    业务日期: bizDate,
    巡视点位: '水情遥测/库区',
    隐患描述: desc,
    隐患等级: level,
    处理结论: record.复核结论,
    来源: '水情回写',
    关联记录: record.记录编号,
    dedupeKey,
    missingFields: Object.keys(record.missingReasons),
    rejectedDuplicate: false,
  })
}

function resolveHazardFromHydro(state: StoreState, record: HydroRecord, conclusion: string): void {
  const dedupeKey = `hydro:${record.记录编号}`
  const existing = state.hazards.find((item) => item.dedupeKey === dedupeKey)
  if (existing) {
    existing.status = '已消除'
    existing.pending = false
    existing.处理结论 = `复核无遗留：${conclusion}`
  }
}

// ——————————————————— 现场巡视：登记重复只认第一次 ———————————————————

export type HazardInput = {
  业务日期: string
  巡视点位: string
  隐患描述: string
  隐患等级: string
}

export function registerHazard(input: HazardInput): ActionResult & { hazard?: HazardRecord; duplicate?: HazardRecord } {
  const state = loadState()
  const dedupeKey = `${input.业务日期}|${input.巡视点位}|${input.隐患描述}`
  // 重复判定：已登记的隐患按「业务日期 + 巡视点位 + 隐患描述」识别，只认第一次取值。
  const first = state.hazards.find((item) => item.dedupeKey === dedupeKey && !item.rejectedDuplicate)
  if (first) {
    const rejectedId = state.rejectedHazards.reduce((max, row) => Math.max(max, Number(row.id)), 1000) + 1
    const rejected: HazardRecord = {
      id: rejectedId,
      status: '待处理',
      pending: false,
      abnormal: true,
      隐患编号: `REJ-${String(rejectedId).padStart(4, '0')}`,
      业务日期: input.业务日期,
      巡视点位: input.巡视点位,
      隐患描述: input.隐患描述,
      隐患等级: input.隐患等级,
      处理结论: '',
      来源: '现场登记',
      关联记录: '',
      dedupeKey,
      missingFields: [],
      rejectedDuplicate: true,
    }
    state.rejectedHazards.push(rejected)
    saveState(state)
    return {
      ok: false,
      message: `登记重复：同业务日期、同点位、同描述的隐患已存在（${first.隐患编号}），只认第一次的取值，本次上报按重复处理，未计入清单`,
      duplicate: rejected,
    }
  }
  const id = state.hazards.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const hazard: HazardRecord = {
    id,
    status: '待处理',
    pending: true,
    abnormal: false,
    隐患编号: `HAZD-${String(id).padStart(4, '0')}`,
    业务日期: input.业务日期,
    巡视点位: input.巡视点位,
    隐患描述: input.隐患描述,
    隐患等级: input.隐患等级,
    处理结论: '',
    来源: '现场登记',
    关联记录: '',
    dedupeKey,
    missingFields: [],
    rejectedDuplicate: false,
  }
  state.hazards.push(hazard)
  syncDerived(state)
  saveState(state)
  return { ok: true, message: `隐患已登记：${hazard.隐患编号}`, hazard }
}

// ——————————————————— 派生表与对账：两处条数对得上 ———————————————————

/**
 * 重建调度待办：明细 = 状态在「已观测（待调度）/已调度/已复核」的水情记录，一一对应。
 * 泄洪页面的「待调度条数」与水情页面的「待调度记录」读同一份 floodTodos。
 */
export function syncDerived(state: StoreState = loadState()): void {
  const rows = sortBySlot(hydroRows(state))
  const oldById = new Map(state.floodTodos.map((todo) => [todo.记录编号, todo]))
  let seq = state.floodTodos.reduce((max, todo) => {
    const n = Number(String(todo.todoId).replace('DISP-', ''))
    return Math.max(max, Number.isFinite(n) ? n : 0)
  }, 0)

  const todos: FloodTodo[] = []
  for (const record of rows) {
    if (record.status === '待观测') continue
    const previous = oldById.get(record.记录编号)
    let todoId = previous?.todoId
    if (!todoId) {
      seq += 1
      todoId = `DISP-${String(seq).padStart(4, '0')}`
    }
    todos.push({
      id: todos.length + 1,
      todoId,
      status: record.status,
      pending: record.status === '已观测',
      abnormal: false,
      操作编号: todoId,
      记录编号: record.记录编号,
      观测时间: record.观测时间,
      泄洪闸号: '1号泄洪闸',
      建议: record.调度建议,
      复核结论: record.复核结论,
      clientToken: null,
    })
  }
  state.floodTodos = todos
  state.entries.patrol = state.hazards.filter((item) => !item.rejectedDuplicate)
}

export type ReconcileResult = {
  pendingDispatchHydro: number
  pendingDispatchTodos: number
  matched: boolean
  totalTodos: number
  reviewedTodos: number
  missingRecords: number
  fallbackRecords: number
  hazardCount: number
  pendingHazards: number
}

/** 对账口径：待调度条数（水情）与待办条数（泄洪）必须一致，明细同源。 */
export function reconcile(): ReconcileResult {
  const state = loadState()
  syncDerived(state)
  saveState(state)
  const hydro = hydroRows(state)
  const pendingHydro = hydro.filter((row) => row.status === '已观测').length
  const pendingTodos = state.floodTodos.filter((todo) => todo.pending).length
  return {
    pendingDispatchHydro: pendingHydro,
    pendingDispatchTodos: pendingTodos,
    matched: pendingHydro === pendingTodos,
    totalTodos: state.floodTodos.length,
    reviewedTodos: state.floodTodos.filter((todo) => todo.status === '已复核').length,
    missingRecords: hydro.filter((row) => Object.keys(row.missingReasons).length > 0).length,
    fallbackRecords: hydro.filter((row) =>
      HYDRO_FIELDS.some(({ key }) => row.sources[key] === '兜底'),
    ).length,
    hazardCount: state.hazards.filter((item) => !item.rejectedDuplicate).length,
    pendingHazards: state.hazards.filter((item) => item.pending && !item.rejectedDuplicate).length,
  }
}

// ——————————————————— 查询 ———————————————————

export function listHydro(): HydroRecord[] {
  const state = loadState()
  syncDerived(state)
  saveState(state)
  return sortBySlot(hydroRows(state))
}

export function listFloodTodos(): FloodTodo[] {
  const state = loadState()
  syncDerived(state)
  saveState(state)
  return state.floodTodos
}

export function listHazards(includeRejected = false): HazardRecord[] {
  const state = loadState()
  const rows = includeRejected
    ? [...state.hazards, ...state.rejectedHazards]
    : state.hazards.filter((item) => !item.rejectedDuplicate)
  return [...rows].sort((a, b) => (a.业务日期 < b.业务日期 ? -1 : 1))
}

export function rejectedHazards(): HazardRecord[] {
  return loadState().rejectedHazards
}

export function listSplitHydro(rows: HydroRecord[] = listHydro()): { measured: HydroRecord[]; missing: HydroRecord[] } {
  // 空值记录单独列出，不混在实数里。
  const missing = rows.filter((row) => Object.keys(row.missingReasons).length > 0)
  const measured = rows.filter((row) => Object.keys(row.missingReasons).length === 0)
  return { measured, missing }
}

export { FAILURE_REASONS, FLOW_FIELDS }
