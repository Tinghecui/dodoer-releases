import { create } from "zustand"
import type {
  CoworkTeamStatus,
  CoworkTeamSummary,
  TeamAgentInfo,
  TeamCommentUnreadSession,
  TeamSharedItem,
  TeamSharedVia,
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
  /**
   * 从「分享给我」打开时，那一条的 `via`（直接分享给我、分享给了我所在的哪些
   * 组）。只读条按它把所有成立的原因都列出来；没给（别处打开的）时视图自己
   * 去「分享给我」列表里找。
   */
  sharedVia?: TeamSharedVia[]
}

/**
 * 只读视图最近一次拉到的会话信息（#1515）：辅助面板的「会话详情」靠它画
 * 分享会话的卡片。`agent` 为 null 是对方取消了分享、或者我已经不在组里。
 */
export interface SharedSessionInfo {
  owner: string
  id: string
  agent: TeamAgentInfo | null
  /** 拉到的时间，「几分钟前」以它为参照。 */
  fetchedAt: number
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
  /** `viewing` 那个会话最近一次拉到的信息；还没拉到、没开视图时是 null。 */
  viewingInfo: SharedSessionInfo | null
  /**
   * 顶栏分享按钮：自己的会话（契约里的会话号）分享给了几个对象。键在 = 这次
   * 打开期间已经问过 `shares`（不再问）；值是 null = 还没回来或者没问到。
   */
  shareCounts: Record<string, number | null>
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
  /**
   * 只读视图拉到（或确认没有了，`agent` 给 null）会话信息时写进来；不是
   * 当前 `viewing` 的那条（已经换看别的、已经收起）不记。
   */
  setViewingAgent: (
    target: { owner: string; id: string },
    agent: TeamAgentInfo | null,
    fetchedAt: number
  ) => void
  /** 记下一个会话分享给了几个对象（null = 问过了、还没有数）；不可用时不记。 */
  setShareCount: (id: string, count: number | null) => void
}

const INITIAL = {
  status: null,
  available: false,
  probed: false,
  summary: null,
  viewing: null,
  viewingInfo: null,
  openCount: 0,
  shareCounts: {},
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
      viewingInfo: null,
      shareCounts: {},
    }),
  reset: () => set({ ...INITIAL }),
  openSharedSession: (target) =>
    set((state) =>
      state.available
        ? {
            viewing: target,
            // 换看另一条时丢掉上一条的；再点同一条时留着，等新一次拉到再换。
            viewingInfo:
              state.viewingInfo?.owner === target.owner &&
              state.viewingInfo.id === target.id
                ? state.viewingInfo
                : null,
            openCount: state.openCount + 1,
          }
        : {}
    ),
  closeSharedSession: () =>
    set((state) =>
      state.viewing || state.viewingInfo
        ? { viewing: null, viewingInfo: null }
        : {}
    ),
  setViewingAgent: (target, agent, fetchedAt) =>
    set((state) =>
      state.viewing?.owner === target.owner && state.viewing.id === target.id
        ? {
            viewingInfo: {
              owner: target.owner,
              id: target.id,
              agent,
              fetchedAt,
            },
          }
        : {}
    ),
  setShareCount: (id, count) =>
    set((state) =>
      state.available
        ? { shareCounts: { ...state.shareCounts, [id]: count } }
        : {}
    ),
}))

/** 团队功能可不可用（界面决定画不画入口只看这个）。 */
export function useCoworkTeamAvailable(): boolean {
  return useCoworkTeamStore((state) => state.available)
}

/**
 * 点到这些就算用户自己换了地方：侧栏里自己的会话、标签栏里的标签。只读视图
 * 外壳靠它收起视图，收件箱靠它判断等完要不要再盖上去，两处共用这一份。
 */
export const USER_NAV_TARGETS = "[data-conversation-id], [data-tab-id]"

/** 「分享给我」里点了一行：在主区域只读打开它。 */
export function openSharedItem(item: TeamSharedItem): void {
  useCoworkTeamStore.getState().openSharedSession({
    owner: item.owner,
    ownerLabel: item.ownerLabel,
    id: item.id,
    title: item.title,
    via: { kind: "shared" },
    sharedVia: item.via,
  })
}

/** `summary` 里自己（`mine`）或别人（按 `owner`）的这个会话还有几条未读留言。 */
export function commentUnreadCount(
  summary: CoworkTeamSummary | null,
  owner: string,
  id: string,
  mine: boolean
): number {
  const sessions = summary?.commentUnread.sessions ?? []
  const hit = sessions.find(
    (x) => x.id === id && (mine ? x.mine : x.owner === owner)
  )
  return hit?.count ?? 0
}

/**
 * 标了已读之后先在本地把这个会话的未读留言去掉（下一次轮询以服务器为准）。
 * 收件箱和留言栏都用它。
 */
export function withoutCommentSession(session: TeamCommentUnreadSession) {
  return (s: CoworkTeamSummary): CoworkTeamSummary => {
    const sessions = s.commentUnread.sessions.filter(
      (x) =>
        !(
          x.id === session.id &&
          x.mine === session.mine &&
          x.owner === session.owner
        )
    )
    const removed = s.commentUnread.sessions.length - sessions.length
    return {
      ...s,
      commentUnread: {
        total: Math.max(
          0,
          s.commentUnread.total - (removed > 0 ? session.count : 0)
        ),
        sessions,
      },
    }
  }
}
