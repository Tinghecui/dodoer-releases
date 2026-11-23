import { create } from "zustand"
import type {
  CoworkTeamStatus,
  CoworkTeamSummary,
  TeamSharedItem,
} from "@/lib/cowork/team"

// CoTeam 的会话分享（#1230）：工作界面里「团队功能可不可用」和最近一次
// `summary` 的结果。只由 `@/lib/cowork/team` 的探测和轮询写；界面只读。
//
// `available` 为假时，分享、「分享给我的」、留言、部门视图这些入口都不画。
// 不落盘：刷新后重新探测。

/**
 * 主区域里正在只读查看的同事会话（#1235 第 2 行）。从「分享给我」打开的是
 * `shared`；组长从「团队」档打开的是 `leader`，带组名（第 3 行接上）。
 */
export interface SharedSessionTarget {
  owner: string
  ownerLabel: string
  id: string
  /** 列表里已经知道的标题；拉到 `entries` 后以它的为准。 */
  title: string
  via: { kind: "shared" } | { kind: "leader"; groupName: string }
}

export interface CoworkTeamState {
  /** 最近一次 `status` 说可用时的结果；不可用时是 null。 */
  status: CoworkTeamStatus | null
  /** 团队功能可用：`status` 调通了，没有 signedOut，applicable、enabled 都为真。 */
  available: boolean
  /** 探测过至少一次（不论结果）。 */
  probed: boolean
  /** 最近一次 `summary`；不可用时是 null。 */
  summary: CoworkTeamSummary | null
  /** 主区域盖着的只读视图在看哪个会话；没开是 null。 */
  viewing: SharedSessionTarget | null
  /**
   * 每打开一次（含再点同一条）加一：外壳靠它在每次打开时都回到会话区域，
   * 只看 `viewing` 的话，再点同一条时它没变、不会再回。
   */
  openCount: number
  setStatus: (status: CoworkTeamStatus) => void
  setSummary: (summary: CoworkTeamSummary) => void
  /** 探测失败、signedOut、开关关着：收起所有入口，丢掉旧数据。 */
  markUnavailable: () => void
  reset: () => void
  /** 在主区域打开只读视图（不新增标签页）；已经开着别的就换成这个。 */
  openSharedSession: (target: SharedSessionTarget) => void
  /** 收起只读视图，下面的会话原样还在。 */
  closeSharedSession: () => void
}

const INITIAL = {
  status: null,
  available: false,
  probed: false,
  summary: null,
  viewing: null,
  openCount: 0,
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
  // 不可用（含 signedOut）时只读视图也一起收起。
  markUnavailable: () =>
    set({
      status: null,
      available: false,
      probed: true,
      summary: null,
      viewing: null,
    }),
  reset: () => set({ ...INITIAL }),
  openSharedSession: (target) =>
    set((state) =>
      state.available ? { viewing: target, openCount: state.openCount + 1 } : {}
    ),
  closeSharedSession: () =>
    set((state) => (state.viewing ? { viewing: null } : {})),
}))

/** 团队功能可不可用（界面决定画不画入口只看这个）。 */
export function useCoworkTeamAvailable(): boolean {
  return useCoworkTeamStore((state) => state.available)
}

/** 「分享给我」里点了一行：在主区域只读打开它。 */
export function openSharedItem(item: TeamSharedItem): void {
  useCoworkTeamStore.getState().openSharedSession({
    owner: item.owner,
    ownerLabel: item.ownerLabel,
    id: item.id,
    title: item.title,
    via: { kind: "shared" },
  })
}
