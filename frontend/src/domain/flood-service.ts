/**
 * 泄洪操作业务规则：
 * - 顺序闸门：待审批→已批准→泄洪中→已结束，跳级拦下并说明缺哪一步；
 * - 调度待办由水情复核结论回写产生，本模块只负责展示与「已处理」关闭；
 * - 空值（开启孔数/泄洪流量缺失）在页面上单独呈现，不当作 0。
 */
import { loadState, updateState } from './store'
import type { FloodRecord, FloodStatus } from './types'

export const FLOOD_FLOW: FloodStatus[] = ['待审批', '已批准', '泄洪中', '已结束']

export function listFlood(): FloodRecord[] {
  return [...loadState().flood].sort((a, b) => a.操作时间.localeCompare(b.操作时间))
}

export function advanceFlood(id: number, target: FloodStatus): { ok: boolean; message: string } {
  const state = loadState()
  const record = state.flood.find((r) => r.id === id)
  if (!record) return { ok: false, message: `没有找到编号为 ${id} 的泄洪操作` }
  const fromIdx = FLOOD_FLOW.indexOf(record.status)
  const toIdx = FLOOD_FLOW.indexOf(target)
  if (toIdx <= fromIdx) {
    return { ok: false, message: `泄洪操作当前已是「${record.status}」，不能重复或回退推进` }
  }
  if (toIdx !== fromIdx + 1) {
    const stepActions = ['提交审批', '开启泄洪', '结束泄洪']
    const missing = FLOOD_FLOW.slice(fromIdx + 1, toIdx).map((s, i) => `「${s}」(先${stepActions[fromIdx + i]})`)
    return {
      ok: false,
      message: `跳级被拦下：「${record.status}」不能直接到「${target}」，请先完成 ${missing.join('、')} 环节。`,
    }
  }
  let result: { ok: boolean; message: string } = { ok: true, message: '' }
  updateState((draft) => {
    const row = draft.flood.find((r) => r.id === id)
    if (!row) {
      result = { ok: false, message: `没有找到编号为 ${id} 的泄洪操作` }
      return
    }
    row.status = target
    result = { ok: true, message: `泄洪操作已推进到「${target}」` }
  })
  return result
}

export function resolveTodo(floodId: number, todoId: number): { ok: boolean; message: string } {
  let result: { ok: boolean; message: string } = { ok: true, message: '' }
  updateState((draft) => {
    const floodRow = draft.flood.find((f) => f.id === floodId)
    const todo = floodRow?.todos.find((t) => t.id === todoId)
    if (!todo) {
      result = { ok: false, message: '没有找到这条调度待办' }
      return
    }
    todo.handled = true
    result = { ok: true, message: `调度待办 #${todoId} 已处理关闭` }
  })
  return result
}
