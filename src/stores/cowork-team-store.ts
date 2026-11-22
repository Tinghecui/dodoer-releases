import { create } from "zustand"
import type { CoworkTeamStatus, CoworkTeamSummary } from "@/lib/cowork/team"

// CoTeam 的会话分享（#1230）：工作界面里「团队功能可不可用」和最近一次
// `summary` 的结果。只由 `@/lib/cowork/team` 的探测和轮询写；界面只读。
//
// `available` 为假时，分享、「分享给我的」、留言、部门视图这些入口都不画。
// 不落盘：刷新后重新探测。

export interface CoworkTeamState {
  /** 最近一次 `status` 说可用时的结果；不可用时是 null。 */
  status: CoworkTeamStatus | null
  /** 团队功能可用：`status` 调通了，没有 signedOut，applicable、enabled 都为真。 */
  available: boolean
  /** 探测过至少一次（不论结果）。 */
  probed: boolean
  /** 最近一次 `summary`；不可用时是 null。 */
  summary: CoworkTeamSummary | null
  setStatus: (status: CoworkTeamStatus) => void
  setSummary: (summary: CoworkTeamSummary) => void
  /** 探测失败、signedOut、开关关着：收起所有入口，丢掉旧数据。 */
  markUnavailable: () => void
  reset: () => void
}

const INITIAL = {
  status: null,
  available: false,
  probed: false,
  summary: null,
} as const

export const useCoworkTeamStore = create<CoworkTeamState>((set) => ({
  ...INITIAL,
  setStatus: (status) =>
    set((state) => ({
      status,
      available: true,
      probed: true,
      // 从不可用变成可用时，旧的 summary 已经没有了；可用期间的再探测保留它。
      summary: state.available ? state.summary : null,
    })),
  setSummary: (summary) => set((state) => (state.available ? { summary } : {})),
  markUnavailable: () =>
    set({ status: null, available: false, probed: true, summary: null }),
  reset: () => set({ ...INITIAL }),
}))

/** 团队功能可不可用（界面决定画不画入口只看这个）。 */
export function useCoworkTeamAvailable(): boolean {
  return useCoworkTeamStore((state) => state.available)
}
