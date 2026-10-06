/**
 * 汛期空值处理相关的领域类型。
 *
 * 水情四个量测项（上游水位/下游水位/入库流量/出库流量）统一用 HydValue 表示：
 * - value 为 number 时是实测实数（包括真实的 0）；
 * - value 为 null 时是「取不到」的空值，必须带 reason，并与真实 0 严格区分；
 * - realZero=true 表示值班员确认这就是真实零（必须显式勾选确认，随手填 0 不算）；
 * - fallback=true 表示调度建议里用了前一时段兜底值。
 */

export type MeasureKey = '上游水位' | '下游水位' | '入库流量' | '出库流量'

export const MEASURE_KEYS: MeasureKey[] = ['上游水位', '下游水位', '入库流量', '出库流量']

/** 取数失败原因编码，页面上会翻译成中文说明。 */
export type FetchReason =
  | 'sensor_timeout' // 传感器/遥测通道超时
  | 'sensor_offline' // 测站离线
  | 'link_interrupt' // 通信链路中断
  | 'value_unreliable' // 取到数但明显失真，弃用
  | 'legacy_zero' // 存量记录：早期把缺数随手写成 0
  | 'legacy_unparsable' // 存量记录：历史值无法解析为数值
  | 'manual_remeasure_pending' // 等待人工补测

export const REASON_TEXT: Record<FetchReason, string> = {
  sensor_timeout: '遥测采集超时，未收到测站回传',
  sensor_offline: '测站设备离线，本次取不到数',
  link_interrupt: '通信链路中断，数据未送达',
  value_unreliable: '回传数值明显失真，按弃值处理',
  legacy_zero: '存量记录中该项为裸 0，按缺数规则识别为空（原始值 0 保留在原值里）',
  legacy_unparsable: '存量记录中的取值无法解析为数值，按缺数处理',
  manual_remeasure_pending: '连续中断超过一小时，等待人工补测',
}

/** 单个量测项的取值状态。 */
export type HydValue = {
  value: number | null
  reason: FetchReason | null
  /** 值班员显式确认真实零（区别于随手填的 0）。 */
  realZero: boolean
  /** 是否前一时段兜底值（只用于调度建议，不改动观测原值）。 */
  fallback: boolean
  /** 兜底时记录取值来源记录编号，便于追溯。 */
  fallbackFrom: string | null
  /** 存量迁移时保留原始字符串，审计可查。 */
  legacyRaw?: string | null
}

/** 取数通道状态：用于判断是否「连续中断超过一小时」。 */
export type ChannelState = {
  /** 最近一次取数失败时间（ISO 字符串）；取数成功后清空。 */
  failingSince: string | null
  lastReason: FetchReason | null
}

export type HydStatus = '待观测' | '已观测' | '已调度' | '已复核'

/** 一条水情记录。 */
export type HydrologyRecord = {
  id: number
  记录编号: string
  /** 观测时间，精确到分钟，同时是「同一时段」去重的业务键。 */
  观测时间: string
  上游水位: HydValue
  下游水位: HydValue
  入库流量: HydValue
  出库流量: HydValue
  值守人员: string
  status: HydStatus
  abnormal: boolean
  /** 各量测项通道的连续中断状态，随记录一起保存。 */
  channels: Record<MeasureKey, ChannelState>
  /** 提交观测时生成的调度建议（含兜底说明）。 */
  dispatchNote: DispatchNote | null
  /** 复核结论：随「提交复核」回写到泄洪操作的调度待办。 */
  review: ReviewConclusion | null
  /** 同观测时间被覆盖时保留上报历史（只保留最后一次生效）。 */
  revisions: { at: string; operator: string; summary: string }[]
  createdAt: string
  updatedAt: string
}

export type DispatchNote = {
  text: string
  /** 入库流量平衡差：只由实数参与计算；含空值时为 null。 */
  balanceGap: number | null
  balanceText: string
  fallbackFields: MeasureKey[]
}

export type ReviewConclusion = {
  result: '通过' | '有条件通过' | '不通过'
  opinion: string
  reviewer: string
  reviewedAt: string
  /** 回写到泄洪操作待办后回填的待办编号。 */
  writtenTodoIds: number[]
}

/** 泄洪操作记录（复核结论回写目标）。 */
export type FloodStatus = '待审批' | '已批准' | '泄洪中' | '已结束'

export type FloodRecord = {
  id: number
  操作编号: string
  泄洪闸号: string
  开启孔数: number | null
  泄洪流量: number | null
  下游预警: string
  操作时间: string
  操作人员: string
  status: FloodStatus
  abnormal: boolean
  /** 调度待办：水情复核结论回写到这里。 */
  todos: DispatchTodo[]
}

export type DispatchTodo = {
  id: number
  sourceType: 'hydrology_review'
  sourceRecordNo: string
  /** 待调度对应的观测时间。 */
  observedAt: string
  title: string
  conclusion: ReviewConclusion | null
  createdAt: string
  handled: boolean
}

/** 缺陷/隐患记录。 */
export type DefectStatus = '待处理' | '处理中' | '已消除' | '已挂账'

export type DefectRecord = {
  id: number
  缺陷编号: string
  设备名称: string
  缺陷描述: string
  缺陷等级: string
  /** 业务日期（发现日期），历史数据按它排序补数。 */
  发现日期: string
  处理期限: string
  处理人员: string
  status: DefectStatus
  abnormal: boolean
  /** 处理结论：确认消除时回写到现场巡视隐患清单。 */
  conclusion: DefectConclusion | null
  /** 重复上报命中的既有缺陷编号；只认第一次取值。 */
  duplicateOf: string | null
  createdAt: string
  updatedAt: string
}

export type DefectConclusion = {
  result: string
  handler: string
  handledAt: string
  /** 回写后回填的隐患清单项编号。 */
  writtenHazardId: number | null
}

/** 现场巡视隐患清单项。 */
export type HazardItem = {
  id: number
  sourceType: 'defect_handle'
  sourceDefectNo: string
  业务日期: string
  设备名称: string
  缺陷描述: string
  缺陷等级: string
  conclusion: string
  handler: string
  handledAt: string
}

/** 重复上报被拦下的留痕：只认第一次取值，后到的按重复处理（不登记为新缺陷）。 */
export type DuplicateRejection = {
  id: number
  /** 命中的既有缺陷编号 */
  recordNo: string
  attemptedBy: string
  at: string
  reason: string
}

/** 登记结果：页面据此提示「已落库/被拦截」。 */
export type SubmitOutcome<T> =
  | { ok: true; mode: 'created' | 'overwritten' | 'idempotent_replayed' | 'duplicate'; record: T; message: string }
  | { ok: false; message: string; blocked?: string[] }

/** 存量迁移的规则结论。 */
export type MigrationIssue =
  | { module: 'hydrology'; recordNo: string; businessDate: string; kind: 'legacy_zero' | 'legacy_unparsable'; fields: string[]; rawValues: string[] }
  | { module: 'defect'; recordNo: string; businessDate: string; kind: 'missing_fields'; fields: string[] }
  | { module: 'flood'; recordNo: string; businessDate: string; kind: 'missing_fields'; fields: string[] }

export type MigrationReport = {
  version: number
  migratedAt: string
  order: string[]
  counts: Record<string, { migrated: number; issues: number }>
  issues: MigrationIssue[]
}

export type DomainState = {
  hydrology: HydrologyRecord[]
  flood: FloodRecord[]
  defect: DefectRecord[]
  hazards: HazardItem[]
  /** 缺陷重复上报留痕（只认第一次，后到的在此可查）。 */
  duplicateRejections: DuplicateRejection[]
  /** 已成功登记的提交令牌：重试提交时幂等去重。 */
  submitTokens: Record<string, { module: string; recordId: number; at: string }>
  migration: MigrationReport | null
}
