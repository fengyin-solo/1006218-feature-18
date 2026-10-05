import type { HydroFieldKey, HydroRecord } from './types'

/** 水情业务常量与纯函数：空值语义、时段归槽、存量零值识别、流量平衡、兜底取值都集中在这里。 */

export const HYDRO_MODULE_KEY = 'hydrology'
export const PATROL_MODULE_KEY = 'patrol'
export const STORE_VERSION = 2
export const LEGACY_STORE_VERSION = 1

/** 连续取数中断超过这个时长（分钟）就不允许提交观测，必须先补测再走调度。 */
export const OUTAGE_LIMIT_MINUTES = 60

/** 流量平衡允许偏差：|入库-出库| 不超过入库流量的 5% 视为平衡（纯前端演示口径）。 */
export const BALANCE_TOLERANCE = 0.05

/** 四个遥测项及展示单位。 */
export const HYDRO_FIELDS: { key: HydroFieldKey; unit: string; kind: 'level' | 'flow' }[] = [
  { key: '上游水位', unit: 'm', kind: 'level' },
  { key: '下游水位', unit: 'm', kind: 'level' },
  { key: '入库流量', unit: 'm³/s', kind: 'flow' },
  { key: '出库流量', unit: 'm³/s', kind: 'flow' },
]

export const HYDRO_STATUSES = ['待观测', '已观测', '已调度', '已复核'] as const
export const PATROL_STATUSES = ['待处理', '处理中', '已消除', '已挂账'] as const

/** 观测时段按整点归槽：同一时段重复上报按观测时间覆盖，只保留最后一次。 */
export function slotOf(observedAt: string | Date): string {
  const d = typeof observedAt === 'string' ? new Date(observedAt) : observedAt
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
}

export function nowSlot(): string {
  return slotOf(new Date())
}

export function minutesBetween(startIso: string, end: Date = new Date()): number {
  return Math.max(0, Math.round((end.getTime() - new Date(startIso).getTime()) / 60000))
}

/**
 * 存量记录里「把缺数写成 0」的识别规则（迁移用，规则固定、可复核）：
 * 1. 上游/下游水位 === 0：水位物理上不可能为 0，一律判定为缺数，留空（null）。
 * 2. 入库流量 === 0 且与它相邻的前一时段、后一时段入库流量都为非零：
 *    孤立零点，判定为缺数（汛期入库真为 0 时上下游时段也会接近 0，不会是孤立点）。
 * 3. 出库流量 === 0：只有在「同期入库流量非零且不存在任何相邻 0」时才判为缺数；
 *    连续多个时段出库为 0 视为真实关闸，保留为真零。
 * 4. 取值无法解析为数值（占位文本、空串）的，一律判为缺数。
 * 返回字段名 → 判定原因。未命中的 0 按真实零保留，页面与统计都把它当实数。
 */
export function classifyLegacyZero(
  row: Record<string, unknown>,
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): { missing: HydroFieldKey[]; keptZero: HydroFieldKey[]; reasons: Partial<Record<HydroFieldKey, string>> } {
  const missing: HydroFieldKey[] = []
  const keptZero: HydroFieldKey[] = []
  const reasons: Partial<Record<HydroFieldKey, string>> = {}

  const numeric = (raw: unknown): number | null => {
    if (raw === null || raw === undefined || String(raw).trim() === '') return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  }

  for (const { key, kind } of HYDRO_FIELDS) {
    const raw = row[key]
    const value = numeric(raw)
    if (value === null) {
      // 原本就不是数字（占位文本/空串）：早期就没有真数据。
      if (String(raw ?? '').trim() !== '') {
        missing.push(key)
        reasons[key] = `存量迁移：原值「${raw}」无法解析为数值，按缺数留空`
      }
      continue
    }
    if (value !== 0) continue

    if (kind === 'level') {
      missing.push(key)
      reasons[key] = '存量迁移：水位为 0 不符合物理意义，判定为缺数随手填零，按缺数留空待补测'
      continue
    }

    const prevValue = prev ? numeric(prev[key]) : null
    const nextValue = next ? numeric(next[key]) : null
    const isolated = prevValue !== 0 && nextValue !== 0
    if (key === '入库流量') {
      if (isolated) {
        missing.push(key)
        reasons[key] = '存量迁移：入库流量 0 为相邻时段均非零的孤立零点，判定为缺数随手填零，按缺数留空待补测'
      } else {
        keptZero.push(key)
      }
      continue
    }

    // 出库流量：孤立零判缺数；连续零（相邻任一为 0）视为真实关闸保留。
    if (isolated) {
      const inflow = numeric(row['入库流量'])
      if (inflow === null || inflow !== 0) {
        missing.push(key)
        reasons[key] = '存量迁移：出库流量 0 为孤立零点且同期入库非零，判定为缺数随手填零，按缺数留空待补测'
      } else {
        keptZero.push(key)
      }
    } else {
      keptZero.push(key)
    }
  }

  return { missing, keptZero, reasons }
}

/**
 * 流量平衡校验：空值不参与。
 * 入库或出库任一缺失时返回 skipped（页面显示「未参与校验」，绝不拿 0 或兜底值冒充）；
 * 两项都在时按 |Δ| ≤ 5% × 入库 判断是否平衡。
 */
export function checkBalance(
  record: Pick<HydroRecord, '入库流量' | '出库流量'>,
): { checked: boolean; passed: boolean | null; detail: string } {
  const inflow = record.入库流量
  const outflow = record.出库流量
  if (inflow === null || outflow === null) {
    const absent = [
      inflow === null ? '入库流量' : null,
      outflow === null ? '出库流量' : null,
    ]
      .filter(Boolean)
      .join('、')
    return { checked: false, passed: null, detail: `空值不参与平衡校验：${absent}缺测，本时段跳过校验` }
  }
  const delta = Math.abs(inflow - outflow)
  const passed = delta <= BALANCE_TOLERANCE * inflow
  return {
    checked: true,
    passed,
    detail: passed
      ? `流量平衡：入库 ${inflow}、出库 ${outflow}，偏差 ${delta.toFixed(1)} ≤ 允许 ${(BALANCE_TOLERANCE * 100).toFixed(0)}%`
      : `流量不平衡：入库 ${inflow}、出库 ${outflow}，偏差 ${delta.toFixed(1)} 超过允许 ${(BALANCE_TOLERANCE * 100).toFixed(0)}%`,
  }
}

/**
 * 调度建议的兜底取值：上游水位、入库流量缺失时，沿同一观测序列向前找最近一个
 * 非空实测/补测值兜底。找不到历史值就不允许兜底（返回 null，由调用方拦截调度）。
 */
export function fallbackValue(
  history: HydroRecord[],
  field: HydroFieldKey,
  observedAt: string,
): { value: number; fromId: string; fromTime: string } | null {
  const earlier = history
    .filter((row) => row.slot < slotOf(observedAt) && row[field] !== null)
    .sort((a, b) => (a.slot < b.slot ? 1 : -1))
  const hit = earlier[0]
  if (!hit) return null
  return { value: Number(hit[field]), fromId: hit.记录编号, fromTime: hit.观测时间 }
}

/** 页面展示用：空值显示「暂无数据」+ 原因；兜底值加角标。 */
export function displayCell(record: HydroRecord, field: HydroFieldKey): { text: string; tone: 'real' | 'empty' | 'fallback' | 'legacy' } {
  const value = record[field]
  if (value === null || value === undefined) {
    return { text: `暂无数据（${record.missingReasons[field] ?? '缺测'}）`, tone: 'empty' }
  }
  const source = record.sources[field]
  if (source === '兜底') {
    return { text: `${value}〔兜底〕`, tone: 'fallback' }
  }
  if (source === '迁移回填') {
    return { text: `${value}〔回填〕`, tone: 'legacy' }
  }
  return { text: String(value), tone: 'real' }
}

/** 伪遥测值：同一时段同一通道取值稳定（按时段散列），这样重试成功后值不会乱跳。 */
export function pseudoTelemetry(slot: string, field: HydroFieldKey): number {
  let hash = 0
  const seed = `${slot}|${field}`
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  }
  const frac = (hash % 1000) / 1000
  if (field === '上游水位') return Number((145 + frac * 6).toFixed(2))
  if (field === '下游水位') return Number((128 + frac * 3).toFixed(2))
  if (field === '入库流量') return Number(Math.round(420 + frac * 260))
  return Number(Math.round(400 + frac * 280))
}

export function fieldUnit(field: HydroFieldKey): string {
  return HYDRO_FIELDS.find((item) => item.key === field)?.unit ?? ''
}
