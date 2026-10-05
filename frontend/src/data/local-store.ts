import { buildSeedState } from './seed-v2'
import { classifyLegacyZero, slotOf, STORE_VERSION, LEGACY_STORE_VERSION } from './hydrology'
import type {
  EntryRow,
  HazardRecord,
  HydroFieldKey,
  HydroRecord,
  StoreState,
} from './types'

/**
 * 版本化本地持久化。
 * STORAGE_KEY 沿用旧 key：老用户浏览器里是 v1（扁平 entries），首次打开 v2 会触发一次
 * 存量迁移；新用户直接播种 v2。所有读写都走 StoreState，旧的 allRows/listRows 保留
 * 但返回的是 state.entries，通用模块视图不用改。
 */
const STORAGE_KEY = 'hydropower-plant-om:entries'
const MIGRATION_REPORT_KEY = 'hydropower-plant-om:migration-report'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * v1 → v2 迁移规则（顺序固定，跳步会直接报错，对账口径与明细一起生成）：
 * 1. 先升级存储壳：version 置 2，补齐 floodTodos / hazards / hydroMeta 新容器。
 * 2. 水情存量：按「观测时间」升序逐条过 classifyLegacyZero 识别规则——
 *    水位 0 必判缺数；流量 0 只把「相邻时段均非零的孤立零点」判缺数；
 *    连续 0（关闸）和真实零保留；非数值占位文本判缺数。判缺数的项写 null 并记录原因，
 *    不凭空补造数值；原 0 保留进 legacyZero 便于审计。
 * 3. 巡视隐患存量：按「业务日期」升序，无法解析/空缺的字段进 missingFields 单列，不填默认值。
 * 4. 最后重建派生表：调度待办由已复核水情记录推导，待调度条数两处读同一份明细。
 */
export type MigrationReport = {
  fromVersion: number
  toVersion: number
  migratedAt: string
  order: string[]
  hydrology: { total: number; converted: number; missingRows: { id: number; 记录编号: string; 观测时间: string; fields: { field: HydroFieldKey; reason: string }[] }[]; keptZeroRows: { id: number; 记录编号: string; fields: HydroFieldKey[] }[] }
  patrol: { total: number; missingRows: { id: number; 隐患编号: string; 业务日期: string; missing: string[] }[] }
  todos: number
}

function migrateV1ToV2(raw: Record<string, EntryRow[]>): { state: StoreState; report: MigrationReport } {
  const report: MigrationReport = {
    fromVersion: LEGACY_STORE_VERSION,
    toVersion: STORE_VERSION,
    migratedAt: new Date().toISOString(),
    order: ['1.升级存储壳到v2', '2.水情记录按观测时间升序回填并识别随手填零', '3.巡视隐患按业务日期升序补列缺项', '4.重建调度待办派生表并对账'],
    hydrology: { total: 0, converted: 0, missingRows: [], keptZeroRows: [] },
    patrol: { total: 0, missingRows: [] },
    todos: 0,
  }

  // —— 步骤 1：存储壳升级（未到这一步，后面几步一律不允许执行）——
  const entries: Record<string, EntryRow[]> = clone(raw)
  const state: StoreState = {
    version: STORE_VERSION,
    entries,
    floodTodos: [],
    hazards: [],
    rejectedHazards: [],
    hydroMeta: { token: null, outageStart: null, outageDemoStart: null, draft: null },
  }

  // —— 步骤 2：水情存量按观测时间升序迁移 ——
  const legacyHydro = [...(entries.hydrology ?? [])].sort((a, b) =>
    String(a['观测时间'] ?? '') < String(b['观测时间'] ?? '') ? -1 : 1,
  )
  const migratedHydro: HydroRecord[] = legacyHydro.map((row, index) => {
    const prev = legacyHydro[index - 1] ?? null
    const next = legacyHydro[index + 1] ?? null
    const verdict = classifyLegacyZero(row as Record<string, unknown>, prev, next)
    const observedAt = String(row['观测时间'] ?? '')
    const missingReasons = {} as HydroRecord['missingReasons']
    const sources = {} as HydroRecord['sources']
    const fields: HydroFieldKey[] = ['上游水位', '下游水位', '入库流量', '出库流量']
    const numericRow = { ...row } as Record<string, number | null>
    for (const field of fields) {
      const rawValue = row[field]
      const parsed = rawValue === undefined || rawValue === null || String(rawValue).trim() === '' ? null : Number(rawValue)
      if (verdict.missing.includes(field)) {
        numericRow[field] = null
        missingReasons[field] = verdict.reasons[field] ?? '存量迁移：判定为缺数，按空值留空待补测'
      } else if (parsed !== null && Number.isFinite(parsed)) {
        numericRow[field] = parsed
        sources[field] = '迁移回填'
      } else {
        numericRow[field] = null
        missingReasons[field] = '存量迁移：原值无法解析为数值，按缺数留空'
        verdict.missing.push(field)
      }
    }
    const hasMissing = verdict.missing.length > 0 || Object.keys(missingReasons).length > 0
    if (hasMissing) {
      report.hydrology.converted += 1
      report.hydrology.missingRows.push({
        id: Number(row.id),
        记录编号: String(row['记录编号'] ?? `HYDR-${row.id}`),
        观测时间: observedAt,
        fields: (Object.keys(missingReasons) as HydroFieldKey[]).map((field) => ({
          field,
          reason: missingReasons[field] ?? '缺测',
        })),
      })
    }
    if (verdict.keptZero.length > 0) {
      report.hydrology.keptZeroRows.push({
        id: Number(row.id),
        记录编号: String(row['记录编号'] ?? `HYDR-${row.id}`),
        fields: verdict.keptZero,
      })
    }
    return {
      ...row,
      观测时间: observedAt,
      slot: slotOf(observedAt),
      上游水位: numericRow['上游水位'],
      下游水位: numericRow['下游水位'],
      入库流量: numericRow['入库流量'],
      出库流量: numericRow['出库流量'],
      值守人员: String(row['值守人员'] ?? '历史数据迁移'),
      调度建议: '',
      复核结论: '',
      missingReasons,
      sources,
      legacyZero: verdict.missing.filter((field) => Number((row as Record<string, unknown>)[field]) === 0),
      balanceChecked: false,
      balancePassed: null,
      clientToken: null,
      status: hasMissing ? '待观测' : String(row.status ?? '待观测'),
      pending: true,
    } as HydroRecord
  })
  report.hydrology.total = migratedHydro.length
  entries.hydrology = migratedHydro

  // —— 步骤 3：巡视隐患按业务日期升序，缺项单列（v1 里没有 patrol 模块时为空）——
  const legacyPatrol = [...(entries.patrol ?? [])].sort((a, b) =>
    String(a['业务日期'] ?? '') < String(b['业务日期'] ?? '') ? -1 : 1,
  )
  const patrolRequired: (keyof HazardRecord)[] = ['隐患等级', '处理结论']
  const migratedPatrol: HazardRecord[] = legacyPatrol.map((row) => {
    const missingFields = patrolRequired.filter((field) => {
      const value = row[field as string]
      return value === undefined || String(value).trim() === ''
    }) as string[]
    if (missingFields.length > 0) {
      report.patrol.missingRows.push({
        id: Number(row.id),
        隐患编号: String(row['隐患编号'] ?? `HAZD-${row.id}`),
        业务日期: String(row['业务日期'] ?? ''),
        missing: missingFields,
      })
    }
    return {
      ...row,
      来源: row['来源'] ?? '现场登记',
      关联记录: row['关联记录'] ?? '',
      dedupeKey: row['dedupeKey'] ?? `${row['业务日期'] ?? ''}|${row['巡视点位'] ?? ''}|${row['隐患描述'] ?? ''}`,
      missingFields,
      rejectedDuplicate: false,
    } as HazardRecord
  })
  report.patrol.total = migratedPatrol.length
  entries.patrol = migratedPatrol
  state.hazards = migratedPatrol

  // —— 步骤 4：重建派生表（对账明细随口径一起生成）——
  let seq = 1
  state.floodTodos = migratedHydro
    .filter((row) => row.status === '已复核')
    .map((row) => ({
      id: seq,
      todoId: `DISP-${String(seq).padStart(4, '0')}`,
      status: '已复核',
      pending: false,
      abnormal: false,
      操作编号: `DISP-${String(seq).padStart(4, '0')}`,
      记录编号: row.记录编号,
      观测时间: row.观测时间,
      泄洪闸号: '1号泄洪闸',
      建议: row.调度建议,
      复核结论: row.复核结论,
      clientToken: null,
    }))
  seq += state.floodTodos.length
  void seq
  report.todos = state.floodTodos.length

  return { state, report }
}

function isV1Envelope(parsed: unknown): parsed is Record<string, EntryRow[]> {
  if (!parsed || typeof parsed !== 'object') return false
  if (Array.isArray(parsed)) return false
  const obj = parsed as Record<string, unknown>
  // v2 壳有 version 字段；v1 是 moduleKey → 数组的纯映射
  if ('version' in obj) return false
  const sample = Object.values(obj)[0]
  return Array.isArray(sample)
}

function freshState(): StoreState {
  return clone(buildSeedState())
}

let cache: StoreState | null = null

function persist(state: StoreState): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function loadState(): StoreState {
  if (cache) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = freshState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = freshState()
    persist(cache)
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (isV1Envelope(parsed)) {
      const { state, report } = migrateV1ToV2(parsed)
      cache = state
      persist(state)
      window.localStorage.setItem(MIGRATION_REPORT_KEY, JSON.stringify(report))
      return state
    }
    const state = parsed as StoreState
    if (state.version !== STORE_VERSION || !state.entries || !state.hydroMeta) {
      cache = freshState()
      persist(cache)
      return cache
    }
    cache = state
    return state
  } catch {
    cache = freshState()
    persist(cache)
    return cache
  }
}

export function saveState(state: StoreState): void {
  cache = state
  persist(state)
}

export function allRows(): Record<string, EntryRow[]> {
  return loadState().entries
}

export function listRows(key: string): EntryRow[] {
  return loadState().entries[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const state = loadState()
  state.entries = { ...state.entries, [key]: rows }
  saveState(state)
}

export function resetRows(key: string): EntryRow[] {
  const seed = freshState()
  const state = loadState()
  const rows = clone(seed.entries[key] ?? [])
  state.entries[key] = rows
  if (key === 'hydrology') {
    state.hydroMeta = clone(seed.hydroMeta)
    // 重置水情后调度待办必须按新明细重建，对账口径与清单一起回到初始
    // （种子待办为空，首次读取时由水情记录统一派生，避免两处条数对不上）。
    state.floodTodos = []
    state.entries.patrol = state.hazards.filter((item) => !item.rejectedDuplicate)
  }
  if (key === 'patrol') {
    state.hazards = clone(seed.hazards)
    state.rejectedHazards = []
    state.entries.patrol = clone(state.hazards)
  }
  saveState(state)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function readMigrationReport(): MigrationReport | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  const raw = window.localStorage.getItem(MIGRATION_REPORT_KEY)
  return raw ? (JSON.parse(raw) as MigrationReport) : null
}
