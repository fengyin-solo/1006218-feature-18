/**
 * 汛期业务域的浏览器持久化。
 * 与老脚手架的 hydropower-plant-om:entries 分开存，互不影响。
 */
import { runMigration } from './migration'
import { buildCurrentRows } from './seed-current'
import type { DomainState } from './types'

const STORAGE_KEY = 'hydropower-plant-om:domain-v1'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: DomainState | null = null

/**
 * 全新播种 = 存量迁移（老数据，8xxx 编号，按业务日期回填）+ 割接后当值演示数据（1xxx 编号）。
 * 迁移报告只统计存量部分，当值演示数据不属于迁移。
 */
function seed(): DomainState {
  const { state } = runMigration(null)
  const current = buildCurrentRows(Date.now())
  return {
    ...state,
    hydrology: [...state.hydrology, ...current.hydrology],
    flood: [...state.flood, ...current.flood],
    defect: [...state.defect, ...current.defect],
    hazards: [],
    duplicateRejections: state.duplicateRejections ?? [],
    submitTokens: {},
  }
}

export function loadState(): DomainState {
  if (cache) return cache
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = seed()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DomainState
      // 老版本数据：按新版本重新迁移一次（幂等）
      const { state } = runMigration(parsed)
      cache = state
      persist(state)
      return cache
    } catch {
      // 损坏的数据落到全新迁移，不让页面白屏
    }
  }
  cache = seed()
  persist(cache)
  return cache
}

export function persist(state: DomainState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function updateState(mutate: (draft: DomainState) => void): DomainState {
  const next = clone(loadState())
  mutate(next)
  persist(next)
  return next
}

export function resetDomain(): DomainState {
  const fresh = seed()
  persist(fresh)
  return fresh
}

export function domainStorageKey(): string {
  return STORAGE_KEY
}
