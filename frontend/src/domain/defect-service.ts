/**
 * 缺陷处置业务规则：
 * - 登记去重：同一缺陷编号，或 设备名称+业务日期+缺陷描述 完全相同，视为重复登记；
 *   重复时只认第一次的取值，后到的按重复处理（不覆盖、不改状态），并在记录上标注 duplicateOf。
 * - 顺序闸门：待处理→处理中→已消除/已挂账（只走相邻一步），跳级拦下并说明缺哪一步。
 * - 确认消除时把处理结论回写现场巡视隐患清单（HazardItem）；导出清单与页面条数同源。
 * - 幂等：clientToken 重试提交直接回放，已落库不重复登记。
 */
import { loadState, updateState } from './store'
import type {
  DefectConclusion,
  DefectRecord,
  DefectStatus,
  HazardItem,
  SubmitOutcome,
} from './types'

export const DEFECT_FLOW: DefectStatus[] = ['待处理', '处理中', '已消除', '已挂账']
const TERMINAL_STATUSES: DefectStatus[] = ['已消除', '已挂账']

export type DefectInput = {
  缺陷编号: string
  设备名称: string
  缺陷描述: string
  缺陷等级: string
  发现日期: string
  处理期限: string
  处理人员: string
  reporter: string
  clientToken: string
}

function dedupKey(input: Pick<DefectInput, '设备名称' | '发现日期' | '缺陷描述'>): string {
  return [input.设备名称.trim(), input.发现日期.trim(), input.缺陷描述.trim()].join('|')
}

export function listDefects(): DefectRecord[] {
  return [...loadState().defect].sort((a, b) => b.发现日期.localeCompare(a.发现日期))
}

export function listHazards(): HazardItem[] {
  return [...loadState().hazards].sort((a, b) => a.业务日期.localeCompare(b.业务日期))
}

/** 登记缺陷：只认第一次取值，后到的重复登记被拦。 */
export function registerDefect(input: DefectInput, now: number = Date.now()): SubmitOutcome<DefectRecord> {
  if (!input.缺陷编号.trim()) return { ok: false, message: '缺陷编号不能为空' }
  if (!input.发现日期.trim()) return { ok: false, message: '业务日期（发现日期）不能为空' }

  const state = loadState()
  const seenToken = state.submitTokens[input.clientToken]
  if (seenToken && seenToken.module === 'defect') {
    const existed = state.defect.find((r) => r.id === seenToken.recordId)
    if (existed) {
      return {
        ok: true,
        mode: 'idempotent_replayed',
        record: existed,
        message: `上一次登记已落库（${existed.缺陷编号}），本次为重试回放，未重复登记。`,
      }
    }
  }

  const hitByNo = state.defect.find((r) => r.缺陷编号 === input.缺陷编号.trim())
  const key = dedupKey(input)
  const hitByContent = state.defect.find(
    (r) => dedupKey(r) === key && r.设备名称.trim() !== '',
  )
  const hit = hitByNo ?? hitByContent
  if (hit) {
    // 只认第一次取值：不覆盖既有记录，后到的按重复处理并留痕（统计与列表可查）
    let rejectionId = 0
    updateState((draft) => {
      rejectionId = draft.duplicateRejections.reduce((max, d) => Math.max(max, d.id), 0) + 1
      draft.duplicateRejections.push({
        id: rejectionId,
        recordNo: hit.缺陷编号,
        attemptedBy: input.reporter || '（未填报上报人）',
        at: new Date(now).toISOString(),
        reason: hitByNo
          ? `缺陷编号与既有记录 ${hit.缺陷编号} 相同`
          : `设备名称+业务日期+缺陷描述与 ${hit.缺陷编号} 完全相同`,
      })
      draft.submitTokens[input.clientToken] = {
        module: 'defect',
        recordId: hit.id,
        at: new Date(now).toISOString(),
      }
    })
    return {
      ok: true,
      mode: 'duplicate',
      record: hit,
      message: `重复登记被拦：与既有缺陷 ${hit.缺陷编号}（${hit.设备名称} / ${hit.发现日期}）重复，只认第一次的取值，本次按重复处理（重复留痕 #${rejectionId}）。`,
    }
  }

  let created: DefectRecord = null as unknown as DefectRecord
  updateState((draft) => {
    created = {
      id: draft.defect.reduce((max, r) => Math.max(max, r.id), 0) + 1,
      缺陷编号: input.缺陷编号.trim(),
      设备名称: input.设备名称.trim(),
      缺陷描述: input.缺陷描述.trim(),
      缺陷等级: input.缺陷等级.trim(),
      发现日期: input.发现日期.trim(),
      处理期限: input.处理期限.trim(),
      处理人员: input.处理人员.trim(),
      status: '待处理',
      abnormal: true,
      conclusion: null,
      duplicateOf: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    }
    draft.defect.push(created)
    draft.submitTokens[input.clientToken] = {
      module: 'defect',
      recordId: created.id,
      at: new Date(now).toISOString(),
    }
  })
  return { ok: true, mode: 'created', record: created, message: `缺陷 ${created.缺陷编号} 已登记，状态「待处理」。` }
}

export function advanceDefect(
  id: number,
  target: DefectStatus,
  now: number = Date.now(),
): { ok: boolean; message: string } {
  const state = loadState()
  const record = state.defect.find((r) => r.id === id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的缺陷` }
  const fromIdx = DEFECT_FLOW.indexOf(record.status)
  const toIdx = DEFECT_FLOW.indexOf(target)
  if (TERMINAL_STATUSES.includes(record.status)) {
    return { ok: false, message: `缺陷已${record.status}，终态不能再推进` }
  }
  if (toIdx <= fromIdx) {
    return { ok: false, message: `缺陷当前已是「${record.status}」，不能重复或回退推进` }
  }
  // 处理中可走向任一终态；待处理只能先到处理中，跳级（如直接已消除）一律拦下
  const adjacentOk = toIdx === fromIdx + 1 || (fromIdx === 1 && TERMINAL_STATUSES.includes(target))
  if (!adjacentOk) {
    const stepActions: Record<DefectStatus, string> = {
      待处理: '待处理',
      处理中: '派发处理',
      已消除: '确认消除',
      已挂账: '登记挂账',
    }
    const missing = DEFECT_FLOW.slice(fromIdx + 1, toIdx).map((s) => `${s}（先${stepActions[s]}）`)
    return {
      ok: false,
      message: `跳级被拦下：「${record.status}」不能直接到「${target}」，请先完成 ${missing.join('、')} 环节。`,
    }
  }

  let result: { ok: boolean; message: string } = { ok: true, message: '' }
  updateState((draft) => {
    const row = draft.defect.find((r) => r.id === id)
    if (!row) {
      result = { ok: false, message: `没有找到编号为 ${id} 的缺陷` }
      return
    }
    row.status = target
    row.abnormal = target !== '已消除'
    row.updatedAt = new Date(now).toISOString()
    result = { ok: true, message: `缺陷已推进到「${target}」` }
  })
  return result
}

export type ResolveInput = {
  result: string
  handler: string
}

/** 确认消除：处理结论回写现场巡视隐患清单。 */
export function resolveDefect(
  id: number,
  input: ResolveInput,
  now: number = Date.now(),
): { ok: boolean; message: string; hazardId?: number } {
  if (!input.result.trim()) return { ok: false, message: '请填写处理结论' }
  if (!input.handler.trim()) return { ok: false, message: '请填写处理人员' }

  const state = loadState()
  const record = state.defect.find((r) => r.id === id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的缺陷` }
  if (record.status !== '处理中') {
    return { ok: false, message: `跳级被拦下：只有「处理中」的缺陷能确认消除，当前为「${record.status}」。` }
  }

  let hazardId = 0
  let message = ''
  let okFlag = true
  updateState((draft) => {
    const row = draft.defect.find((r) => r.id === id)
    if (!row) {
      okFlag = false
      message = `没有找到编号为 ${id} 的缺陷`
      return
    }
    // 同一缺陷只回写一次（重复确认幂等）
    if (row.conclusion?.writtenHazardId) {
      hazardId = row.conclusion.writtenHazardId
      message = `处理结论此前已回写隐患清单（#${hazardId}），不重复登记。`
      return
    }
    hazardId = draft.hazards.reduce((max, h) => Math.max(max, h.id), 0) + 1
    const hazard: HazardItem = {
      id: hazardId,
      sourceType: 'defect_handle',
      sourceDefectNo: row.缺陷编号,
      业务日期: row.发现日期,
      设备名称: row.设备名称,
      缺陷描述: row.缺陷描述,
      缺陷等级: row.缺陷等级 || '（缺失，待补）',
      conclusion: input.result,
      handler: input.handler,
      handledAt: new Date(now).toISOString(),
    }
    draft.hazards.push(hazard)
    const conclusion: DefectConclusion = {
      result: input.result,
      handler: input.handler,
      handledAt: new Date(now).toISOString(),
      writtenHazardId: hazardId,
    }
    row.conclusion = conclusion
    row.处理人员 = input.handler
    row.status = '已消除'
    row.abnormal = false
    row.updatedAt = new Date(now).toISOString()
    message = `处理结论已回写现场巡视隐患清单（#${hazardId}），缺陷状态「已消除」。`
  })
  return { ok: okFlag, message, hazardId: hazardId || undefined }
}
