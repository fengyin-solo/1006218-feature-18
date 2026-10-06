/**
 * 存量数据迁移：老系统（缺数随手填 0、字段全是字符串）→ 新领域模型（空值可分辨）。
 *
 * 迁移顺序（依赖方向决定，见 README「迁移方案」）：
 *   1. hydrology 水情记录 —— 先落观测主体，并产出「缺数清单」；
 *   2. flood 泄洪操作   —— 复核结论要回写到它的调度待办，必须在水情之后；
 *   3. defect 缺陷处置  —— 处理结论要回写现场巡视隐患清单，隐患清单随缺陷一起建。
 * 每个模块内部都按业务日期升序回填：水情/泄洪按操作-观测时间，缺陷按发现日期。
 *
 * 缺项识别规则（水情，由本方案定）：
 *   - 量测项裸 0（"0"/0，无单位、无确认标记）一律判为「早期把缺数写成 0」→ 置空，reason=legacy_zero，
 *     原值保留在 legacyRaw；真实的零无法与裸 0 区分，统一进入缺失清单由人工补测确认；
 *   - 无法 parseFloat 的脏值（如「通讯中断」）→ 置空，reason=legacy_unparsable；
 *   - 其余可解析数值按实数落库。
 * 缺陷/泄洪：空串、null、undefined、"--"、"null" 判为缺失字段，单独罗列，不伪造默认值。
 *
 * 迁移是幂等的：以 localStorage 版本号为准，已迁移（version 一致）就直接返回旧报告，
 * 不会重复登记；重试迁移只是拿到同一份报告。
 */
import { LEGACY_DUMP } from './legacy-dump'
import type {
  ChannelState,
  DefectRecord,
  DomainState,
  FloodRecord,
  HydValue,
  HydrologyRecord,
  MigrationIssue,
  MigrationReport,
  MeasureKey,
} from './types'
import { MEASURE_KEYS } from './types'

export const MIGRATION_VERSION = 1
export const MIGRATION_ORDER = ['hydrology', 'flood', 'defect'] as const

const MISSING_TOKENS = new Set(['', '--', 'null', 'undefined', '—', 'N/A', 'n/a'])

function cleanChannel(): ChannelState {
  return { failingSince: null, lastReason: null }
}

function emptyMeasure(reason: HydValue['reason'], legacyRaw: string | null): HydValue {
  return { value: null, reason, realZero: false, fallback: false, fallbackFrom: null, legacyRaw }
}

/** 水情量测项的缺数识别：返回 [HydValue, 是否列入缺失清单, issue kind]。 */
function convertMeasure(raw: unknown): { v: HydValue; missing: boolean; kind: 'legacy_zero' | 'legacy_unparsable' | null } {
  if (raw === null || raw === undefined) {
    return { v: emptyMeasure('legacy_zero', null), missing: true, kind: 'legacy_zero' }
  }
  const text = String(raw).trim()
  if (MISSING_TOKENS.has(text)) {
    return { v: emptyMeasure('legacy_unparsable', text), missing: true, kind: 'legacy_unparsable' }
  }
  // 裸 0：数值上等于 0 且没有任何单位/确认痕迹 —— 老系统缺数的典型写法
  if (text === '0' || Number(text) === 0) {
    return { v: emptyMeasure('legacy_zero', text), missing: true, kind: 'legacy_zero' }
  }
  const num = Number(text)
  if (!Number.isFinite(num)) {
    return { v: emptyMeasure('legacy_unparsable', text), missing: true, kind: 'legacy_unparsable' }
  }
  return {
    v: { value: num, reason: null, realZero: false, fallback: false, fallbackFrom: null, legacyRaw: text },
    missing: false,
    kind: null,
  }
}

function missingTextField(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true
  return MISSING_TOKENS.has(String(raw).trim())
}

function toNumberOrNull(raw: unknown): number | null {
  if (missingTextField(raw)) return null
  const num = Number(String(raw).trim())
  return Number.isFinite(num) ? num : null
}

function migrateHydrology(issues: MigrationIssue[]): HydrologyRecord[] {
  const sorted = [...LEGACY_DUMP.hydrology].sort((a, b) =>
    String(a['观测时间']).localeCompare(String(b['观测时间'])),
  )
  return sorted.map((row, idx) => {
    const missingFields: string[] = []
    const rawValues: string[] = []
    const kinds = new Set<'legacy_zero' | 'legacy_unparsable'>()
    const measures = {} as Record<MeasureKey, HydValue>
    for (const key of MEASURE_KEYS) {
      const { v, missing, kind } = convertMeasure(row[key])
      measures[key] = v
      if (missing) {
        missingFields.push(key)
        rawValues.push(v.legacyRaw ?? '')
        if (kind) kinds.add(kind)
      }
    }
    const recordNo = String(row['记录编号'])
    const observedAt = String(row['观测时间'])
    if (missingFields.length) {
      issues.push({
        module: 'hydrology',
        recordNo,
        businessDate: observedAt,
        // 一条记录同时含两类问题时按更严重的 unparsable 归类，但字段全部列出
        kind: kinds.has('legacy_unparsable') ? 'legacy_unparsable' : 'legacy_zero',
        fields: missingFields,
        rawValues,
      })
    }
    const channels = {} as Record<MeasureKey, ChannelState>
    for (const key of MEASURE_KEYS) channels[key] = cleanChannel()
    const status = String(row.status) as HydrologyRecord['status']
    return {
      id: 8000 + idx + 1,
      记录编号: recordNo,
      观测时间: observedAt,
      ...measures,
      值守人员: String(row['值守人员'] ?? ''),
      status,
      abnormal: Boolean(row.abnormal) || missingFields.length > 0,
      channels,
      dispatchNote: null,
      review: null,
      revisions: [],
      createdAt: `${observedAt.length === 10 ? observedAt : observedAt.slice(0, 10)}T00:00:00.000Z`,
      updatedAt: `${observedAt.length === 10 ? observedAt : observedAt.slice(0, 10)}T00:00:00.000Z`,
    }
  })
}

function migrateFlood(issues: MigrationIssue[]): FloodRecord[] {
  const sorted = [...LEGACY_DUMP.flood].sort((a, b) =>
    String(a['操作时间']).localeCompare(String(b['操作时间'])),
  )
  return sorted.map((row, idx) => {
    const missingFields: string[] = []
    for (const field of ['开启孔数', '泄洪流量'] as const) {
      if (toNumberOrNull(row[field]) === null) missingFields.push(field)
    }
    for (const field of ['泄洪闸号', '下游预警', '操作人员'] as const) {
      if (missingTextField(row[field])) missingFields.push(field)
    }
    if (missingFields.length) {
      issues.push({
        module: 'flood',
        recordNo: String(row['操作编号']),
        businessDate: String(row['操作时间']),
        kind: 'missing_fields',
        fields: missingFields,
      })
    }
    return {
      id: 8100 + idx + 1,
      操作编号: String(row['操作编号']),
      泄洪闸号: missingTextField(row['泄洪闸号']) ? '' : String(row['泄洪闸号']),
      开启孔数: toNumberOrNull(row['开启孔数']),
      泄洪流量: toNumberOrNull(row['泄洪流量']),
      下游预警: missingTextField(row['下游预警']) ? '' : String(row['下游预警']),
      操作时间: String(row['操作时间']),
      操作人员: missingTextField(row['操作人员']) ? '' : String(row['操作人员']),
      status: String(row.status) as FloodRecord['status'],
      abnormal: Boolean(row.abnormal) || missingFields.length > 0,
      todos: [],
    }
  })
}

function migrateDefect(issues: MigrationIssue[]): DefectRecord[] {
  const sorted = [...LEGACY_DUMP.defect].sort((a, b) =>
    String(a['发现日期']).localeCompare(String(b['发现日期'])),
  )
  return sorted.map((row, idx) => {
    const missingFields: string[] = []
    const textFields = ['设备名称', '缺陷描述', '缺陷等级', '处理期限', '处理人员'] as const
    for (const field of textFields) {
      if (missingTextField(row[field])) missingFields.push(field)
    }
    if (missingFields.length) {
      issues.push({
        module: 'defect',
        recordNo: String(row['缺陷编号']),
        businessDate: String(row['发现日期']),
        kind: 'missing_fields',
        fields: missingFields,
      })
    }
    const observedDate = String(row['发现日期'])
    return {
      id: 8200 + idx + 1,
      缺陷编号: String(row['缺陷编号']),
      设备名称: String(row['设备名称'] ?? ''),
      缺陷描述: String(row['缺陷描述'] ?? ''),
      缺陷等级: missingTextField(row['缺陷等级']) ? '' : String(row['缺陷等级']),
      发现日期: observedDate,
      处理期限: missingTextField(row['处理期限']) ? '' : String(row['处理期限']),
      处理人员: missingTextField(row['处理人员']) ? '' : String(row['处理人员']),
      status: String(row.status) as DefectRecord['status'],
      abnormal: Boolean(row.abnormal) || missingFields.length > 0,
      conclusion: null,
      duplicateOf: null,
      createdAt: `${observedDate}T00:00:00.000Z`,
      updatedAt: `${observedDate}T00:00:00.000Z`,
    }
  })
}

/** 执行迁移（幂等：state.migration.version 已是当前版本时不再重复登记）。 */
export function runMigration(prev: DomainState | null): { state: DomainState; report: MigrationReport } {
  if (prev?.migration && prev.migration.version === MIGRATION_VERSION) {
    return { state: prev, report: prev.migration }
  }
  const issues: MigrationIssue[] = []
  // 顺序固定：水情 → 泄洪 → 缺陷（隐患清单随缺陷建立）
  const hydrology = migrateHydrology(issues)
  const flood = migrateFlood(issues)
  const defect = migrateDefect(issues)
  const report: MigrationReport = {
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    order: [...MIGRATION_ORDER],
    counts: {
      hydrology: { migrated: hydrology.length, issues: issues.filter((i) => i.module === 'hydrology').length },
      flood: { migrated: flood.length, issues: issues.filter((i) => i.module === 'flood').length },
      defect: { migrated: defect.length, issues: issues.filter((i) => i.module === 'defect').length },
    },
    issues,
  }
  return {
    state: {
      hydrology,
      flood,
      defect,
      hazards: [],
      duplicateRejections: [],
      submitTokens: {},
      migration: report,
    },
    report,
  }
}
