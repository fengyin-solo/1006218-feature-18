/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/**
 * 单元格值：null 专门表示「没有取到数」（空值），与真实的 0 严格区分。
 * 早期值班员随手填的 0 会在存量迁移中按规则识别后改写为 null，而不是继续当作实数。
 */
export type CellValue = string | number | boolean | null

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 索引签名放宽到 unknown：通用模块只放 CellValue，领域行（水情/隐患）允许挂
  // 缺测原因、取值来源等结构化字段；具体含义由 HydroRecord / HazardRecord 收窄。
  [field: string]: unknown
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 四个遥测项：两项水位 + 两项流量。任何一项都可能取不到数。 */
export type HydroFieldKey = '上游水位' | '下游水位' | '入库流量' | '出库流量'

/** 取数方式：实测、人工补测、兜底（前一时段取值）。空值不参与任何校验与统计。 */
export type HydroSource = '实测' | '人工补测' | '兜底' | '迁移回填' | null

/**
 * 水情记录。
 * - 四个遥测项允许为 null：null = 缺测，0 = 真的为零，二者在页面和导出里分别呈现。
 * - missingReasons 只记录缺测项及取数失败原因；空记录单独成列，不混进实数表格。
 * - sources 记录每个非空项的取值方式，兜底值必须能在页面上被看出来。
 * - slot 为观测时段（观测时间按整点归槽），同一时段重复上报只保留最后一次。
 */
export type HydroRecord = EntryRow & {
  记录编号: string
  观测时间: string
  slot: string
  上游水位: number | null
  下游水位: number | null
  入库流量: number | null
  出库流量: number | null
  值守人员: string
  调度建议: string
  复核结论: string
  missingReasons: Partial<Record<HydroFieldKey, string>>
  sources: Partial<Record<HydroFieldKey, HydroSource>>
  legacyZero?: HydroFieldKey[]
  balanceChecked?: boolean
  balancePassed?: boolean | null
  clientToken?: string | null
}

/** 泄洪操作的「调度待办」：由水情记录的调度环节回写，是对账口径的唯一明细来源。 */
export type FloodTodo = EntryRow & {
  todoId: string
  操作编号: string
  记录编号: string
  观测时间: string
  泄洪闸号: string
  建议: string
  复核结论: string
  clientToken?: string | null
}

/** 现场巡视的隐患：复核处理结论回写到这里。手动登记重复时只认第一次。 */
export type HazardRecord = EntryRow & {
  隐患编号: string
  业务日期: string
  巡视点位: string
  隐患描述: string
  隐患等级: string
  处理结论: string
  来源: '现场登记' | '水情回写'
  关联记录: string
  dedupeKey: string
  missingFields: string[]
  rejectedDuplicate?: boolean
}

/** 取数面板上单项遥测的实时状态：取不到数时明确告诉值班员原因，并允许重试。 */
export type ChannelState = {
  field: HydroFieldKey
  status: 'idle' | 'loading' | 'ok' | 'failed'
  value: number | null
  reason: string
}

/** 本地持久化的整体结构（版本 2：引入空值语义与领域数据）。 */
export type StoreState = {
  version: number
  entries: Record<string, EntryRow[]>
  floodTodos: FloodTodo[]
  hazards: HazardRecord[]
  rejectedHazards: HazardRecord[]
  hydroMeta: {
    token: string | null
    outageStart: string | null
    outageDemoStart: string | null
    draft: { slot: string; channels: ChannelState[] } | null
  }
}
