import { SEED_ROWS as LEGACY_SEED_ROWS } from './seed'
import {
  BALANCE_TOLERANCE,
  HYDRO_STATUSES,
  PATROL_STATUSES,
  checkBalance,
  slotOf,
} from './hydrology'
import type {
  EntryRow,
  FloodTodo,
  HazardRecord,
  HydroFieldKey,
  HydroRecord,
  StoreState,
} from './types'

/**
 * v2 播种数据：水情记录改用时序化的真实数据，演示空值语义的每一种形态——
 * 实测、人工补测、缺测（带取数失败原因）、迁移回填（早期缺数写 0 被识别后留空）、
 * 真实零（关闸时段的出库 0，必须和缺测区分开）。
 * 观测时间相对「今天」生成，保证取数中断 1 小时拦截等与时钟有关的规则随时可演示。
 */

function dateAt(hour: number, minute = 0): string {
  const d = new Date()
  d.setHours(hour, minute, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:${pad(minute)}`
}

let hydroSeq = 1
function hydroRow(partial: Partial<HydroRecord> & { 观测时间: string }): HydroRecord {
  const id = hydroSeq
  hydroSeq += 1
  const status = (partial.status as HydroRecord['status']) ?? '待观测'
  const missingReasons = partial.missingReasons ?? {}
  const sources = partial.sources ?? {}
  const balance = checkBalance({
    入库流量: (partial.入库流量 ?? null) as number | null,
    出库流量: (partial.出库流量 ?? null) as number | null,
  })
  const fields: HydroFieldKey[] = ['上游水位', '下游水位', '入库流量', '出库流量']
  for (const field of fields) {
    if ((partial[field] ?? null) === null && !missingReasons[field]) {
      missingReasons[field] = missingReasons[field] ?? '上游遥测站通信中断，数据未上报'
    }
  }
  const record: HydroRecord = {
    id,
    status,
    pending: status !== HYDRO_STATUSES[HYDRO_STATUSES.length - 1],
    abnormal: false,
    记录编号: partial.记录编号 ?? `HYDR-${String(id).padStart(4, '0')}`,
    观测时间: partial.观测时间,
    slot: slotOf(partial.观测时间),
    上游水位: partial.上游水位 ?? null,
    下游水位: partial.下游水位 ?? null,
    入库流量: partial.入库流量 ?? null,
    出库流量: partial.出库流量 ?? null,
    值守人员: partial.值守人员 ?? '值班管理员',
    调度建议: partial.调度建议 ?? '',
    复核结论: partial.复核结论 ?? '',
    missingReasons,
    sources,
    legacyZero: partial.legacyZero ?? [],
    balanceChecked: balance.checked,
    balancePassed: balance.passed,
    clientToken: null,
  }
  return record
}

function buildHydroSeed(): HydroRecord[] {
  // 02:00 已复核，四项齐全，平衡。
  const r1 = hydroRow({
    观测时间: dateAt(2),
    上游水位: 146.82,
    下游水位: 129.1,
    入库流量: 520,
    出库流量: 515,
    status: '已复核',
    sources: { 上游水位: '实测', 下游水位: '实测', 入库流量: '实测', 出库流量: '实测' },
    missingReasons: {},
    调度建议: '按现状泄流，库水位平稳',
    复核结论: '数据齐全，流量平衡，同意调度',
  })
  // 03:00 已调度，四项齐全。
  const r2 = hydroRow({
    观测时间: dateAt(3),
    上游水位: 147.1,
    下游水位: 129.3,
    入库流量: 560,
    出库流量: 548,
    status: '已调度',
    sources: { 上游水位: '实测', 下游水位: '实测', 入库流量: '实测', 出库流量: '实测' },
    missingReasons: {},
    调度建议: `出库与入库偏差 ${Math.round(560 * BALANCE_TOLERANCE)}m³/s 以内，维持当前闸门开度`,
  })
  // 04:00 已观测待调度：入库/出库缺测（通信中断），调度建议将演示用前时段兜底。
  const r3 = hydroRow({
    观测时间: dateAt(4),
    上游水位: 147.42,
    下游水位: 129.6,
    入库流量: null,
    出库流量: null,
    status: '已观测',
    sources: { 上游水位: '实测', 下游水位: '实测' },
    missingReasons: {
      入库流量: '入库流量站 RTU 无应答（超时 30s）',
      出库流量: '出库流量计与网关链路中断',
    },
  })
  // 05:00 待观测：上游水位、入库流量缺测（传感器故障），演示空态与重试。
  const r4 = hydroRow({
    观测时间: dateAt(5),
    上游水位: null,
    下游水位: 129.8,
    入库流量: null,
    出库流量: 590,
    status: '待观测',
    sources: { 下游水位: '实测', 出库流量: '实测' },
    missingReasons: {
      上游水位: '上游水位计传感器故障（返回值超量程）',
      入库流量: '入库流量站 RTU 无应答（超时 30s）',
    },
  })
  // 2026-09-28 迁移回填记录：早期入库流量被随手填 0，识别为孤立零点后留空，待补测。
  const legacyTime = `2026-09-28 10:00`
  const r5 = hydroRow({
    观测时间: legacyTime,
    上游水位: 145.66,
    下游水位: 128.4,
    入库流量: null,
    出库流量: 430,
    status: '待观测',
    sources: { 上游水位: '迁移回填', 下游水位: '迁移回填', 出库流量: '迁移回填' },
    missingReasons: {
      入库流量: '存量迁移：入库流量 0 为相邻时段均非零的孤立零点，判定为缺数随手填零，按缺数留空待补测',
    },
    legacyZero: ['入库流量'],
    值守人员: '历史数据迁移',
  })
  // 2026-09-28 11:00 迁移记录：出库 0 是连续关闸的真实零，保留为实数。
  const legacyTime2 = `2026-09-28 11:00`
  const r6 = hydroRow({
    观测时间: legacyTime2,
    上游水位: 145.2,
    下游水位: 128.0,
    入库流量: 300,
    出库流量: 0,
    status: '已复核',
    sources: { 上游水位: '迁移回填', 下游水位: '迁移回填', 入库流量: '迁移回填', 出库流量: '迁移回填' },
    missingReasons: {},
    调度建议: '机组全停，出库真实为零，按关闸时段处理',
    复核结论: '出库 0 经核对为真实关闸，不是缺测',
    值守人员: '历史数据迁移',
  })
  void r1
  void r2
  void r3
  void r4
  void r5
  void r6
  return [r1, r2, r3, r4, r5, r6]
}

let hazardSeq = 100
function hazardRow(partial: Partial<HazardRecord> & { 隐患编号: string; 业务日期: string }): HazardRecord {
  const id = hazardSeq
  hazardSeq += 1
  const status = (partial.status as HazardRecord['status']) ?? '待处理'
  return {
    id,
    status,
    pending: status !== PATROL_STATUSES[2] && status !== PATROL_STATUSES[3],
    abnormal: false,
    隐患编号: partial.隐患编号,
    业务日期: partial.业务日期,
    巡视点位: partial.巡视点位 ?? '',
    隐患描述: partial.隐患描述 ?? '',
    隐患等级: partial.隐患等级 ?? '一般',
    处理结论: partial.处理结论 ?? '',
    来源: partial.来源 ?? '现场登记',
    关联记录: partial.关联记录 ?? '',
    dedupeKey: partial.dedupeKey ?? '',
    missingFields: partial.missingFields ?? [],
    rejectedDuplicate: false,
  }
}

function buildHazardSeed(): HazardRecord[] {
  // 历史隐患：早期纸质巡视本转录，缺「处理期限/处理人员」，按业务日期迁移并单列缺项。
  return [
    hazardRow({
      隐患编号: 'HAZD-0001',
      业务日期: '2026-09-26',
      巡视点位: '坝顶 0+200',
      隐患描述: '历史迁移：防浪墙局部裂缝（纸质巡视本转录，原卡漏填等级与期限）',
      隐患等级: '一般',
      来源: '现场登记',
      dedupeKey: '2026-09-26|坝顶 0+200|防浪墙裂缝',
      missingFields: ['隐患等级', '处理期限'],
      status: '待处理',
    }),
  ]
}

/** 构造全新的 v2 存储：其余 17 个通用模块沿用静态示例，水情/巡视/待办用领域数据。 */
export function buildSeedState(): StoreState {
  const entries: Record<string, EntryRow[]> = { ...LEGACY_SEED_ROWS }
  entries.hydrology = buildHydroSeed()
  entries.patrol = buildHazardSeed()
  return {
    version: 2,
    entries,
    // 调度待办是派生数据：首次加载时由水情记录同步生成，保证两处条数永远对得上。
    floodTodos: [],
    hazards: entries.patrol as HazardRecord[],
    rejectedHazards: [],
    hydroMeta: { token: null, outageStart: null, outageDemoStart: null, draft: null },
  }
}

/** 迁移报告里每条水情记录的中间结构，迁移函数在 store 层消费。 */
export type LegacyHydroRow = EntryRow

/** 由已复核水情记录推导出的调度待办（首次加载/重置换数时调用）。 */
export function deriveFloodTodo(record: HydroRecord, seq: number): FloodTodo {
  return {
    id: seq,
    todoId: `DISP-${String(seq).padStart(4, '0')}`,
    status: '已复核',
    pending: false,
    abnormal: false,
    操作编号: `DISP-${String(seq).padStart(4, '0')}`,
    记录编号: record.记录编号,
    观测时间: record.观测时间,
    泄洪闸号: '1号泄洪闸',
    建议: record.调度建议,
    复核结论: record.复核结论,
    clientToken: null,
  }
}
