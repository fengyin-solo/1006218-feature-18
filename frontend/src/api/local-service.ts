import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/**
 * 环节只能按顺序推进：以 statuses 声明的链路为准，动作只能把记录推进到「当前状态的下一环」。
 * 跳级（比如待审批直接去结束泄洪）直接拦下，并明确告诉值班员缺哪一步。
 */
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const currentStage = meta.statuses.indexOf(current)
  const targetStage = meta.statuses.indexOf(target)
  if (currentStage < 0 || targetStage < 0 || targetStage !== currentStage + 1) {
    const nextAction = Object.entries(meta.actionTargets).find(([, status]) => status === meta.statuses[currentStage + 1])?.[0]
    return {
      ok: false,
      message: `环节不能跳级：「${action}」要走到「${target}」，但当前还停在「${current}」；请先走「${nextAction ?? meta.actions[currentStage] ?? '上一环节'}」再操作`,
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** CSV 单元格转义：空值（null/undefined）导出为「暂无数据」，绝不导出成 0。 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined || value === '') return '暂无数据'
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 导出与页面同口径：传入当前筛选条件，导出的就是页面上看到的这些行，条数一致。
 * 对账口径变化时明细清单一起变（同一份数据源，没有第二套口径）。
 */
export function exportEntries(
  key: string,
  filters: Record<string, string> = {},
  rowsOverride?: EntryRow[],
  columnsOverride?: string[],
  extraColumns?: string[],
): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const fields = columnsOverride ?? meta.fields
  const header = ['编号', ...fields, ...(extraColumns ?? []), '当前状态']
  const rows = rowsOverride ?? filterRows(listRows(key), filters)
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        ...fields.map((field) => csvCell(row[field])),
        ...(extraColumns ?? []).map((field) => csvCell(row[field])),
        row.status,
      ].join(','),
    )
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function downloadEntries(key: string, filters: Record<string, string> = {}): void {
  const { filename, content } = exportEntries(key, filters)
  downloadCsv(filename, content)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
