/**
 * 对账口径与明细清单：统计数和导出明细永远来自同一份过滤结果，
 * 页面条数、卡片统计、CSV 导出行数三处一致（「对账口径与明细清单一起变」）。
 */
import { openDispatchTodos, pendingDispatchCount } from './hydrology-service'
import { loadState } from './store'
import { MEASURE_KEYS, REASON_TEXT } from './types'
import type {
  DefectRecord,
  DuplicateRejection,
  FloodRecord,
  HazardItem,
  HydrologyRecord,
  MeasureKey,
  MigrationIssue,
} from './types'

export type HydrologyFilters = {
  keyword: string
  onlyMissing: boolean
}

export type DefectFilters = {
  keyword: string
  status: string
}

export type HydrologyView = {
  /** 实数记录：四个量测项全部有值（含真实零），不与空值混在一起。 */
  complete: HydrologyRecord[]
  /** 空值记录：至少一个量测项取不到，单独列出。 */
  incomplete: HydrologyRecord[]
  /** 过滤后的全部记录（统计与导出共用）。 */
  all: HydrologyRecord[]
  stats: {
    todayInflow: number | null
    todayOutflow: number | null
    pendingDispatch: number
    missingRecords: number
    realZeroCount: number
    fallbackUsedCount: number
  }
}

function dayKey(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso.slice(0, 10)
  return new Date(t).toISOString().slice(0, 10)
}

export function hydrologyView(filters: HydrologyFilters): HydrologyView {
  const keyword = filters.keyword.trim()
  const all = loadState()
    .hydrology.filter((row) => {
      if (!keyword) return true
      const hay = `${row.记录编号} ${row.值守人员} ${row.观测时间}`
      return hay.includes(keyword)
    })
    .filter((row) => (filters.onlyMissing ? MEASURE_KEYS.some((k) => row[k].value === null) : true))
    .sort((a, b) => a.观测时间.localeCompare(b.观测时间))

  const complete = all.filter((r) => MEASURE_KEYS.every((k) => r[k].value !== null))
  const incomplete = all.filter((r) => MEASURE_KEYS.some((k) => r[k].value === null))

  const today = new Date().toISOString().slice(0, 10)
  const todayRows = all.filter((r) => dayKey(r.观测时间) === today)
  // 今日入/出库流量合计：只累加实数，空值跳过；今日全空时为 null（不是 0）
  const sumReal = (field: MeasureKey): number | null => {
    const values = todayRows.map((r) => r[field].value).filter((v): v is number => v !== null)
    return values.length ? Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100 : null
  }

  return {
    complete,
    incomplete,
    all,
    stats: {
      todayInflow: sumReal('入库流量'),
      todayOutflow: sumReal('出库流量'),
      pendingDispatch: pendingDispatchCount(),
      missingRecords: incomplete.length,
      realZeroCount: all.reduce(
        (n, r) => n + MEASURE_KEYS.filter((k) => r[k].realZero).length,
        0,
      ),
      fallbackUsedCount: all.filter(
        (r) => r.dispatchNote && r.dispatchNote.fallbackFields.length > 0,
      ).length,
    },
  }
}

export type FloodView = {
  all: FloodRecord[]
  openTodos: ReturnType<typeof openDispatchTodos>
  stats: {
    pendingApproval: number
    discharging: number
    todayDischarge: number | null
    pendingDispatch: number
    openTodoCount: number
  }
}

export function floodView(): FloodView {
  const state = loadState()
  const all = [...state.flood].sort((a, b) => a.操作时间.localeCompare(b.操作时间))
  const openTodos = openDispatchTodos()
  const today = new Date().toISOString().slice(0, 10)
  const todayDischargeValues = all
    .filter((f) => dayKey(f.操作时间) === today)
    .map((f) => f.泄洪流量)
    .filter((v): v is number => v !== null)
  return {
    all,
    openTodos,
    stats: {
      pendingApproval: all.filter((f) => f.status === '待审批').length,
      discharging: all.filter((f) => f.status === '泄洪中').length,
      todayDischarge: todayDischargeValues.length
        ? Math.round(todayDischargeValues.reduce((a, b) => a + b, 0) * 100) / 100
        : null,
      pendingDispatch: pendingDispatchCount(),
      openTodoCount: openTodos.length,
    },
  }
}

export type DefectView = {
  all: DefectRecord[]
  hazards: HazardItem[]
  duplicates: DuplicateRejection[]
  stats: {
    pending: number
    handling: number
    resolved: number
    duplicate: number
    hazardCount: number
  }
}

export function defectView(filters: DefectFilters): DefectView {
  const keyword = filters.keyword.trim()
  const state = loadState()
  const all = state.defect
    .filter((d) => (filters.status ? d.status === filters.status : true))
    .filter((d) => {
      if (!keyword) return true
      return `${d.缺陷编号} ${d.设备名称} ${d.缺陷描述} ${d.处理人员}`.includes(keyword)
    })
    .sort((a, b) => b.发现日期.localeCompare(a.发现日期))
  const hazards = state.hazards
  const duplicates = [...state.duplicateRejections].sort((a, b) => b.id - a.id)
  return {
    all,
    hazards,
    duplicates,
    stats: {
      pending: all.filter((d) => d.status === '待处理').length,
      handling: all.filter((d) => d.status === '处理中').length,
      resolved: all.filter((d) => d.status === '已消除').length,
      duplicate: duplicates.length,
      hazardCount: hazards.length,
    },
  }
}

export function migrationView(): MigrationIssue[] {
  const report = loadState().migration
  return report ? report.issues : []
}

function csvCell(value: string | number | null): string {
  if (value === null) return '暂无数据'
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function download(filename: string, lines: string[]): void {
  const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 导出水情：空值单独成列说明，明细行与页面完全一致。 */
export function exportHydrology(view: HydrologyView): void {
  const header = [
    '记录编号', '观测时间', ...MEASURE_KEYS, '值守人员', '状态',
    '缺测量测项', '缺测原因', '兜底字段', '平衡校验',
  ]
  const lines = [header.join(',')]
  for (const r of view.all) {
    const miss = MEASURE_KEYS.filter((k) => r[k].value === null)
    lines.push(
      [
        r.记录编号,
        r.观测时间,
        ...MEASURE_KEYS.map((k) =>
          r[k].value === null
            ? `暂无数据(${REASON_TEXT[r[k].reason ?? 'sensor_timeout']})`
            : r[k].realZero
              ? '0(真实零)'
              : String(r[k].value),
        ),
        r.值守人员,
        r.status,
        miss.join('|') || '无',
        miss.map((k) => REASON_TEXT[r[k].reason ?? 'sensor_timeout']).join('|') || '无',
        r.dispatchNote?.fallbackFields.join('|') || '无',
        r.dispatchNote?.balanceText ?? '未生成',
      ].map(csvCell).join(','),
    )
  }
  download(`水情记录-明细-${view.all.length}条.csv`, lines)
}

export function exportFlood(view: FloodView): void {
  const lines: string[] = []
  lines.push(['操作编号', '泄洪闸号', '开启孔数', '泄洪流量', '下游预警', '操作时间', '操作人员', '状态'].join(','))
  for (const f of view.all) {
    lines.push(
      [
        f.操作编号, f.泄洪闸号, f.开启孔数, f.泄洪流量, f.下游预警, f.操作时间, f.操作人员, f.status,
      ].map(csvCell).join(','),
    )
  }
  lines.push('')
  lines.push([`调度待办（未处理 ${view.openTodos.length} 条，与水情页待调度口径同源）`].join(','))
  lines.push(['待办号', '来源记录', '观测时间', '事项', '复核结论'].join(','))
  for (const { todo, floodNo } of view.openTodos) {
    lines.push(
      [todo.id, todo.sourceRecordNo, todo.observedAt, `[${floodNo}] ${todo.title}`, todo.conclusion?.result ?? '']
        .map(csvCell)
        .join(','),
    )
  }
  download(`泄洪操作-明细-${view.all.length}条.csv`, lines)
}

/** 导出隐患清单：行数 = 页面隐患清单条数。 */
export function exportHazards(view: DefectView): void {
  const lines = [
    ['隐患号', '来源缺陷', '业务日期', '设备名称', '缺陷描述', '等级', '处理结论', '处理人', '处理时间'].join(','),
  ]
  for (const h of view.hazards) {
    lines.push(
      [h.id, h.sourceDefectNo, h.业务日期, h.设备名称, h.缺陷描述, h.缺陷等级, h.conclusion, h.handler, h.handledAt]
        .map(csvCell)
        .join(','),
    )
  }
  download(`现场巡视隐患清单-${view.hazards.length}条.csv`, lines)
}

/** 导出存量迁移缺失字段清单（单独罗列，不混在实数明细里）。 */
export function exportMigrationIssues(issues: MigrationIssue[]): void {
  const lines = [['迁移顺序', '模块', '记录编号', '业务日期/观测时间', '问题类型', '缺失字段', '原始值'].join(',')]
  const order = loadState().migration?.order ?? []
  for (const issue of issues) {
    const raw = 'rawValues' in issue ? issue.rawValues.join('|') : ''
    lines.push(
      [
        order.join('→'),
        issue.module,
        issue.recordNo,
        issue.businessDate,
        issue.kind,
        issue.fields.join('|'),
        raw,
      ].map(csvCell).join(','),
    )
  }
  download(`存量迁移-缺失字段清单-${issues.length}条.csv`, lines)
}
