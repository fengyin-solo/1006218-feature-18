/**
 * 割接后（新系统）演示数据：按新领域模型直接播种，不属于存量迁移，不计入迁移报告。
 * 时间相对播种时刻生成，保证打开页面时能看到「连续中断超过 1 小时」的待补测场景。
 */
import type {
  ChannelState,
  DefectRecord,
  FloodRecord,
  HydrologyRecord,
  HydValue,
  MeasureKey,
} from './types'
import { MEASURE_KEYS } from './types'

function real(value: number): HydValue {
  return { value, reason: null, realZero: value === 0, fallback: false, fallbackFrom: null }
}

function missing(reason: HydValue['reason']): HydValue {
  return { value: null, reason, realZero: false, fallback: false, fallbackFrom: null }
}

function channelsOk(): Record<MeasureKey, ChannelState> {
  const map = {} as Record<MeasureKey, ChannelState>
  for (const key of MEASURE_KEYS) map[key] = { failingSince: null, lastReason: null }
  return map
}

export function buildCurrentRows(now: number): {
  hydrology: HydrologyRecord[]
  flood: FloodRecord[]
  defect: DefectRecord[]
} {
  const iso = (d: Date) => d.toISOString()
  const at = (hoursAgo: number, minutesAgo = 0) => new Date(now - hoursAgo * 3600_000 - minutesAgo * 60_000)

  // 06:00 完整实数观测，已调度待复核（兜底来源）
  const r1: HydrologyRecord = {
    id: 1,
    记录编号: 'HYDR-1001',
    观测时间: iso(at(6)),
    上游水位: real(246.8),
    下游水位: real(211.6),
    入库流量: real(1520),
    出库流量: real(1490),
    值守人员: '王建国',
    status: '已调度',
    abnormal: false,
    channels: channelsOk(),
    dispatchNote: {
      text: '四个量测项均为实数，无需兜底。',
      balanceGap: 30,
      balanceText: '流量平衡：入库 1520 − 出库 1490 = 30 m³/s，偏差在阈值 ±50 内。',
      fallbackFields: [],
    },
    review: null,
    revisions: [],
    createdAt: iso(at(6)),
    updatedAt: iso(at(5)),
  }

  // 08:00 入库流量缺测（链路中断 20 分钟，未超 1 小时，可提交）；调度建议可用 1001 兜底
  const inflowChannel: ChannelState = {
    failingSince: iso(at(2, 20)),
    lastReason: 'link_interrupt',
  }
  const r2Channels = channelsOk()
  r2Channels.入库流量 = inflowChannel
  const r2: HydrologyRecord = {
    id: 2,
    记录编号: 'HYDR-1002',
    观测时间: iso(at(4)),
    上游水位: real(247.1),
    下游水位: real(211.9),
    入库流量: missing('link_interrupt'),
    出库流量: real(1535),
    值守人员: '王建国',
    status: '已观测',
    abnormal: true,
    channels: r2Channels,
    dispatchNote: null,
    review: null,
    revisions: [],
    createdAt: iso(at(4)),
    updatedAt: iso(at(4)),
  }
  r2.dispatchNote = {
    text: `入库流量本次缺测（通信链路中断，数据未送达），调度建议按前一时段兜底取值 1520（兜底值，来源 HYDR-1001 @ ${r1.观测时间}），补测后以实测为准。`,
    balanceGap: null,
    balanceText: '流量平衡校验未执行：入库流量缺测，空值不参与平衡校验。',
    fallbackFields: ['入库流量'],
  }

  // 09:30 待观测：上游水位/入库流量连续中断 95 分钟（超 1 小时）——必须先补测
  const r3Channels = channelsOk()
  r3Channels.上游水位 = { failingSince: iso(at(1, 35)), lastReason: 'sensor_offline' }
  r3Channels.入库流量 = { failingSince: iso(at(1, 40)), lastReason: 'sensor_timeout' }
  const r3: HydrologyRecord = {
    id: 3,
    记录编号: 'HYDR-1003',
    观测时间: iso(at(1)),
    上游水位: missing('sensor_offline'),
    下游水位: real(212.2),
    入库流量: missing('sensor_timeout'),
    出库流量: real(1580),
    值守人员: '李秀兰',
    status: '待观测',
    abnormal: true,
    channels: r3Channels,
    dispatchNote: null,
    review: null,
    revisions: [],
    createdAt: iso(at(1)),
    updatedAt: iso(at(1)),
  }

  const flood: FloodRecord[] = [
    {
      id: 1,
      操作编号: 'FLOO-1001',
      泄洪闸号: '1号表孔',
      开启孔数: 2,
      泄洪流量: 900,
      下游预警: '蓝色',
      操作时间: iso(at(5)),
      操作人员: '张强',
      status: '已批准',
      abnormal: false,
      todos: [],
    },
    {
      id: 2,
      操作编号: 'FLOO-1002',
      泄洪闸号: '3号表孔',
      开启孔数: null,
      泄洪流量: null,
      下游预警: '黄色',
      操作时间: iso(at(0, 30)),
      操作人员: '张强',
      status: '待审批',
      abnormal: true,
      todos: [],
    },
  ]

  const defect: DefectRecord[] = [
    {
      id: 1,
      缺陷编号: 'DEFE-2001',
      设备名称: '2号机导轴承',
      缺陷描述: '上导瓦温偏高',
      缺陷等级: '重大',
      发现日期: '2026-10-04',
      处理期限: '2026-10-06',
      处理人员: '陈工',
      status: '处理中',
      abnormal: true,
      conclusion: null,
      duplicateOf: null,
      createdAt: iso(at(20)),
      updatedAt: iso(at(8)),
    },
    {
      id: 2,
      缺陷编号: 'DEFE-2002',
      设备名称: '坝顶位移测点TP-07',
      缺陷描述: '观测墩周边开裂',
      缺陷等级: '一般',
      发现日期: '2026-10-05',
      处理期限: '2026-10-12',
      处理人员: '',
      status: '待处理',
      abnormal: true,
      conclusion: null,
      duplicateOf: null,
      createdAt: iso(at(3)),
      updatedAt: iso(at(3)),
    },
  ]

  return { hydrology: [r1, r2, r3], flood, defect }
}
