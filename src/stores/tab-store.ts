import { useMemo } from "react"
import {
  folderScope,
  useFolderTabsStore,
  type TabScope,
} from "@/stores/folder-tabs-store"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import {
  isConversationDeleted,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import {
  getFolderConversation,
  listOpenedTabs,
  saveOpenedTabs,
} from "@/lib/api"
import { resolveDefaultAgent } from "@/lib/resolve-default-agent"
import { formatConversationTitle } from "@/lib/conversation-title"
import {
  firstLeafId,
  isLayoutNode,
  leafIds,
  makeGroupId,
  neighborGroupId,
  normalizeTree,
  removeGroup,
  resizeSplitAt,
  singleGroupLayout,
  splitGroup,
  toggleOrientation,
  type LayoutNode,
  type SplitDirection,
} from "@/lib/tab-group-layout"
import {
  loadLastActiveContext,
  saveLastActiveContext,
  clearLastActiveContext,
} from "@/lib/last-active-context-storage"
import {
  buildNewConversationDraftStorageKey,
  clearMessageInputDraftV2,
  hasLiveComposerContent,
  loadMessageInputDraftV2,
  moveMessageInputDraft,
  sweepOrphanDraftKeys,
} from "@/lib/message-input-draft"
import { discardAskSelectionPrompts } from "@/lib/ask-selection-handoff"
import {
  claimParkedDraftQueue,
  hasStoredDraftQueue,
  moveStoredDraftQueue,
  parkStoredDraftQueue,
} from "@/lib/cowork/message-queue-storage"
import {
  MAX_CONVERSATION_TABS,
  TabRecency,
  pickTabsToEvict,
} from "@/lib/tab-limit"
import {
  batchCloseSlots,
  pushClosedTab,
  pushClosedTabBottom,
  takeClosedTabJustReopened,
  snapshotConversationTab,
} from "@/lib/closed-tab-stack"
import type {
  AgentType,
  ConversationChange,
  ConversationStatus,
  ConversationWorktreeSpec,
  DbConversationSummary,
  OpenedTab,
  TabsChanged,
} from "@/lib/types"

/**
 * Workspace tab state as a Zustand store. Replaces the former single
 * merged-value `TabContext`, whose value changed identity on every tab/status
 * update and re-rendered all ~20 consumers (including every keep-alive
 * `ConversationTabView`, which reads the context internally and so could not be
 * memo-blocked). Consumers now subscribe to the narrowest slice they render via
 * `useTabStore(selector)` / `useTabActions()`.
 *
 * The store owns all state, the cross-derive-stable `tabs` derivation, and every
 * mutation + orchestration action (hydration, debounced CAS save, cross-client
 * `tabs://changed` apply, sub-session summary seeding, provisional-agent
 * correction, post-hydration recovery). `TabRuntimeEffects` (in
 * `contexts/tab-context.tsx`) is a thin component that injects the React-land
 * dependencies (i18n labels, `activateConversationPane`, `acpDisconnect`, the
 * agent availability list) and drives the effects that need a React lifecycle
 * (platform subscriptions, timers, gates).
 */

export interface TabItemInternal {
  id: string
  kind: "conversation"
  folderId: number
  conversationId: number | null
  /** The runtime session key used by ConversationRuntimeContext.
   *  For new conversations this is a virtual (negative) ID that differs
   *  from the persisted `conversationId`. */
  runtimeConversationId?: number
  agentType: AgentType
  title: string
  isPinned: boolean
  workingDir?: string
  status?: ConversationStatus
  /**
   * Marks `agentType` as a system best-guess that should be replaced once
   * the agent list becomes fresh. True for draft tabs whose default came
   * from a stale localStorage seed or the AGENT_DISPLAY_ORDER fallback;
   * cleared by `confirmDraftAgent` (user click), `bindConversationTab`
   * (draft → real conversation), or the correction effect (fresh agent
   * list arrives). **Not persisted** to opened_tabs — hydrated drafts
   * default to false and are re-evaluated only when their agent_type is
   * no longer in the fresh sorted list (the `!sortedAvailableAgents.
   * includes(...)` branch of correction). Cowork fork (AI QA #436): the
   * conversation panel holds a draft's auto-connect while this is true, so
   * nothing may set it once the one-shot correction has run (see
   * `setDraftAgentFromFallback`). If correction never runs (e.g.
   * `acpListAgents()` keeps failing) the panel's `agentsLoaded` gate holds
   * the connect anyway.
   */
  agentTypeProvisional?: boolean
  /**
   * Marks a tab as "chat mode" (folderless). Set by `openChatModeTab`. It
   * survives the draft binding to its conversation (`bindConversationTab`
   * spreads the tab), alongside the hidden chat folder that then also drives
   * chat-mode chrome via `useIsActiveChatMode`; it is cleared when that
   * conversation is moved into a project (`alignConversationTabFolders`).
   * **Internal-only and never persisted** — opened_tabs does not carry it, so a
   * tab restored from the server never has it. While set on a draft, the draft
   * has no resolvable folder, so the composer hides the branch picker and shows
   * the "no-folder" chip.
   */
  isChat?: boolean
  /**
   * The draft wants to start in a worktree of its own (Paseo-style "new
   * workspace"): the branch chip records the choice here, and the FIRST send
   * creates the worktree, retargets the draft into it and only then delivers
   * the message (see `ConversationTabView.handleSend`). Nothing touches git
   * until that send, so closing or retargeting the draft has no side effect —
   * any retarget (folder change, chat mode) drops the intent, since it was
   * made against the previous folder. Drafts only; cleared by
   * `consumeDraftRetargets` and never set on a bound tab.
   */
  pendingWorktree?: ConversationWorktreeSpec
}

export type TabItem = TabItemInternal

interface DraftRetargetRequest {
  tabId: string
  expectedAgent: AgentType
  folderId: number
  workingDir: string
  agentType: AgentType
  provisional: boolean
  /** 换项目时照样会清掉新工作树选择；复用的草稿领回了关掉的草稿的选择
   *  （#1042）时，换完项目把它放回去。 */
  pendingWorktree?: ConversationWorktreeSpec
}

/**
 * What a "new conversation" open resolved to: the draft tab that ended up
 * serving the request — the freshly created one, or the target group's existing
 * draft it reused — and the identity that tab will be carrying once the open has
 * fully settled.
 *
 * `agentType`/`folderId` are a PROMISE, not necessarily the tab's state right
 * now: reusing a draft that belongs to another folder or agent retargets it
 * asynchronously (see `consumeDraftRetargets`), so the tab only takes on this
 * identity after its stale ACP session has been torn down. Callers that hand
 * work to the tab must gate on it rather than acting the moment they get the id.
 */
export interface OpenedDraftTarget {
  tabId: string
  agentType: AgentType
  folderId: number
}

/** i18n strings the store needs for seed titles, injected from `TabProvider`
 *  (the store itself is locale-agnostic). Defaults to the raw keys until the
 *  provider's first effect injects the translated values — a one-frame window
 *  that only touches cosmetic seed titles, which the `tabs` derivation then
 *  overwrites from `conversations`. */
export interface TabLabels {
  loadingConversation: string
  newConversation: string
  untitledConversation: string
}

export interface TabStoreState {
  rawTabs: TabItemInternal[]
  activeTabId: string | null
  previewReplacedTabIds: string[]
  draftRetargetRequests: DraftRetargetRequest[]
  tabsHydrated: boolean
  /**
   * IDEA-style split groups (device-local, like tile mode). `groupLayout` is
   * the splitter tree (leaves = groups); `groupOf` maps tab id → group id
   * (missing = first leaf); `groupSelection` is each group's selected tab
   * (the visible one in non-tiled mode); `tileByGroup` is the per-group tile
   * flag. Group state never enters the synced `opened_tabs` payload — it is
   * persisted to localStorage by `persistGroupState` and re-keyed to
   * canonical tab ids there so it survives restarts.
   */
  groupLayout: LayoutNode
  groupOf: Record<string, string>
  groupSelection: Record<string, string>
  tileByGroup: Record<string, boolean>
  /**
   * The group state of every tab view not on screen, by view key. While tabs
   * follow the folder each folder has its own view — its own split layout,
   * assignments, selection and tile flags — and the normal-mode view waits
   * here under "all"; the fields above always belong to the view on screen.
   * Device-local and persisted with them (see `persistGroupState`).
   */
  groupViews: Record<string, GroupView>
  /**
   * Transient cross-group tab drag (never persisted): the dragged tab, the
   * live pointer position, and the FOREIGN group currently under the pointer
   * (null while over the tab's own strip / no valid target). Drives the
   * drop-target highlight and the floating ghost chip; cleared on drag end.
   */
  tabDrag: {
    tabId: string
    title: string
    x: number
    y: number
    overGroupId: string | null
  } | null
  childSummaries: Map<number, DbConversationSummary>
  /**
   * Derived from `rawTabs` × `conversations` × `childSummaries`: tab titles and
   * status decorated from the live conversation list, with cross-derive
   * reference reuse so an update that touches no open tab keeps the array (and
   * every item's) identity stable. Recomputed on every relevant write and on
   * `conversations` change (see the module-level app-workspace subscription).
   */
  tabs: TabItemInternal[]
  /** Bumped on reconnect to re-run the child-summary reconcile. */
  reseedTick: number
  /** Bumped from a save's resolution to re-run the save effect when the local
   *  set moved while the save was in flight. */
  saveReconcileTick: number

  // ── Mutations ──────────────────────────────────────────────────────────────
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    pin?: boolean,
    title?: string,
    opts?: {
      /** rawTabs slot for a tab that needs a NEW slot (clamped); omitted =
       *  append. Reopening a closed tab passes the slot it was closed from. A
       *  conversation that is already open is focused where it is, and a
       *  preview still replaces the group's current preview in place. */
      index?: number
    }
  ) => void
  /**
   * `recordForReopen: false` closes without offering the tab to
   * `reopen_last_closed_tab`. Pass it whenever the tab is going away because
   * its conversation no longer exists — resurrecting it would mint a tab (and
   * an `opened_tabs` row) pointing at a deleted conversation.
   */
  closeTab: (tabId: string, options?: { recordForReopen?: boolean }) => void
  closeConversationTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType
  ) => void
  closeOtherTabs: (tabId: string) => void
  closeAllTabs: () => void
  closeTabsByFolder: (folderId: number) => void
  switchTab: (tabId: string) => void
  pinTab: (tabId: string) => void
  toggleGroupTile: (groupId: string) => void
  splitTab: (
    tabId: string,
    direction: SplitDirection,
    opts: { move: boolean }
  ) => void
  moveTabToGroup: (
    tabId: string,
    targetGroupId: string,
    opts?: {
      /** Position within the target group (clamped). Omitted = keep the tab's
       *  global rawTabs slot (menu moves — no reorder, no synced save). */
      index?: number
    }
  ) => void
  updateTabDrag: (drag: NonNullable<TabStoreState["tabDrag"]>) => void
  endTabDrag: () => void
  toggleGroupOrientation: (groupId: string) => void
  dissolveGroup: (groupId: string) => void
  unsplitAll: () => void
  reorderGroupTabs: (groupId: string, orderedTabs: TabItem[]) => void
  resizeGroupSplit: (
    splitId: string,
    handleIndex: number,
    boundaryFraction: number
  ) => void
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options?: {
      inheritFromActive?: boolean
      folderDefaultAgent?: AgentType | null
      targetGroup?: string
      /** Pin the draft to this agent, outranking BOTH the folder default and
       *  the inherit/fallback chain. For callers that must reproduce a specific
       *  agent (e.g. "ask about this selection" continues the conversation the
       *  text came from), not merely suggest one. */
      forceAgent?: AgentType
      /** rawTabs slot for the draft (clamped); omitted = append / leave put.
       *  Reopening a closed draft passes the slot it was closed from — and
       *  since the per-group singleton may hand it the group's EXISTING draft
       *  instead of a new tab, that draft is moved to the slot. */
      index?: number
      /** Move THIS unbound draft to the folder (the composer's folder picker)
       *  rather than resolving the target group's draft. Matters while tabs
       *  follow the folder, where the target folder may have a draft of its
       *  own. */
      retargetTabId?: string
      /** 复用已有草稿时保留它的工作树分支选择。默认会清掉（#837：「新建会话」
       *  给的是一份干净的草稿）；只给不是用户点「新建会话」的内部调用用，
       *  比如启动时回到上次的项目。 */
      keepDraftWorktree?: boolean
    }
  ) => OpenedDraftTarget
  openChatModeTab: (options?: {
    targetGroup?: string
    /** See `openNewConversationTab`'s `forceAgent`. */
    forceAgent?: AgentType
    /** See `openNewConversationTab`'s `retargetTabId`. */
    retargetTabId?: string
  }) => OpenedDraftTarget
  setChatDraftWorkingDir: (tabId: string, workingDir: string) => void
  /** Record (or clear, with `null`) a draft's "start in my own worktree"
   *  choice — see `TabItemInternal.pendingWorktree`. No-op on bound tabs. */
  setDraftWorktree: (
    tabId: string,
    spec: ConversationWorktreeSpec | null
  ) => void
  confirmDraftAgent: (tabId: string, agentType: AgentType) => void
  setDraftAgentFromFallback: (tabId: string, agentType: AgentType) => void
  bindConversationTab: (
    tabId: string,
    conversationId: number,
    agentType: AgentType,
    title: string,
    runtimeConversationId?: number,
    folderId?: number,
    workingDir?: string
  ) => void
  setTabRuntimeConversationId: (
    tabId: string,
    runtimeConversationId: number
  ) => void
  reorderTabs: (reorderedTabs: TabItem[]) => void
  consumeRemoteActivation: () => boolean
  onPreviewTabReplaced: (callback: (tabId: string) => void) => () => void

  // ── Orchestration (driven by TabRuntimeEffects) ──────────────────────────────
  hydrate: () => () => void
  runSaveEffect: () => void
  clearSaveTimer: () => void
  reconcileChildSummaries: () => void
  handleChildConversationChange: (change: ConversationChange) => void
  handleChildReconnect: () => void
  handleTabsChanged: (change: TabsChanged) => void
  refetchTabs: () => Promise<void>
  correctDraftAgents: () => void
  recoverActiveContext: () => void
  consumePreviewReplaced: () => void
  consumeDraftRetargets: () => void
  syncActiveFolderId: () => void
  persistLastActiveContext: () => void

  // ── Runtime dependency injection ─────────────────────────────────────────────
  setLabels: (labels: TabLabels) => void
  setSideEffects: (deps: {
    activateConversationPane: () => void
    acpDisconnect: (contextKey: string) => Promise<void>
  }) => void
  setAgentAvailability: (sortedTypes: AgentType[], fresh: boolean) => void
}

/** Legacy pre-groups tile flag — read once as the first group's default. */
const TILE_MODE_STORAGE_KEY = "workspace:tile-mode"
/** Device-local split-group state (layout tree, assignments, selection, tile
 *  flags), keyed by canonical tab ids. See `persistGroupState`. */
const TAB_GROUPS_STORAGE_KEY = "workspace:tab-groups:v1"

/**
 * 标签组记录按服务器分开存（#1063）：本机窗口和远端窗口是同一个 webview 源，
 * localStorage 共用。本机窗口沿用原来的 key（老数据不用迁移），远端窗口用
 * `…:remote-<id>`，不然远端窗口会恢复出本机窗口的草稿，把本机路径当 cwd 发给
 * 服务器上的智能体。写法同 folder-tabs-store 的 preferenceKey。
 */
function tabGroupsStorageKey() {
  const remoteId = getActiveRemoteConnectionId()
  return remoteId
    ? `${TAB_GROUPS_STORAGE_KEY}:remote-${remoteId}`
    : TAB_GROUPS_STORAGE_KEY
}

/**
 * 别的窗口（本机或别的服务器）标签组记录里还开着的草稿标签 id。草稿文字
 * （message-input-draft）存在共用的 localStorage 里、没按服务器分开，清理孤儿
 * 草稿文字时这些也要算活的，不然远端窗口一恢复标签就把本机窗口没发的文字删了，
 * 反过来也一样（#1063）。
 */
function draftIdsInOtherTabGroupBlobs(): Set<string> {
  const ids = new Set<string>()
  try {
    const current = tabGroupsStorageKey()
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (
        key &&
        key !== current &&
        (key === TAB_GROUPS_STORAGE_KEY ||
          key.startsWith(`${TAB_GROUPS_STORAGE_KEY}:remote-`))
      ) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      const raw = localStorage.getItem(key)
      const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      if (!parsed || typeof parsed !== "object") continue
      for (const draft of sanitizeDrafts(parsed.drafts)) ids.add(draft.id)
      if (typeof parsed.readFailedFiller === "string") {
        ids.add(parsed.readFailedFiller)
      }
    }
  } catch {
    /* ignore */
  }
  return ids
}

/** 上次 readPersistedGroupState 读的是哪个 key。store 在模块加载时就建好了，
 *  远端窗口那时还没拿到连接（远端 id 是异步来的），读的是本机那份；hydrate
 *  发现 key 变了就按现在的 key 重读。 */
let groupStateReadKey: string | null = null

/** Per-window/session identity stamped on every tab save and echoed back on
 *  `tabs://changed`, so this client ignores its own broadcast (echo
 *  suppression). Regenerated each load — it identifies the window for echo
 *  suppression, not the user, so nothing about it needs to persist. */
const TAB_ORIGIN = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

// ── React-land dependencies, injected by TabRuntimeEffects ─────────────────────
// Kept out of the reactive store state so updating them never notifies
// consumers; actions read them directly.
interface TabRuntime {
  labels: TabLabels
  activateConversationPane: () => void
  acpDisconnect: (contextKey: string) => Promise<void>
  sortedAvailableAgents: AgentType[]
  agentsFresh: boolean
}

function defaultRuntime(): TabRuntime {
  return {
    labels: {
      loadingConversation: "loadingConversation",
      newConversation: "newConversation",
      untitledConversation: "untitledConversation",
    },
    activateConversationPane: () => {},
    acpDisconnect: async () => {},
    sortedAvailableAgents: [],
    agentsFresh: false,
  }
}

let runtime: TabRuntime = defaultRuntime()

// ── Cross-client / coordination state (non-reactive; see original TabProvider) ──
// `version` — last workspace tab version this client observed/applied; every
//   save sends it as the CAS `expected_version`.
// `applyingRemote` — one-shot guard so applying a remote snapshot does not echo
//   back as a save.
// `pendingRemote` — a remote change that beat hydration; applied once hydrated.
// `lastSavedPayload` — JSON of the last persisted payload; draft-only changes
//   match it and skip the save.
let version = 0
let applyingRemote = false
let remoteActivationPending = false
let pendingRemote: TabsChanged | null = null
let lastSavedPayload: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
// Conversation tabs the SERVER is known to hold, as of the last snapshot this
// client read, applied, or successfully saved. It is the common ancestor of the
// three-way merge in `applyRemoteSnapshot`: without it, "absent from the
// snapshot" is ambiguous — a tab another client closed and a tab this client
// just opened look identical, and adopting the snapshot wholesale silently
// discards the second. That is not hypothetical: a server-side invalidation
// bumps the tab version WITHOUT broadcasting when it removes no row (see
// `delete_conversation_tabs_and_bump`), so a client can sit on a stale version
// indefinitely and have its next save rejected — which used to erase whatever
// tab that save was carrying, most visibly the draft that had just bound to a
// freshly-sent conversation.
let serverKnownTabKeys = new Set<string>()
// Last JSON written to TAB_GROUPS_STORAGE_KEY (no-op gate), plus the trailing
// debounce used while a split divider is being dragged.
let lastGroupBlob: string | null = null
let groupPersistTimer: ReturnType<typeof setTimeout> | null = null
// Device-local draft tabs read from the blob at store creation, consumed once by
// `hydrate` (kept out of store state: they are an input to hydration, not
// renderable state). Refreshed whenever `initialTabState()` runs.
let pendingRestoreDrafts: PersistedDraft[] = []
let pendingRestoreActiveDraft: string | null = null
// The canonical id of the conversation tab this device last focused (Cowork:
// focus is per device, see `hydrate`).
let pendingRestoreActiveConversation: string | null = null
// 本机已绑定、但服务器还没确认过的会话标签（#626）：首条消息发出后马上刷新，
// 防抖中的保存还没落地，服务器快照里没有它。只补这些，服务器确认过、后来在
// 别处关掉的标签不在里面，不会被复活。
let pendingRestoreUnsynced: PersistedUnsyncedConversation[] = []
// 标签页跟随文件夹时本机上次停在的项目（#741）。刷新后的当前项目原来只靠
// 选中的标签推出来，停在一个没开会话的项目里时就推不出来、落到别的项目。
// 由 restorePersistedFolderScope 在跟随模式恢复以后用一次。
let pendingRestoreActiveScope: TabScope | null = null
// 首次读取失败时补回的本机标签（未确认的会话标签和草稿）→ blob 里记下的位置
// （#626）。那时还没有服务器快照，标签排不回原位；第一个快照落地时
// applyRemoteSnapshot 按这里的位置把它们插回去，用完即清。
let restoredLocalIndex = new Map<string, number>()
let orphanDraftPruneRan = false
// True once a tab snapshot has actually been read from the backend (hydration,
// a refetch, or a remote change). Until then the open-tab set is UNKNOWN — a
// failed `listOpenedTabs` leaves it empty — and treating that emptiness as truth
// would prune every group assignment, collapse the layout, and write that ruin
// over the good blob (destroying the user's remembered layout on a transient
// backend hiccup). Both the invariant prune and the blob write wait for it; the
// session self-heals the moment any snapshot lands.
let tabsSnapshotLoaded = false
// 刷新后第一次读取服务器标签失败了、还没有快照落地（#626）。这段时间里本机
// 列表不完整（只有草稿和补回的未确认标签），版本号也可能还是默认的 0，不能保存。
let snapshotReadFailed = false
// 读取失败期间 blob 的基线（#785，见 persistLocalTabsWhileReadFailed）。
let readFailedBlobBaseline: string | null = null
// 读取失败时本机上次聚焦的会话所在的项目（从 blob 的 activeConversation 推出来）。
// 这时没有标签能推出当前项目，靠它让「新建会话」落回原来的项目（#785）。
let readFailedHomeFolder: number | null = null
// 读取失败、没有标签时启动流程自动补的那个草稿（runRecoveryOnce）。用户没拿它
// 发过消息之前不算用户选的：不记进 blob、不顶掉原来记的焦点（#785）。
let readFailedFillerDraftId: string | null = null
let readFailedRecovering = false
// blob 里记下的那个占位草稿（readFailedFiller）。占位草稿也写进 drafts，这样
// 用户在里面打了字没发就刷新，草稿 id 不变、输入框按 id 读回原来的字；靠这个
// 记号再刷新时仍认成占位，不算焦点（#785）。
let pendingRestoreFillerDraft: string | null = null
const childSummaryInFlight = new Set<number>()
const childSeedBuffer = new Map<
  number,
  { summary?: DbConversationSummary; status?: string; deleted?: boolean }
>()
let seedEpoch = 0
const previewReplacedCallbacks = new Set<(tabId: string) => void>()
let correctionRan = false
let recoveryRan = false
// Tracks the last `conversations` reference recomputeTabs derived against, so
// the module-level app-workspace subscription recomputes only when it changes.
let lastConversations = useAppWorkspaceStore.getState().conversations

function makeConversationTabId(
  folderId: number,
  agentType: AgentType,
  conversationId: number
): string {
  return `conv-${folderId}-${agentType}-${conversationId}`
}

function makeNewConversationTabId(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/** Identity of a conversation for tab sync: agent + conversation, deliberately
 *  WITHOUT the folder. A conversation has one tab at most, and the folder is a
 *  property of the conversation that can change under the tab (it was moved to
 *  another project): keyed by folder, the three-way merge would read a moved
 *  conversation's tab as "closed in one folder, opened in another" — and a
 *  close this client hadn't pushed yet would come back as a remote open. */
function conversationSyncKey(
  agentType: AgentType,
  conversationId: number
): string {
  return `${agentType}:${conversationId}`
}

/** Sync identity of a persisted tab (see `conversationSyncKey`). A bound draft
 *  keeps its volatile `new-*` id, so this is deliberately derived from the
 *  fields rather than read off `tab.id`. Drafts have no sync identity (they are
 *  device-local and never persisted) → `null`. */
function tabSyncKey(tab: TabItemInternal): string | null {
  if (tab.conversationId == null) return null
  return conversationSyncKey(tab.agentType, tab.conversationId)
}

function snapshotSyncKeys(items: OpenedTab[]): Set<string> {
  const keys = new Set<string>()
  for (const it of items) {
    if (it.conversation_id == null) continue
    keys.add(conversationSyncKey(it.agent_type, it.conversation_id))
  }
  return keys
}

function findTabIndexForConversation(
  tabs: TabItemInternal[],
  folderId: number,
  agentType: AgentType,
  conversationId: number
): number {
  const canonicalId = makeConversationTabId(folderId, agentType, conversationId)
  const idx = tabs.findIndex((t) => t.id === canonicalId)
  if (idx >= 0) return idx
  return tabs.findIndex(
    (t) =>
      t.folderId === folderId &&
      t.conversationId === conversationId &&
      t.agentType === agentType
  )
}

/** A requested slot clamped to a strip of `length`. */
function clampSlot(index: number, length: number): number {
  return Math.max(0, Math.min(index, length))
}

/** `tabs` with `tab` inserted at `index`, clamped to the array, or appended
 *  when no index is given. Reopening a closed tab passes the slot it was
 *  closed from, so it goes back where it was rather than to the end. */
function insertTab(
  tabs: TabItemInternal[],
  tab: TabItemInternal,
  index: number | undefined
): TabItemInternal[] {
  const at = index == null ? tabs.length : clampSlot(index, tabs.length)
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)]
}

/** `tabs` with the tab already at `tabId` moved to `index` (clamped) — the same
 *  array back when it is absent or already there, so callers can skip the write.
 *  Reopening a closed DRAFT lands here: the per-group draft singleton hands the
 *  reopen an existing draft instead of a new tab, and that draft still has to
 *  take the closed one's slot. */
function moveTabToSlot(
  tabs: TabItemInternal[],
  tabId: string,
  index: number
): TabItemInternal[] {
  const from = tabs.findIndex((t) => t.id === tabId)
  if (from < 0) return tabs
  const without = tabs.filter((t) => t.id !== tabId)
  if (clampSlot(index, without.length) === from) return tabs
  return insertTab(without, tabs[from], index)
}

/**
 * `raw` with the tabs sitting at `slots` rearranged into the order a reorder
 * callback asked for, or `null` when that list is not a permutation of exactly
 * those slots (and so must be ignored).
 *
 * A reorder callback is a request to MOVE tabs, never a new tab set. The
 * distinction matters because `Reorder.Group` emits the order it has measured
 * since its own last render and then drops, by reference, whatever is missing
 * from its current `values` — so mid-drag it can legitimately hand back a list
 * that is short, repeats an id, or carries a tab object from an earlier derive.
 * Resolving every entry back to the live `rawTabs` item by id keeps a drag
 * unable to close a tab, resurrect a closed one, or write a stale copy of a
 * tab's fields over the current one (a draft that bound to a conversation
 * mid-drag would otherwise go back to being an unbound draft).
 */
function permuteSlots(
  raw: TabItemInternal[],
  slots: number[],
  orderedTabs: TabItem[]
): TabItemInternal[] | null {
  if (orderedTabs.length !== slots.length) return null
  const slotIds = new Set(slots.map((i) => raw[i].id))
  const seen = new Set<string>()
  const ordered: TabItemInternal[] = []
  for (const tab of orderedTabs) {
    if (!slotIds.has(tab.id) || seen.has(tab.id)) return null
    seen.add(tab.id)
    const item = raw.find((t) => t.id === tab.id)
    if (!item) return null
    ordered.push(item)
  }
  const next = [...raw]
  slots.forEach((slot, k) => {
    next[slot] = ordered[k]
  })
  return next.every((tab, i) => tab === raw[i]) ? null : next
}

/** Field-wise equality for derived tab items. Backs the cross-derive reuse in
 *  the `tabs` derivation: an item whose every field matches the previous derive
 *  keeps its old reference, so downstream `Object.is` gates (consumers' memos)
 *  can short-circuit. TabItemInternal is a closed shape — keep this list in sync
 *  when adding fields. */
function sameDerivedTab(a: TabItemInternal, b: TabItemInternal): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.folderId === b.folderId &&
    a.conversationId === b.conversationId &&
    a.runtimeConversationId === b.runtimeConversationId &&
    a.agentType === b.agentType &&
    a.title === b.title &&
    a.isPinned === b.isPinned &&
    a.workingDir === b.workingDir &&
    a.status === b.status &&
    a.agentTypeProvisional === b.agentTypeProvisional &&
    a.isChat === b.isChat
  )
}

/** Build the persisted (synced) tab payload: conversation-bound tabs only
 *  (drafts are device-local), `position` = display index, and `is_active` set on
 *  the focused tab. Cowork: focus is per device and other clients no longer
 *  follow `is_active`; it is still written so a device with no focus of its own
 *  yet (a fresh browser) opens where the user last was (see `hydrate`). Used by
 *  both the save effect and remote-apply so their JSON is byte-identical for
 *  the no-op gate. */
function buildPersistItems(
  tabs: TabItemInternal[],
  activeTabId: string | null
): OpenedTab[] {
  return tabs
    .filter((tab) => tab.conversationId != null)
    .map((tab, i) => ({
      id: 0,
      folder_id: tab.folderId,
      conversation_id: tab.conversationId,
      agent_type: tab.agentType,
      position: i,
      is_active: tab.id === activeTabId,
      is_pinned: tab.isPinned,
    }))
}

/** Resolve a tab's group: its assignment when it points at a live leaf, else
 *  the first leaf. Exported for the strip / detail-panel render filters. */
export function groupOfTab(
  groupOf: Record<string, string>,
  layout: LayoutNode,
  tabId: string
): string {
  const assigned = groupOf[tabId]
  if (assigned != null && leafIds(layout).includes(assigned)) return assigned
  return firstLeafId(layout)
}

/** True when more than one group exists (the canonical tree keeps a split root
 *  only while it has ≥ 2 leaves). */
export function selectIsSplit(s: TabStoreState): boolean {
  return s.groupLayout.type !== "group"
}

/**
 * Unmount classifier for a conversation view: is it being REPARENTED (its tab
 * moved to another split group — remount, keep the ACP connection) or TORN
 * DOWN (disconnect)?
 *
 * Narrowly scoped on purpose. "The tab is still open" alone is NOT a reparent
 * marker: the whole conversation surface also unmounts with tabs left open
 * (mobile conversation→file pane switch, workbench route overlay), and those
 * must still disconnect — the idle sweep skips viewers, so a viewer left
 * attached leaks its subscription. Since group shells are flat siblings keyed
 * by group id, a surviving tab leaves its shell if and only if its shell group
 * (`shellGroupOfTab`) changed, which is exactly what this compares.
 */
export function isReparentUnmount(
  state: GroupResolutionState,
  tabId: string,
  renderedGroupId: string
): boolean {
  if (!state.rawTabs.some((tab) => tab.id === tabId)) return false
  return shellGroupOfTab(state, tabId) !== renderedGroupId
}

/** The conversation view each tab has mounted: the group it rendered under and
 *  the runtime session key it mounted on. Module scope rather than store state
 *  because it tracks React mounts, which nothing renders from. */
const mountedConversationViews = new Map<
  string,
  { groupId: string; runtimeConversationId: number }
>()

/** Record the conversation view `tabId` just mounted. The returned release
 *  drops only its own entry, so it can never unregister a successor. */
export function trackConversationView(
  tabId: string,
  groupId: string,
  runtimeConversationId: number
): () => void {
  const entry = { groupId, runtimeConversationId }
  mountedConversationViews.set(tabId, entry)
  return () => {
    if (mountedConversationViews.get(tabId) === entry) {
      mountedConversationViews.delete(tabId)
    }
  }
}

/**
 * Mount-side counterpart of `isReparentUnmount`: the runtime session key a
 * conversation view arriving for `tabId` must inherit from the view it
 * replaces, or null when a fresh key is right.
 *
 * React renders the arriving view BEFORE the departing one's cleanup runs, so
 * at this view's first render its predecessor is still registered, and that
 * cleanup is about to ask `isReparentUnmount` about its own group. This asks the
 * same question first. Yes means the session is kept, and the arriving view has
 * to carry on with it rather than key itself by the tab's row id — a tab that
 * started as a draft keeps its transcript under a virtual key for good. No
 * means the session is about to be removed (the desktop/mobile layout swap
 * remounts every view in one commit without moving any), so inheriting it
 * would strand the view on a key with nothing behind it; a virtual key never
 * fetches.
 */
export function reparentedViewRuntimeConversationId(
  state: GroupResolutionState,
  tabId: string
): number | null {
  const predecessor = mountedConversationViews.get(tabId)
  if (!predecessor) return null
  return isReparentUnmount(state, tabId, predecessor.groupId)
    ? predecessor.runtimeConversationId
    : null
}

/** Where a new tab should land: the explicit target when it's a live group,
 *  else the focused (active tab's) group. */
function resolveTargetGroup(
  st: Pick<TabStoreState, "activeTabId" | "groupOf" | "groupLayout">,
  explicit?: string
): string {
  if (explicit != null && leafIds(st.groupLayout).includes(explicit)) {
    return explicit
  }
  return st.activeTabId != null
    ? groupOfTab(st.groupOf, st.groupLayout, st.activeTabId)
    : firstLeafId(st.groupLayout)
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v
  }
  return out
}

function sanitizeBoolRecord(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v
  }
  return out
}

/** The blob's folder views (written while tabs follow the folder), parked
 *  until the mode is restored — or dropped if it comes back off. */
function sanitizeGroupViews(value: unknown): Record<string, GroupView> {
  const out: Record<string, GroupView> = {}
  if (typeof value !== "object" || value === null) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith(FOLDER_GROUP_VIEW_PREFIX)) continue
    if (typeof raw !== "object" || raw === null) continue
    const view = raw as Record<string, unknown>
    if (!isLayoutNode(view.layout)) continue
    out[key] = {
      layout: view.layout,
      groupOf: sanitizeStringRecord(view.assignments),
      selection: sanitizeStringRecord(view.selection),
      tileByGroup: sanitizeBoolRecord(view.tileByGroup),
      active: null,
    }
  }
  return out
}

/**
 * A device-local draft tab as stored in the group blob. Drafts never reach
 * `opened_tabs` (the lazy-conversation invariant: no DB row before the first
 * send), so without this a split group holding only a draft — the common
 * "conversation | new conversation" layout — lost its member on restart and
 * `normalizeTree` collapsed the whole group.
 *
 * `index` is the draft's position in `rawTabs` at save time, so restoring
 * splices it back among the conversation tabs instead of appending. `agentType`
 * is written ONLY for an explicitly-chosen agent (`agentTypeProvisional` is
 * falsy) — persisting a provisional pick would launder a cold-start guess into
 * a user choice, the same rule `last-active-context-storage` documents. Chat
 * drafts omit `workingDir`: their scratch dir is recreated eagerly on focus.
 */
interface PersistedDraft {
  id: string
  group: string
  index: number
  folderId: number
  isChat?: boolean
  workingDir?: string
  agentType?: AgentType
  pendingWorktree?: ConversationWorktreeSpec
}

interface PersistedUnsyncedConversation {
  folderId: number
  agentType: AgentType
  conversationId: number
  index: number
  // 预览标签（未固定）补回来也得是预览，不然以后打开别的预览不会替换它。
  isPinned: boolean
}

function sanitizeUnsynced(value: unknown): PersistedUnsyncedConversation[] {
  if (!Array.isArray(value)) return []
  const out: PersistedUnsyncedConversation[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.folderId !== "number" || !Number.isFinite(e.folderId)) continue
    if (
      typeof e.conversationId !== "number" ||
      !Number.isFinite(e.conversationId)
    )
      continue
    if (typeof e.agentType !== "string" || e.agentType.length === 0) continue
    const index =
      typeof e.index === "number" && Number.isFinite(e.index) && e.index >= 0
        ? Math.floor(e.index)
        : out.length
    out.push({
      folderId: e.folderId,
      agentType: e.agentType as AgentType,
      conversationId: e.conversationId,
      index,
      isPinned: typeof e.isPinned === "boolean" ? e.isPinned : true,
    })
  }
  return out
}

/** 刷新后补回的本机标签和它在 blob 里记下的位置（#626）。 */
interface RestoredLocalEntry {
  tab: TabItemInternal
  index: number
}

/**
 * 取出 blob 里记下的、服务器还没确认的会话标签（#626），只消费一次（列表随即
 * 清空）。快照里已有的、服务器确认过的都跳过。
 */
function collectRestoredUnsynced(present: Set<string>): RestoredLocalEntry[] {
  const pending = pendingRestoreUnsynced
  pendingRestoreUnsynced = []
  const out: RestoredLocalEntry[] = []
  for (const entry of pending) {
    const key = conversationSyncKey(entry.agentType, entry.conversationId)
    if (serverKnownTabKeys.has(key)) continue
    const id = makeConversationTabId(
      entry.folderId,
      entry.agentType,
      entry.conversationId
    )
    if (present.has(id)) continue
    present.add(id)
    out.push({
      index: entry.index,
      tab: {
        id,
        kind: "conversation",
        folderId: entry.folderId,
        conversationId: entry.conversationId,
        agentType: entry.agentType,
        title: runtime.labels.loadingConversation,
        isPinned: entry.isPinned,
      },
    })
  }
  return out
}

/**
 * 补回来的预览标签（未固定）占了它那一组的预览位置：同组、同一视图范围里别的
 * 预览标签（服务器快照带来的、另一台设备开的）去掉，和本机当时打开它时替换掉
 * 旧预览一样，不然同一组会留下两个预览（#626）。
 */
function dropRivalPreviews(
  tabs: TabItemInternal[],
  restored: TabItemInternal[]
): TabItemInternal[] {
  const st = useTabStore.getState()
  // 和 openTab 替换预览的范围一致：普通视图里同组的预览不分项目，互相替换；
  // 标签跟随文件夹时只在同一个项目里替换。
  const followFolder = useFolderTabsStore.getState().enabled
  const groupKey = (tab: TabItemInternal) => {
    const group = groupOfTab(st.groupOf, st.groupLayout, tab.id)
    return followFolder ? `${group}|${folderScope(tab.folderId)}` : group
  }
  const restoredIds = new Set(restored.map((tab) => tab.id))
  const claimed = new Set(
    restored.filter((tab) => !tab.isPinned).map((tab) => groupKey(tab))
  )
  if (claimed.size === 0) return tabs
  return tabs.filter(
    (tab) =>
      tab.isPinned || restoredIds.has(tab.id) || !claimed.has(groupKey(tab))
  )
}

/** 按 blob 里记下的位置从小到大插回，几种本机标签一起排，互相不挤乱。 */
function spliceAtRecordedIndex(
  tabs: TabItemInternal[],
  entries: RestoredLocalEntry[]
): TabItemInternal[] {
  const out = [...tabs]
  for (const { tab, index } of [...entries].sort((a, b) => a.index - b.index)) {
    out.splice(Math.min(index, out.length), 0, tab)
  }
  return out
}

/** Shape-check a persisted `pendingWorktree`; anything else is dropped. */
function sanitizeWorktreeSpec(
  value: unknown
): ConversationWorktreeSpec | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.branch !== "string" || v.branch.length === 0) return undefined
  if (v.kind === "checkout") return { kind: "checkout", branch: v.branch }
  if (v.kind === "branch_off") {
    return {
      kind: "branch_off",
      branch: v.branch,
      base: typeof v.base === "string" && v.base.length > 0 ? v.base : null,
      ...(v.auto_name === true ? { auto_name: true } : {}),
    }
  }
  return undefined
}

function sanitizeDrafts(value: unknown): PersistedDraft[] {
  if (!Array.isArray(value)) return []
  const out: PersistedDraft[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== "string" || e.id.length === 0) continue
    if (typeof e.group !== "string" || e.group.length === 0) continue
    if (typeof e.folderId !== "number" || !Number.isFinite(e.folderId)) continue
    const index =
      typeof e.index === "number" && Number.isFinite(e.index) && e.index >= 0
        ? Math.floor(e.index)
        : out.length
    out.push({
      id: e.id,
      group: e.group,
      index,
      folderId: e.folderId,
      ...(e.isChat === true ? { isChat: true } : {}),
      ...(typeof e.workingDir === "string" && e.workingDir.length > 0
        ? { workingDir: e.workingDir }
        : {}),
      ...(typeof e.agentType === "string" && e.agentType.length > 0
        ? { agentType: e.agentType as AgentType }
        : {}),
      ...(() => {
        const spec = sanitizeWorktreeSpec(e.pendingWorktree)
        return spec ? { pendingWorktree: spec } : {}
      })(),
    })
  }
  return out
}

/** Seed group state from the device-local blob (canonical tab ids — they match
 *  nothing until `hydrate` restores canonical-id tabs; `applyGroupInvariants`
 *  defers pruning until then). Falls back to a single group, seeding its tile
 *  flag from the legacy pre-groups key. The blob's draft entries are parked in
 *  module scope (not store state) for `hydrate` to splice back in. */
function readPersistedGroupState(): {
  groupLayout: LayoutNode
  groupOf: Record<string, string>
  groupSelection: Record<string, string>
  tileByGroup: Record<string, boolean>
  groupViews: Record<string, GroupView>
} {
  pendingRestoreDrafts = []
  pendingRestoreActiveDraft = null
  pendingRestoreActiveConversation = null
  pendingRestoreUnsynced = []
  pendingRestoreActiveScope = null
  pendingRestoreFillerDraft = null
  restoredLocalIndex = new Map()
  const fallback = () => ({
    groupLayout: singleGroupLayout() as LayoutNode,
    groupOf: {} as Record<string, string>,
    groupSelection: {} as Record<string, string>,
    tileByGroup: {} as Record<string, boolean>,
    groupViews: {} as Record<string, GroupView>,
  })
  if (typeof window === "undefined") return fallback()
  try {
    const storageKey = tabGroupsStorageKey()
    groupStateReadKey = storageKey
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed && isLayoutNode(parsed.layout)) {
        // Older blobs predate `drafts`/`activeDraft`/`activeConversation` —
        // all sanitize to empty.
        pendingRestoreDrafts = sanitizeDrafts(parsed.drafts)
        pendingRestoreActiveDraft =
          typeof parsed.activeDraft === "string" ? parsed.activeDraft : null
        pendingRestoreActiveConversation =
          typeof parsed.activeConversation === "string"
            ? parsed.activeConversation
            : null
        pendingRestoreUnsynced = sanitizeUnsynced(parsed.unsyncedConversations)
        pendingRestoreFillerDraft =
          typeof parsed.readFailedFiller === "string"
            ? parsed.readFailedFiller
            : null
        pendingRestoreActiveScope =
          parsed.activeScope === "global" ||
          (typeof parsed.activeScope === "number" &&
            Number.isInteger(parsed.activeScope) &&
            parsed.activeScope > 0)
            ? parsed.activeScope
            : null
        return {
          groupLayout: parsed.layout,
          groupOf: sanitizeStringRecord(parsed.assignments),
          groupSelection: sanitizeStringRecord(parsed.selection),
          tileByGroup: sanitizeBoolRecord(parsed.tileByGroup),
          groupViews: sanitizeGroupViews(parsed.views),
        }
      }
    }
    const seeded = fallback()
    if (localStorage.getItem(TILE_MODE_STORAGE_KEY) === "true") {
      seeded.tileByGroup[firstLeafId(seeded.groupLayout)] = true
    }
    return seeded
  } catch {
    return fallback()
  }
}

/** Write the group blob: conversation tabs re-keyed to canonical tab ids, draft
 *  tabs carried in `drafts` under their own (now restart-stable) ids so a
 *  draft-only group survives a restart. String-diffed no-op gate; never runs
 *  before hydration so a transient pre-hydration state can't clobber the good
 *  blob. */
function persistGroupState() {
  if (typeof window === "undefined") return
  const st = useTabStore.getState()
  // Both gates matter: pre-hydration the state is transient, and after a FAILED
  // hydration it is missing every conversation tab — writing either would
  // replace the good blob with a collapsed layout.
  if (!st.tabsHydrated) return
  if (!tabsSnapshotLoaded) {
    // 读取失败时本机开的标签还是要记下来，不然再刷新就找不回来（#785）。
    if (snapshotReadFailed) persistLocalTabsWhileReadFailed(st)
    return
  }
  readFailedBlobBaseline = null
  // The top level is always the normal-mode view, as a session with the mode
  // off reads it; folder views (while tabs follow the folder, or parked from
  // the last session until the stored mode is known) ride in `views`.
  const views: Record<string, GroupView> = {
    ...st.groupViews,
    [groupViewKey(useFolderTabsStore.getState())]: groupViewOnScreen(st),
  }
  const normal = views[ALL_GROUP_VIEW] ?? groupViewOnScreen(st)
  const canonicalId = (tab: TabItemInternal) =>
    tab.conversationId != null
      ? makeConversationTabId(tab.folderId, tab.agentType, tab.conversationId)
      : tab.id
  const canonicalSelection = (selection: Record<string, string>) => {
    const out: Record<string, string> = {}
    for (const [groupId, tabId] of Object.entries(selection)) {
      const tab = st.rawTabs.find((t) => t.id === tabId)
      if (tab) out[groupId] = canonicalId(tab)
    }
    return out
  }
  const assignments: Record<string, string> = {}
  const drafts: PersistedDraft[] = []
  const unsynced: PersistedUnsyncedConversation[] = []
  st.rawTabs.forEach((tab, index) => {
    const group = groupOfTab(normal.groupOf, normal.layout, tab.id)
    if (tab.conversationId != null) {
      assignments[canonicalId(tab)] = group
      const key = tabSyncKey(tab)
      if (key != null && !serverKnownTabKeys.has(key)) {
        unsynced.push({
          folderId: tab.folderId,
          agentType: tab.agentType,
          conversationId: tab.conversationId,
          index,
          isPinned: tab.isPinned,
        })
      }
      return
    }
    drafts.push(persistedDraftOf(tab, group, index))
  })
  // Each folder view lists only its own folder's tabs (drafts by their own
  // ids — the draft entries above carry the normal-mode group). A folder with
  // no tabs left has nothing to restore: it starts afresh like any new one.
  const folderViews: Record<string, unknown> = {}
  for (const [key, view] of Object.entries(views)) {
    if (key === ALL_GROUP_VIEW) continue
    const viewAssignments: Record<string, string> = {}
    for (const tab of st.rawTabs) {
      if (folderGroupViewKey(tab) !== key) continue
      viewAssignments[canonicalId(tab)] = groupOfTab(
        view.groupOf,
        view.layout,
        tab.id
      )
    }
    if (Object.keys(viewAssignments).length === 0) continue
    folderViews[key] = {
      layout: view.layout,
      assignments: viewAssignments,
      selection: canonicalSelection(view.selection),
      tileByGroup: view.tileByGroup,
    }
  }
  const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId)
  const folderTabs = useFolderTabsStore.getState()
  const blob = JSON.stringify({
    layout: normal.layout,
    assignments,
    selection: canonicalSelection(normal.selection),
    tileByGroup: normal.tileByGroup,
    drafts,
    activeDraft:
      activeTab && activeTab.conversationId == null ? activeTab.id : null,
    // Cowork: conversation focus is device-local too. `opened_tabs.is_active`
    // is only the fallback for a device that has none of its own yet.
    activeConversation:
      activeTab && activeTab.conversationId != null
        ? canonicalId(activeTab)
        : null,
    ...(unsynced.length > 0 ? { unsyncedConversations: unsynced } : {}),
    ...(Object.keys(folderViews).length > 0 ? { views: folderViews } : {}),
    // 跟随文件夹时本机停在哪个项目（#741），刷新后按它回去。
    ...(folderTabs.enabled ? { activeScope: folderTabs.scope } : {}),
  })
  if (blob === lastGroupBlob) return
  lastGroupBlob = blob
  try {
    localStorage.setItem(tabGroupsStorageKey(), blob)
  } catch {
    /* ignore */
  }
}

/** 一个草稿标签在 blob 里的记录。 */
function persistedDraftOf(
  tab: TabItemInternal,
  group: string,
  index: number
): PersistedDraft {
  return {
    id: tab.id,
    group,
    index,
    folderId: tab.folderId,
    ...(tab.isChat === true ? { isChat: true } : {}),
    // Chat drafts get a fresh scratch dir on focus; persisting the old one
    // would point the connection at a directory the GC may have removed.
    ...(tab.isChat !== true && tab.workingDir
      ? { workingDir: tab.workingDir }
      : {}),
    ...(tab.agentTypeProvisional ? {} : { agentType: tab.agentType }),
    ...(tab.isChat !== true && tab.pendingWorktree
      ? { pendingWorktree: tab.pendingWorktree }
      : {}),
  }
}

/**
 * 首次读取服务器标签失败、还没有快照落地时写 blob（#785）。这时本机列表缺了
 * 服务器上的会话标签，不能照常整份重写（会把分组、布局冲掉），所以只增不删：
 * 布局、分组选择、各项目视图和已有的分组归属都照原样保留，只把本机才知道的
 * 东西换成当前的——草稿、服务器没确认过的会话标签（这时全算）和本机焦点。
 * 不然故障期间新开的会话哪里都没记，再刷新就补不回来。
 *
 * 第一次调用只记下基线不写：用户没动过什么，磁盘上的 blob 就原样不动。
 */
function persistLocalTabsWhileReadFailed(st: TabStoreState) {
  let base: Record<string, unknown> = {}
  try {
    const raw = localStorage.getItem(tabGroupsStorageKey())
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (
      parsed &&
      typeof parsed === "object" &&
      isLayoutNode((parsed as Record<string, unknown>).layout)
    ) {
      base = parsed as Record<string, unknown>
    }
  } catch {
    /* 读不出来就当没有 */
  }
  const views: Record<string, GroupView> = {
    ...st.groupViews,
    [groupViewKey(useFolderTabsStore.getState())]: groupViewOnScreen(st),
  }
  const normal = views[ALL_GROUP_VIEW] ?? groupViewOnScreen(st)
  const layout = isLayoutNode(base.layout) ? base.layout : normal.layout
  const assignments = sanitizeStringRecord(base.assignments)
  const drafts: PersistedDraft[] = []
  const unsynced: PersistedUnsyncedConversation[] = []
  if (readFailedRecovering) {
    const opened = st.rawTabs.find((t) => t.id === st.activeTabId)
    if (opened && opened.conversationId == null) {
      readFailedFillerDraftId = opened.id
    }
  }
  const isFiller = (tab: TabItemInternal) =>
    tab.conversationId == null && tab.id === readFailedFillerDraftId
  let fillerId: string | null = null
  st.rawTabs.forEach((tab, position) => {
    // 启动时自动补的占位草稿也记下来（下面的 readFailedFiller 标着它）：用户在
    // 里面打了字没发就刷新，靠同一个 id 读回输入框里的字。它照旧不算焦点。
    if (isFiller(tab)) fillerId = tab.id
    const group = groupOfTab(normal.groupOf, layout, tab.id)
    // 补回来的标签记的是完整列表里的位置，沿用它；这时的列表不完整。
    const index = restoredLocalIndex.get(tab.id) ?? position
    if (tab.conversationId != null) {
      assignments[
        makeConversationTabId(tab.folderId, tab.agentType, tab.conversationId)
      ] = group
      const key = tabSyncKey(tab)
      if (key != null && !serverKnownTabKeys.has(key)) {
        unsynced.push({
          folderId: tab.folderId,
          agentType: tab.agentType,
          conversationId: tab.conversationId,
          index,
          isPinned: tab.isPinned,
        })
      }
      return
    }
    drafts.push(persistedDraftOf(tab, group, index))
  })
  const activeTab = st.rawTabs.find(
    (t) => t.id === st.activeTabId && !isFiller(t)
  )
  const folderTabs = useFolderTabsStore.getState()
  let activeDraft: string | null = null
  let activeConversation: string | null = null
  if (activeTab) {
    if (activeTab.conversationId == null) activeDraft = activeTab.id
    else
      activeConversation = makeConversationTabId(
        activeTab.folderId,
        activeTab.agentType,
        activeTab.conversationId
      )
  } else {
    // 没有活动标签（比如跟随模式切到的项目里一个本机标签都没有，或者活动的
    // 只是启动时自动补的草稿）时，原来记的
    // 焦点照旧留着：它多半是服务器上的会话，这时只是没读出来，清掉了恢复后就
    // 回不到它。只有它指的是本机才有、已经被关掉的标签时才清。
    const baseDraft =
      typeof base.activeDraft === "string" ? base.activeDraft : null
    if (baseDraft != null && drafts.some((d) => d.id === baseDraft)) {
      activeDraft = baseDraft
    }
    const baseConversation =
      typeof base.activeConversation === "string"
        ? base.activeConversation
        : null
    const closedLocal = sanitizeUnsynced(base.unsyncedConversations).some(
      (u) =>
        makeConversationTabId(u.folderId, u.agentType, u.conversationId) ===
          baseConversation &&
        !unsynced.some(
          (n) =>
            n.folderId === u.folderId &&
            n.agentType === u.agentType &&
            n.conversationId === u.conversationId
        )
    )
    if (baseConversation != null && !closedLocal) {
      activeConversation = baseConversation
    }
  }
  const merged: Record<string, unknown> = {
    ...base,
    layout,
    assignments,
    drafts,
    activeDraft,
    activeConversation,
  }
  if (unsynced.length > 0) merged.unsyncedConversations = unsynced
  else delete merged.unsyncedConversations
  if (fillerId != null) merged.readFailedFiller = fillerId
  else delete merged.readFailedFiller
  // 跟随模式开着时记下现在停在的项目；还没读出开关时保留原来记的（#741）。
  if (folderTabs.enabled) merged.activeScope = folderTabs.scope
  const blob = JSON.stringify(merged)
  if (readFailedBlobBaseline == null) {
    readFailedBlobBaseline = blob
    // 新补的占位草稿还是要写下去，不然用户在里面打的字刷新后就对不上了。
    if (fillerId == null || base.readFailedFiller === fillerId) return
  }
  if (blob === readFailedBlobBaseline) return
  readFailedBlobBaseline = blob
  lastGroupBlob = blob
  try {
    localStorage.setItem(tabGroupsStorageKey(), blob)
  } catch {
    /* ignore */
  }
}

/**
 * 快照读到了：上次故障期间启动补的占位草稿（#785）如果输入框里什么都没留，就
 * 不补回来，跟故障前一样不多出一个空的新会话；打了字的照常补回（不算焦点）。
 */
function dropEmptyFillerDraft() {
  const filler = pendingRestoreFillerDraft
  pendingRestoreFillerDraft = null
  if (filler == null) return
  const key = buildNewConversationDraftStorageKey(filler)
  if (loadMessageInputDraftV2(key) == null && !hasLiveComposerContent(key)) {
    pendingRestoreDrafts = pendingRestoreDrafts.filter((d) => d.id !== filler)
  }
}

/**
 * Splice the blob's draft tabs back among the freshly-hydrated conversation
 * tabs, returning the merged list plus the group assignments to seed. Consumed
 * once (the pending list is cleared), so a later refetch/reconnect never
 * resurrects a draft the user closed.
 *
 * 服务器还没确认的会话标签（#626）也在这里一起补回；返回它们的 id（调用方据此
 * 定保存基线）和每个补回标签记下的位置（首次读取失败时留给第一个快照用）。
 *
 * The agent is re-resolved exactly like any new draft unless the blob carried an
 * explicit (non-provisional) choice; the title comes from the current locale's
 * label rather than the stale persisted one.
 */
function mergeRestoredLocalTabs(restored: TabItemInternal[]): {
  tabs: TabItemInternal[]
  groupOf: Record<string, string>
  unsyncedIds: Set<string>
  recordedIndex: Map<string, number>
} {
  const pending = pendingRestoreDrafts
  pendingRestoreDrafts = []
  const groupOf: Record<string, string> = {}
  const seen = new Set(restored.map((tab) => tab.id))
  // 服务器还没确认的会话标签（#626）和草稿一起按 blob 位置插回：分两趟各插
  // 各的，会话 A、草稿、新会话、会话 B 会被排成 A、草稿、B、新会话。
  const unsynced = collectRestoredUnsynced(seen)
  const entries: RestoredLocalEntry[] = [...unsynced]
  for (const draft of pending) {
    if (seen.has(draft.id)) continue
    seen.add(draft.id)
    const resolved = draft.agentType
      ? { agentType: draft.agentType, provisional: false }
      : resolveAgentForFolder(draft.folderId, null)
    const tab: TabItemInternal = {
      id: draft.id,
      kind: "conversation",
      folderId: draft.folderId,
      conversationId: null,
      agentType: resolved.agentType,
      title: runtime.labels.newConversation,
      isPinned: true,
      workingDir: draft.workingDir,
      agentTypeProvisional: resolved.provisional,
      ...(draft.isChat === true ? { isChat: true } : {}),
      ...(draft.isChat !== true && draft.pendingWorktree
        ? { pendingWorktree: draft.pendingWorktree }
        : {}),
    }
    entries.push({ tab, index: draft.index })
    groupOf[draft.id] = draft.group
  }
  if (entries.length === 0) {
    return {
      tabs: restored,
      groupOf,
      unsyncedIds: new Set(),
      recordedIndex: new Map(),
    }
  }
  const unsyncedTabs = unsynced.map((entry) => entry.tab)
  const tabs = spliceAtRecordedIndex(
    dropRivalPreviews(restored, unsyncedTabs),
    entries
  )
  return {
    tabs,
    groupOf,
    unsyncedIds: new Set(unsyncedTabs.map((tab) => tab.id)),
    recordedIndex: new Map(entries.map((entry) => [entry.tab.id, entry.index])),
  }
}

/** Trailing-debounced persist for divider drags (per-frame ratio writes). */
function schedulePersistGroupState() {
  if (groupPersistTimer) clearTimeout(groupPersistTimer)
  groupPersistTimer = setTimeout(() => {
    groupPersistTimer = null
    persistGroupState()
  }, 300)
}

function shallowRecordEqual(
  a: Record<string, string> | Record<string, boolean>,
  b: Record<string, string> | Record<string, boolean>
): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  return ak.every((k) => a[k] === (b as Record<string, unknown>)[k])
}

/** View filtering is deliberately separate from rawTabs and the CAS payload. */
export function isTabInScope(tab: Pick<TabItem, "folderId">) {
  const state = useFolderTabsStore.getState()
  return !state.enabled || folderScope(tab.folderId) === state.scope
}

export function useVisibleConversationTabs() {
  const enabled = useFolderTabsStore((s) => s.enabled)
  const scope = useFolderTabsStore((s) => s.scope)
  return useTabStore(
    useShallow((s) =>
      enabled
        ? s.tabs.filter((tab) => folderScope(tab.folderId) === scope)
        : s.tabs
    )
  )
}

/** The on-screen view's layout. While tabs follow the folder that is the
 *  folder's own layout, already narrowed to its tabs once the tab set is
 *  known; narrowing here as well covers the moments before that. */
export function useVisibleConversationLayout() {
  const enabled = useFolderTabsStore((s) => s.enabled)
  const tabs = useVisibleConversationTabs()
  const layout = useTabStore((s) => s.groupLayout)
  const groupOf = useTabStore((s) => s.groupOf)
  return useMemo(
    () =>
      enabled
        ? normalizeTree(
            layout,
            new Set(tabs.map((tab) => groupOfTab(groupOf, layout, tab.id)))
          )
        : layout,
    [enabled, tabs, groupOf, layout]
  )
}

/**
 * Split-group state of a tab view that is not on screen. A view is the tabs
 * one layout arranges: every tab in normal mode, or one folder's while tabs
 * follow the folder — so splitting, resizing or unsplitting in one folder
 * leaves every other folder's layout alone. The view on screen lives in the
 * store's own group fields; a switch parks it here and loads the next one.
 */
export interface GroupView {
  layout: LayoutNode
  groupOf: Record<string, string>
  selection: Record<string, string>
  tileByGroup: Record<string, boolean>
  /** Its active tab when it was left, offered back on a folder switch. */
  active: string | null
}

/** Key of the normal-mode view (parked while tabs follow the folder). */
const ALL_GROUP_VIEW = "all"
const FOLDER_GROUP_VIEW_PREFIX = "scope:"

function groupViewKey(state: { enabled: boolean; scope: TabScope }): string {
  return state.enabled
    ? `${FOLDER_GROUP_VIEW_PREFIX}${state.scope}`
    : ALL_GROUP_VIEW
}

/** The folder view a tab belongs to while tabs follow the folder. */
function folderGroupViewKey(tab: Pick<TabItem, "folderId">): string {
  return `${FOLDER_GROUP_VIEW_PREFIX}${folderScope(tab.folderId)}`
}

function groupViewOnScreen(st: TabStoreState): GroupView {
  return {
    layout: st.groupLayout,
    groupOf: st.groupOf,
    selection: st.groupSelection,
    tileByGroup: st.tileByGroup,
    active: st.activeTabId,
  }
}

type GroupResolutionState = Pick<
  TabStoreState,
  "rawTabs" | "groupOf" | "groupLayout"
> &
  Partial<Pick<TabStoreState, "groupViews">>

/** What a tab's group resolves against: the view on screen for a tab it
 *  shows, else the tab's own folder view — parked, or not built yet and so
 *  still the normal-mode one it will be narrowed from. */
function groupViewOfTab(
  state: GroupResolutionState,
  tab: Pick<TabItem, "folderId">
): Pick<GroupView, "groupOf" | "layout"> {
  const onScreen = { groupOf: state.groupOf, layout: state.groupLayout }
  if (isTabInScope(tab)) return onScreen
  const views = state.groupViews ?? {}
  return views[folderGroupViewKey(tab)] ?? views[ALL_GROUP_VIEW] ?? onScreen
}

/**
 * The group shell a tab's conversation view renders in, whichever view is on
 * screen. A hidden tab stays in its own view's group, so switching folders
 * never moves a live conversation to another shell (which would remount it).
 */
export function shellGroupOfTab(
  state: GroupResolutionState,
  tabId: string
): string {
  const tab = state.rawTabs.find((t) => t.id === tabId)
  const view = tab
    ? groupViewOfTab(state, tab)
    : { groupOf: state.groupOf, layout: state.groupLayout }
  return groupOfTab(view.groupOf, view.layout, tabId)
}

/**
 * A folder's first view: the normal-mode arrangement narrowed to the folder's
 * tabs, keeping the group ids, so turning the mode on moves no tab. Until the
 * tab set is known nothing is narrowed — the conversations not loaded yet
 * still need their assignments — and the invariant pass narrows the copy once
 * the set arrives.
 */
function projectGroupView(
  base: GroupView,
  tabs: TabItemInternal[],
  tabSetKnown: boolean
): GroupView {
  if (!tabSetKnown) return { ...base, active: null }
  const groupOf: Record<string, string> = {}
  const live = new Set<string>()
  for (const tab of tabs) {
    const group = groupOfTab(base.groupOf, base.layout, tab.id)
    live.add(group)
    if (base.groupOf[tab.id] === group) groupOf[tab.id] = group
  }
  const layout = normalizeTree(base.layout, live)
  const leaves = new Set(leafIds(layout))
  const selection: Record<string, string> = {}
  for (const [groupId, tabId] of Object.entries(base.selection)) {
    if (leaves.has(groupId)) selection[groupId] = tabId
  }
  const tileByGroup: Record<string, boolean> = {}
  for (const [groupId, tiled] of Object.entries(base.tileByGroup)) {
    if (leaves.has(groupId)) tileByGroup[groupId] = tiled
  }
  return { layout, groupOf, selection, tileByGroup, active: null }
}

/**
 * Re-establish the group invariants of the view on screen after any tab/group
 * write (parked views are repaired when they are loaded):
 *   1. assignments only for the view's open tabs, pointing at live leaves;
 *   2. every leaf has ≥ 1 tab (normalizeTree collapses the rest);
 *   3. each group's selection is one of its members, and the focused group's
 *      selection IS the active tab;
 *   4. per-group tile flags only for live groups.
 * Pruning/normalizing waits until the open-tab set is KNOWN — before hydration
 * the blob-seeded canonical-id state matches nothing yet, and after a failed
 * snapshot fetch the set is empty for want of data, not because the tabs closed
 * (selection repair still runs either way, for the live drafts). Never touches
 * rawTabs/tabs — no recursion with `recomputeTabs`.
 */
function applyGroupInvariants() {
  const st = useTabStore.getState()
  const visibleTabs = st.rawTabs.filter(isTabInScope)
  if (
    useFolderTabsStore.getState().enabled &&
    st.activeTabId != null &&
    !visibleTabs.some((t) => t.id === st.activeTabId)
  ) {
    useTabStore.setState({ activeTabId: visibleTabs[0]?.id ?? null })
    applyGroupInvariants()
    return
  }
  const openIds = new Set(st.rawTabs.map((t) => t.id))
  // The view's own tabs: all of them in normal mode, the folder's otherwise.
  const viewIds = new Set(visibleTabs.map((t) => t.id))
  const tabSetKnown = st.tabsHydrated && tabsSnapshotLoaded

  let groupOf = st.groupOf
  let layout = st.groupLayout

  if (tabSetKnown) {
    let pruned: Record<string, string> | null = null
    const layoutLeaves = new Set(leafIds(layout))
    for (const [tabId, groupId] of Object.entries(groupOf)) {
      if (!viewIds.has(tabId) || !layoutLeaves.has(groupId)) {
        pruned = pruned ?? { ...groupOf }
        delete pruned[tabId]
      }
    }
    if (pruned) groupOf = pruned

    const firstLeaf = firstLeafId(layout)
    const liveGroups = new Set<string>()
    for (const tab of visibleTabs) {
      liveGroups.add(groupOf[tab.id] ?? firstLeaf)
    }
    layout = normalizeTree(layout, liveGroups)
    if (layout !== st.groupLayout) {
      // Leaves may have merged away — re-validate assignments against the
      // normalized tree so every entry still points at a live leaf.
      const nextLeaves = new Set(leafIds(layout))
      let revalidated: Record<string, string> | null = null
      for (const [tabId, groupId] of Object.entries(groupOf)) {
        if (!nextLeaves.has(groupId)) {
          revalidated = revalidated ?? { ...groupOf }
          delete revalidated[tabId]
        }
      }
      if (revalidated) groupOf = revalidated
    }
  }

  const leaves = leafIds(layout)
  const active =
    st.activeTabId != null && openIds.has(st.activeTabId)
      ? st.activeTabId
      : null
  const activeGroup = active ? groupOfTab(groupOf, layout, active) : null

  const selection: Record<string, string> = {}
  for (const groupId of leaves) {
    const members = visibleTabs.filter(
      (t) => groupOfTab(groupOf, layout, t.id) === groupId
    )
    if (members.length === 0) {
      // An empty leaf can only stand while the tab set is still unknown; keep
      // its seeded selection for the repair that follows the real snapshot.
      const kept = st.groupSelection[groupId]
      if (!tabSetKnown && kept != null) selection[groupId] = kept
      continue
    }
    if (activeGroup === groupId && active != null) {
      selection[groupId] = active
      continue
    }
    const current = st.groupSelection[groupId]
    selection[groupId] =
      current != null && members.some((t) => t.id === current)
        ? current
        : members[0].id
  }

  let tileByGroup = st.tileByGroup
  if (tabSetKnown) {
    const leafSet = new Set(leaves)
    let prunedTile: Record<string, boolean> | null = null
    for (const groupId of Object.keys(tileByGroup)) {
      if (!leafSet.has(groupId)) {
        prunedTile = prunedTile ?? { ...tileByGroup }
        delete prunedTile[groupId]
      }
    }
    if (prunedTile) tileByGroup = prunedTile
  }

  const changed =
    groupOf !== st.groupOf ||
    layout !== st.groupLayout ||
    tileByGroup !== st.tileByGroup ||
    !shallowRecordEqual(selection, st.groupSelection)
  if (changed) {
    useTabStore.setState({
      groupOf,
      groupLayout: layout,
      groupSelection: selection,
      tileByGroup,
    })
  }
  persistGroupState()
}

/** The tab to focus once the focused `lostId` is gone from a non-empty `next`
 *  (closed here, or closed on another client): the neighbor within its group;
 *  when the group emptied, the neighboring group's selected tab. While tabs
 *  follow the folder only the folder's tabs and groups count: a hidden
 *  neighbor would be replaced by the folder's first tab. (The layout is the
 *  folder's own, narrowed to its tabs once the tab set is known — narrowed here
 *  too for the moments before.) */
function focusAfterLosing(
  prevState: TabStoreState,
  next: TabItemInternal[],
  lostId: string
): string {
  const { groupOf, groupLayout, groupSelection } = prevState
  const followsFolder = useFolderTabsStore.getState().enabled
  const lostGroup = groupOfTab(groupOf, groupLayout, lostId)
  const inGroup = (t: TabItemInternal) =>
    isTabInScope(t) && groupOfTab(groupOf, groupLayout, t.id) === lostGroup
  const indexInGroup = prevState.rawTabs
    .filter(inGroup)
    .findIndex((t) => t.id === lostId)
  const groupAfter = next.filter(inGroup)
  if (groupAfter.length > 0) {
    return groupAfter[
      Math.min(Math.max(indexInGroup, 0), groupAfter.length - 1)
    ].id
  }
  const layout = followsFolder
    ? normalizeTree(
        groupLayout,
        new Set(
          prevState.rawTabs
            .filter(isTabInScope)
            .map((t) => groupOfTab(groupOf, groupLayout, t.id))
        )
      )
    : groupLayout
  const neighbor = neighborGroupId(layout, lostGroup)
  const neighborSelection = neighbor ? groupSelection[neighbor] : undefined
  return neighborSelection != null &&
    next.some((t) => t.id === neighborSelection && isTabInScope(t))
    ? neighborSelection
    : (next.find(isTabInScope) ?? next[0]).id
}

/** Focus a tab and realign the per-group selection with it. The shared path
 *  for every activeTabId-only write (rawTabs writes get the same invariant
 *  pass via `recomputeTabs`). */
function focusTab(tabId: string) {
  if (useTabStore.getState().activeTabId !== tabId) {
    useTabStore.setState({ activeTabId: tabId })
  }
  applyGroupInvariants()
}

/** A draft holding nothing to lose: no saved text, and its composer reports
 *  no unsaved typing or image attachment either. Cowork（#833）：排队区存着
 *  没发出去的消息（新工作树没建成时就是这样，输入框已经清空）也不算空。 */
function isBlankDraft(tab: TabItemInternal): boolean {
  if (tab.conversationId != null) return false
  const key = buildNewConversationDraftStorageKey(tab.id)
  return (
    loadMessageInputDraftV2(key) == null &&
    !hasLiveComposerContent(key) &&
    !hasStoredDraftQueue(tab.id)
  )
}

/**
 * One draft per group: close the blank drafts that share a group with
 * `keepId` in its own folder view (parked or on screen). While tabs follow
 * the folder, a draft moved into a folder can land beside that folder's own
 * draft; the moved one is what the user is typing in, so it stays. A draft
 * with content is kept too — two drafts beat a lost prompt — and so is the
 * one on screen, which the user may have just switched to.
 */
function closeBlankDraftsBeside(keepId: string) {
  const st = useTabStore.getState()
  const kept = st.rawTabs.find((t) => t.id === keepId)
  if (!kept || kept.conversationId != null) return
  const scope = folderScope(kept.folderId)
  const group = shellGroupOfTab(st, keepId)
  for (const tab of st.rawTabs) {
    if (
      tab.id !== keepId &&
      tab.id !== st.activeTabId &&
      isBlankDraft(tab) &&
      folderScope(tab.folderId) === scope &&
      shellGroupOfTab(st, tab.id) === group
    ) {
      useTabStore.getState().closeTab(tab.id, { recordForReopen: false })
    }
  }
}

/**
 * Turning the mode off puts every folder's drafts back in one layout, where a
 * group carries one draft: per group keep the active draft, else one with
 * content, else the first, and close the other blank ones (never one with
 * content).
 */
function closeBlankDraftsPerGroup() {
  const st = useTabStore.getState()
  const draftsByGroup = new Map<string, TabItemInternal[]>()
  for (const tab of st.rawTabs) {
    if (tab.conversationId != null) continue
    const group = groupOfTab(st.groupOf, st.groupLayout, tab.id)
    draftsByGroup.set(group, [...(draftsByGroup.get(group) ?? []), tab])
  }
  for (const drafts of draftsByGroup.values()) {
    if (drafts.length < 2) continue
    const keep =
      drafts.find((draft) => draft.id === st.activeTabId) ??
      drafts.find((draft) => !isBlankDraft(draft)) ??
      drafts[0]
    for (const draft of drafts) {
      if (draft !== keep && isBlankDraft(draft)) {
        useTabStore.getState().closeTab(draft.id, { recordForReopen: false })
      }
    }
  }
}

/**
 * Recompute the decorated `tabs` from `rawTabs` × `conversations` ×
 * `childSummaries`, reusing prior-derive references so an update touching no open
 * tab keeps the array identity stable (no consumer re-render). Called after every
 * rawTabs/childSummaries write, on `conversations` change, and when labels change.
 */
/**
 * The conversation row a tab of `conversationId` shows, when this client knows
 * it: a root from the sidebar list, or a sub-session's seeded summary.
 */
function knownConversationRow(
  conversationId: number,
  agentType: AgentType
): DbConversationSummary | undefined {
  const root = useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === conversationId)
  const row = root ?? useTabStore.getState().childSummaries.get(conversationId)
  return row && row.agent_type === agentType ? row : undefined
}

/**
 * The folder a conversation tab must be opened in: the folder its row is in
 * NOW when this client knows the row, else the one the caller named. Callers
 * often carry a folder id from an older snapshot — an automation run's
 * worktree, the closed-tab stack — and a conversation may have been moved to
 * another project since.
 */
function canonicalConversationFolder(
  folderId: number,
  conversationId: number,
  agentType: AgentType
): number {
  return knownConversationRow(conversationId, agentType)?.folder_id ?? folderId
}

/**
 * Invariant: a conversation tab lives in the folder its conversation row is in.
 *
 * The tab's folder is where the agent works (its connection's cwd is the
 * folder's path) and part of the tab's sync key, so a conversation moved to
 * another project — from this client, another one, or while this one was
 * offline — must take its open tabs along. Run on every derive, so it covers a
 * row upsert, the full refetch after a reconnect, an applied remote snapshot
 * (including a rejected save's reconcile) and hydration alike. Each tab is
 * re-pointed in place: same id, position, pin, group and focus; its working
 * dir is dropped so the connection re-derives it from the new folder (the
 * connection lifecycle reconnects on a working-dir change). A bound chat tab
 * whose row has become a regular project conversation also leaves chat mode.
 * A second tab for the same conversation goes.
 *
 * Tabs whose row this client doesn't know are left alone, and so are drafts;
 * nothing moves while the conversation list is being refetched.
 * The three-way merge in `applyRemoteSnapshot` keys tabs by conversation, not
 * folder (`conversationSyncKey`), so a re-pointed tab is the same tab to it
 * whether or not the server has re-pointed its own copy yet, and a close this
 * client has not pushed yet survives a move made elsewhere. A worktree removal
 * closes its tabs on the server before the conversations are refetched, so
 * nothing is "rescued" here.
 */
function alignConversationTabFolders() {
  const st = useTabStore.getState()
  const { conversations, conversationsLoading, allFolders } =
    useAppWorkspaceStore.getState()
  // Mid-refetch the rows may be older than the tab set — after a reconnect the
  // tab snapshot can land first, already showing a move this list predates —
  // and pointing tabs back at a stale folder would push that back to the
  // server. Wait for the refetch; its settling re-runs the derive.
  if (conversationsLoading) return
  if (conversations.length === 0 && st.childSummaries.size === 0) return
  if (!st.rawTabs.some((t) => t.conversationId != null)) return
  // Runs on every derive (status ticks included): one pass over the list, not
  // one per tab.
  const roots = new Map(conversations.map((c) => [c.id, c]))
  const rowOf = (tab: TabItemInternal) => {
    const id = tab.conversationId as number
    const row = roots.get(id) ?? st.childSummaries.get(id)
    return row && row.agent_type === tab.agentType ? row : undefined
  }
  let changed = false
  let activeTabId = st.activeTabId
  const next: TabItemInternal[] = []
  const keys = new Set<string>()
  for (const tab of st.rawTabs) {
    let item = tab
    if (tab.conversationId != null) {
      const row = rowOf(tab)
      if (row) {
        const rowFolderKind = allFolders.find(
          (f) => f.id === row.folder_id
        )?.kind
        const leavesChat =
          tab.isChat === true &&
          row.kind !== "chat" &&
          rowFolderKind != null &&
          rowFolderKind !== "chat"
        if (row.folder_id !== tab.folderId || leavesChat) {
          item = {
            ...tab,
            folderId: row.folder_id,
            ...(row.folder_id !== tab.folderId
              ? { workingDir: undefined }
              : {}),
            ...(leavesChat ? { isChat: false } : {}),
          }
          changed = true
        }
      }
      const key = tabSyncKey(item)
      if (key != null) {
        if (keys.has(key)) {
          // The conversation is already open in another tab: keep that one.
          const kept = next.find((t) => tabSyncKey(t) === key)
          if (activeTabId === tab.id) activeTabId = kept?.id ?? null
          changed = true
          continue
        }
        keys.add(key)
      }
    }
    next.push(item)
  }
  if (!changed) return
  // A remote apply may have armed the echo guard for the set it just
  // committed; this correction is ours and has to be pushed.
  applyingRemote = false
  lastSavedPayload = null
  useTabStore.setState({ rawTabs: next, activeTabId })
}

function recomputeTabs() {
  alignConversationTabFolders()
  const st = useTabStore.getState()
  const { rawTabs, childSummaries } = st
  const conversations = useAppWorkspaceStore.getState().conversations
  const prev = st.tabs

  let next: TabItemInternal[]
  if (conversations.length === 0 && childSummaries.size === 0) {
    next = rawTabs
  } else {
    const conversationMap = new Map<string, (typeof conversations)[number]>()
    for (const c of conversations) {
      conversationMap.set(`${c.folder_id}-${c.agent_type}-${c.id}`, c)
    }
    const prevById = prev.length ? new Map(prev.map((d) => [d.id, d])) : null
    next = rawTabs.map((tab) => {
      if (tab.conversationId != null) {
        const conv =
          conversationMap.get(
            `${tab.folderId}-${tab.agentType}-${tab.conversationId}`
          ) ?? childSummaries.get(tab.conversationId)
        if (conv) {
          const newTitle =
            formatConversationTitle(conv.title) ||
            runtime.labels.untitledConversation
          const newStatus = conv.status as ConversationStatus | undefined
          if (tab.title !== newTitle || tab.status !== newStatus) {
            const derived = { ...tab, title: newTitle, status: newStatus }
            const prevItem = prevById?.get(tab.id)
            return prevItem && sameDerivedTab(prevItem, derived)
              ? prevItem
              : derived
          }
        }
      }
      return tab
    })
  }

  if (
    prev.length === next.length &&
    next.every((item, i) => item === prev[i])
  ) {
    // Membership may have changed even when the derived output didn't (it
    // usually can't, but the invariant pass is cheap and self-no-ops).
    applyGroupInvariants()
    return
  }
  useTabStore.setState({ tabs: next })
  applyGroupInvariants()
}

/** Pick the agent + provisional flag for a new draft tab. Wraps the pure
 *  `resolveDefaultAgent` helper with tab-store-scoped lookups (folder default
 *  from the live app-workspace store, latest sorted types, fresh flag). */
function resolveAgentForFolder(
  folderId: number,
  inherit: AgentType | null,
  // `undefined` = look the folder default up; `null` = explicitly none.
  folderDefaultOverride?: AgentType | null
): { agentType: AgentType; provisional: boolean } {
  const folderDefault =
    folderDefaultOverride !== undefined
      ? folderDefaultOverride
      : (useAppWorkspaceStore.getState().folders.find((f) => f.id === folderId)
          ?.default_agent_type ?? null)
  return resolveDefaultAgent({
    folderDefault,
    inherit,
    sortedTypes: runtime.sortedAvailableAgents,
    fresh: runtime.agentsFresh,
  })
}

function makeReplacementDraftTab(preferred?: TabItemInternal): TabItemInternal {
  const { folders, allFolders } = useAppWorkspaceStore.getState()
  // A closing chat-mode tab (its hidden chat folder, or the in-memory draft
  // flag) must not seed the replacement draft — that folder is hidden from
  // folder lists and has no real project cwd. Fall back to a real folder.
  // Detection reads `allFolders` (the in-memory draft flag is dropped on reload,
  // and `folders` excludes chat folders after refetch), while the fallback pool
  // reads the user-facing `folders`.
  const preferredIsChat =
    preferred?.isChat === true ||
    allFolders.find((f) => f.id === preferred?.folderId)?.kind === "chat"
  const nonChatFallbackId = folders.find((f) => f.kind !== "chat")?.id ?? 0
  const folderId = preferredIsChat
    ? nonChatFallbackId
    : (preferred?.folderId ?? nonChatFallbackId)
  const workingDir = preferredIsChat
    ? (folders.find((f) => f.id === folderId)?.path ?? "")
    : (preferred?.workingDir ??
      folders.find((f) => f.id === folderId)?.path ??
      "")
  // If we have a preferred (closing) tab, inherit BOTH its agent and its
  // provisional flag — never silently launder a system best-guess into a
  // confirmed value just because the source tab was closed.
  const { agentType, provisional } = preferred?.agentType
    ? {
        agentType: preferred.agentType,
        provisional: preferred.agentTypeProvisional ?? false,
      }
    : resolveAgentForFolder(folderId, null)
  return {
    id: makeNewConversationTabId(),
    kind: "conversation",
    folderId,
    conversationId: null,
    agentType,
    title: runtime.labels.newConversation,
    isPinned: true,
    workingDir,
    agentTypeProvisional: provisional,
  }
}

function initialTabState() {
  return {
    rawTabs: [] as TabItemInternal[],
    activeTabId: null as string | null,
    previewReplacedTabIds: [] as string[],
    draftRetargetRequests: [] as DraftRetargetRequest[],
    tabsHydrated: false,
    ...readPersistedGroupState(),
    tabDrag: null as TabStoreState["tabDrag"],
    childSummaries: new Map<number, DbConversationSummary>(),
    tabs: [] as TabItemInternal[],
    reseedTick: 0,
    saveReconcileTick: 0,
  }
}

export const useTabStore = create<TabStoreState>()((set, get) => ({
  ...initialTabState(),

  openTab: (
    requestedFolderId,
    conversationId,
    agentType,
    pin = false,
    title,
    opts
  ) => {
    const folderId = canonicalConversationFolder(
      requestedFolderId,
      conversationId,
      agentType
    )
    useFolderTabsStore.getState().activateScope(folderScope(folderId))
    const prevState = get()
    const existingIndex = findTabIndexForConversation(
      prevState.rawTabs,
      folderId,
      agentType,
      conversationId
    )

    if (existingIndex >= 0) {
      const activateTabId = prevState.rawTabs[existingIndex].id
      if (pin && !prevState.rawTabs[existingIndex].isPinned) {
        const updated = [...prevState.rawTabs]
        updated[existingIndex] = { ...updated[existingIndex], isPinned: true }
        set({ rawTabs: updated, activeTabId: activateTabId })
        recomputeTabs()
      } else {
        focusTab(activateTabId)
      }
      runtime.activateConversationPane()
      return
    }

    // New tabs land in the focused group (the active tab's group).
    const targetGroup = resolveTargetGroup(prevState)

    // Format the seed title so a draft/conversation title carrying an inline
    // reference link (`[README.md](file://…)`) shows its label, not raw
    // Markdown, before the `tabs` derivation re-derives it from the refreshed
    // conversation list.
    const resolvedTitle =
      formatConversationTitle(
        title ??
          useAppWorkspaceStore
            .getState()
            .conversations.find(
              (c) =>
                c.id === conversationId &&
                c.agent_type === agentType &&
                c.folder_id === folderId
            )?.title
      ) || runtime.labels.untitledConversation

    const tabId = makeConversationTabId(folderId, agentType, conversationId)
    const newTab: TabItemInternal = {
      id: tabId,
      kind: "conversation",
      folderId,
      conversationId,
      agentType,
      title: resolvedTitle,
      isPinned: pin,
    }

    if (pin) {
      set({
        rawTabs: insertTab(prevState.rawTabs, newTab, opts?.index),
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Preview replacement stays within the focused group — a preview parked in
    // another group is left alone (the new tab gets a slot of its own instead).
    const previewIndex = prevState.rawTabs.findIndex(
      (t) =>
        !t.isPinned &&
        isTabInScope(t) &&
        groupOfTab(prevState.groupOf, prevState.groupLayout, t.id) ===
          targetGroup
    )
    if (previewIndex >= 0) {
      const updated = [...prevState.rawTabs]
      const replacedPreviewTabId = updated[previewIndex].id
      updated[previewIndex] = newTab
      set({
        rawTabs: updated,
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
        previewReplacedTabIds: [
          ...prevState.previewReplacedTabIds,
          replacedPreviewTabId,
        ],
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    set({
      rawTabs: insertTab(prevState.rawTabs, newTab, opts?.index),
      activeTabId: tabId,
      groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  closeTab: (tabId, options) => {
    const shouldActivateConversation = tabId === get().activeTabId

    const prevState = get()
    const index = prevState.rawTabs.findIndex((t) => t.id === tabId)
    if (index >= 0) {
      const closingTab = prevState.rawTabs[index]
      if (options?.recordForReopen !== false) {
        pushClosedTab(snapshotConversationTab(closingTab, index))
      }
      const next = prevState.rawTabs.filter((t) => t.id !== tabId)
      // A closing draft's composer text is scoped to that tab's key. Drop it —
      // unless this close spawns the replacement draft, which continues the same
      // slot and inherits the text instead of losing it silently.
      const closingDraftKey =
        closingTab.conversationId == null
          ? buildNewConversationDraftStorageKey(closingTab.id)
          : null
      // An "ask about this selection" prompt parked for this tab has no panel
      // left to drain it. Drop it rather than leave it in the module buffer for
      // the rest of the session — the tab id is never reused, so it could only
      // sit there.
      discardAskSelectionPrompts(closingTab.id)

      let draftKeyHandedOver = false

      if (useFolderTabsStore.getState().enabled && !next.some(isTabInScope)) {
        set({ rawTabs: next, activeTabId: null })
      } else if (next.length === 0) {
        if (useAppWorkspaceStore.getState().folders.length === 0) {
          set({ rawTabs: [], activeTabId: null })
        } else {
          let replacementTab = makeReplacementDraftTab(closingTab)
          // Cowork（#833）：排队区存着没发出去的消息时，原来的新工作树选择
          // 也跟过去，不然点重试会在原项目目录里直接发，不先建工作树。
          // 文件夹换了（比如关的是聊天标签）就不带。
          const carriesQueue =
            closingDraftKey != null && hasStoredDraftQueue(closingTab.id)
          if (
            carriesQueue &&
            closingTab.pendingWorktree &&
            replacementTab.folderId === closingTab.folderId &&
            replacementTab.workingDir === closingTab.workingDir
          ) {
            replacementTab = {
              ...replacementTab,
              pendingWorktree: closingTab.pendingWorktree,
            }
          }
          set({ rawTabs: [replacementTab], activeTabId: replacementTab.id })
          if (closingDraftKey) {
            draftKeyHandedOver = true
            moveMessageInputDraft(
              closingDraftKey,
              buildNewConversationDraftStorageKey(replacementTab.id)
            )
            // Cowork（#833）：排队区存着的消息也跟过去
            if (carriesQueue) {
              moveStoredDraftQueue(closingTab.id, replacementTab.id)
            }
          }
        }
      } else if (tabId === prevState.activeTabId) {
        set({
          rawTabs: next,
          activeTabId: focusAfterLosing(prevState, next, tabId),
        })
      } else {
        set({ rawTabs: next })
      }
      // Cowork（#1042）：没有补草稿接着用时，排队区存着的消息和新工作树选择
      // 寄存在项目名下，这个项目下一个新建或重开的草稿领走
      // （openNewConversationTab），不能留在关掉的标签名下找不回。
      if (
        closingDraftKey &&
        !draftKeyHandedOver &&
        closingTab.isChat !== true &&
        closingTab.folderId != null &&
        hasStoredDraftQueue(closingTab.id)
      ) {
        parkStoredDraftQueue(closingTab.id, closingTab.folderId, {
          ...(closingTab.workingDir != null
            ? { workingDir: closingTab.workingDir }
            : {}),
          ...(closingTab.pendingWorktree
            ? { pendingWorktree: closingTab.pendingWorktree }
            : {}),
        })
      }
      if (closingDraftKey && !draftKeyHandedOver) {
        clearMessageInputDraftV2(closingDraftKey)
      }
      recomputeTabs()
    }

    if (shouldActivateConversation) {
      runtime.activateConversationPane()
    }
  },

  closeConversationTab: (folderId, conversationId, agentType) => {
    const target = get().rawTabs.find(
      (tab) =>
        tab.folderId === folderId &&
        tab.conversationId === conversationId &&
        tab.agentType === agentType
    )
    if (!target) return
    // Every caller reaches here right after `deleteConversation` — the row is
    // gone, so the tab must not be offered back by "reopen closed tab".
    get().closeTab(target.id, { recordForReopen: false })
  },

  closeOtherTabs: (tabId) => {
    const prevState = get()
    const target = prevState.rawTabs.find((tab) => tab.id === tabId)
    if (!target) return
    // Group-scoped while split: "others" are the target's group siblings only —
    // the other groups keep their tabs (IDEA semantics).
    const { groupOf, groupLayout } = prevState
    const targetGroup = groupOfTab(groupOf, groupLayout, tabId)
    const keep =
      groupLayout.type === "group"
        ? prevState.rawTabs.filter(
            (tab) => tab.id === tabId || !isTabInScope(tab)
          )
        : prevState.rawTabs.filter(
            (tab) =>
              tab.id === tabId ||
              !isTabInScope(tab) ||
              groupOfTab(groupOf, groupLayout, tab.id) !== targetGroup
          )
    if (keep.length === prevState.rawTabs.length) {
      // Nothing to close (already alone in its group) — just focus.
      focusTab(tabId)
      return
    }
    const keepIds = new Set(keep.map((tab) => tab.id))
    const closing = batchCloseSlots(
      prevState.rawTabs,
      (tab) => !keepIds.has(tab.id)
    )
    for (const [tab, slot] of closing) {
      pushClosedTab(snapshotConversationTab(tab, slot))
    }
    set({ rawTabs: keep, activeTabId: tabId })
    recomputeTabs()
  },

  closeAllTabs: () => {
    if (useFolderTabsStore.getState().enabled) {
      const st = get()
      for (const [tab, slot] of batchCloseSlots(st.rawTabs, isTabInScope)) {
        pushClosedTab(snapshotConversationTab(tab, slot))
      }
      set({
        rawTabs: st.rawTabs.filter((tab) => !isTabInScope(tab)),
        activeTabId: null,
      })
      recomputeTabs()
      return
    }
    if (useAppWorkspaceStore.getState().folders.length === 0) {
      const prevState = get()
      if (prevState.rawTabs.length === 0 && prevState.activeTabId == null) {
        return
      }
      for (const [tab, slot] of batchCloseSlots(prevState.rawTabs)) {
        pushClosedTab(snapshotConversationTab(tab, slot))
      }
      set({ rawTabs: [], activeTabId: null })
      recomputeTabs()
      return
    }

    const prevState = get()
    const seedTab =
      prevState.rawTabs.find((t) => t.conversationId == null && t.workingDir) ??
      prevState.rawTabs.find((t) => t.id === prevState.activeTabId) ??
      prevState.rawTabs[0]
    const replacementTab = makeReplacementDraftTab(seedTab)
    for (const [tab, slot] of batchCloseSlots(prevState.rawTabs)) {
      pushClosedTab(snapshotConversationTab(tab, slot))
    }
    set({ rawTabs: [replacementTab], activeTabId: replacementTab.id })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  closeTabsByFolder: (folderId) => {
    const prevState = get()
    const remaining = prevState.rawTabs.filter((t) => t.folderId !== folderId)
    if (remaining.length === prevState.rawTabs.length) return
    // Deliberately not recorded for reopen: this runs when the folder itself
    // stops existing (a removed worktree, or the sidebar's "remove folder"),
    // so every tab it drops points at a cwd that is gone.

    const currentActive = prevState.activeTabId
    const stillActive =
      currentActive != null && remaining.some((t) => t.id === currentActive)

    set({
      rawTabs: remaining,
      activeTabId: stillActive ? currentActive : (remaining[0]?.id ?? null),
    })
    recomputeTabs()
  },

  switchTab: (tabId) => {
    if (!get().rawTabs.some((t) => t.id === tabId)) return
    const tab = get().rawTabs.find((t) => t.id === tabId)!
    useFolderTabsStore.getState().activateScope(folderScope(tab.folderId))
    focusTab(tabId)
    runtime.activateConversationPane()
  },

  pinTab: (tabId) => {
    const prev = get().rawTabs
    const idx = prev.findIndex((t) => t.id === tabId)
    // No-op when the tab is absent or already pinned — `map` would otherwise
    // always allocate a new array (and a new object for the matched tab),
    // needlessly re-rendering that tab's `ownTab` subscriber.
    if (idx < 0 || prev[idx].isPinned) return
    const next = prev.map((t, i) => (i === idx ? { ...t, isPinned: true } : t))
    set({ rawTabs: next })
    recomputeTabs()
  },

  toggleGroupTile: (groupId) => {
    const st = get()
    set({
      tileByGroup: { ...st.tileByGroup, [groupId]: !st.tileByGroup[groupId] },
    })
    persistGroupState()
  },

  splitTab: (tabId, direction, opts) => {
    const st = get()
    const tab = st.rawTabs.find((t) => t.id === tabId)
    if (!tab) return
    const sourceGroup = groupOfTab(st.groupOf, st.groupLayout, tabId)

    if (opts.move) {
      // A draft belongs to the group that spawned it (see `moveTabToGroup`);
      // plain split still seeds the new group with its own draft.
      if (tab.conversationId == null) return
      // Moving the group's only tab would just shift the group — pointless.
      const groupSize = st.rawTabs.filter(
        (t) =>
          isTabInScope(t) &&
          groupOfTab(st.groupOf, st.groupLayout, t.id) === sourceGroup
      ).length
      if (groupSize < 2) return
      const newGroupId = makeGroupId()
      const nextLayout = splitGroup(
        st.groupLayout,
        sourceGroup,
        direction,
        newGroupId
      )
      if (nextLayout === st.groupLayout) return
      set({
        groupLayout: nextLayout,
        groupOf: { ...st.groupOf, [tabId]: newGroupId },
        activeTabId: tabId,
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Split without moving: the new group opens with a fresh draft seeded from
    // the context tab (conversations can't be duplicated across groups).
    const newGroupId = makeGroupId()
    const nextLayout = splitGroup(
      st.groupLayout,
      sourceGroup,
      direction,
      newGroupId
    )
    if (nextLayout === st.groupLayout) return
    const inherit =
      tab.conversationId != null || !tab.agentTypeProvisional
        ? tab.agentType
        : null
    const { allFolders, folders } = useAppWorkspaceStore.getState()
    const contextIsChat =
      tab.isChat === true ||
      allFolders.find((f) => f.id === tab.folderId)?.kind === "chat"
    let newTab: TabItemInternal
    if (contextIsChat) {
      const { agentType, provisional } = resolveAgentForFolder(0, inherit, null)
      newTab = {
        id: makeNewConversationTabId(),
        kind: "conversation",
        folderId: 0,
        conversationId: null,
        agentType,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir: undefined,
        agentTypeProvisional: provisional,
        isChat: true,
      }
    } else {
      const { agentType, provisional } = resolveAgentForFolder(
        tab.folderId,
        inherit
      )
      newTab = {
        id: makeNewConversationTabId(),
        kind: "conversation",
        folderId: tab.folderId,
        conversationId: null,
        agentType,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir:
          tab.workingDir ?? folders.find((f) => f.id === tab.folderId)?.path,
        agentTypeProvisional: provisional,
      }
    }
    set({
      rawTabs: [...st.rawTabs, newTab],
      groupLayout: nextLayout,
      groupOf: { ...st.groupOf, [newTab.id]: newGroupId },
      activeTabId: newTab.id,
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  moveTabToGroup: (tabId, targetGroupId, opts) => {
    const st = get()
    const moving = st.rawTabs.find((t) => t.id === tabId)
    if (!moving) return
    if (!leafIds(st.groupLayout).includes(targetGroupId)) return
    if (groupOfTab(st.groupOf, st.groupLayout, tabId) === targetGroupId) return
    // Drafts are group-bound: each group owns its unsent scratch conversation
    // (its own composer text, its own folder/agent context), and every group can
    // spawn one on demand from its own strip. Moving one would leave a group
    // without its slot and hand another a second. Reordering WITHIN the group is
    // unaffected (that path never reaches here). The UI hides both move
    // affordances for drafts; this backstops the programmatic path.
    if (moving.conversationId == null) return

    if (opts?.index == null) {
      // Menu move: only the assignment changes — the tab keeps its global
      // rawTabs slot (group order = filtered order), so the synced payload
      // stays byte-identical and no save fires.
      set({
        groupOf: { ...st.groupOf, [tabId]: targetGroupId },
        activeTabId: tabId,
      })
      recomputeTabs()
      runtime.activateConversationPane()
      return
    }

    // Drag drop: land at `index` within the target group. Splice the tab out,
    // then insert it before the target group's k-th visible member (after
    // its last visible member when k = member count). Hidden members do not
    // have drop slots. This partition insert preserves every OTHER
    // group's relative order. rawTabs order changes, which
    // syncs like any user reorder.
    const without = st.rawTabs.filter((t) => t.id !== tabId)
    const memberSlots: number[] = []
    without.forEach((t, i) => {
      if (
        groupOfTab(st.groupOf, st.groupLayout, t.id) === targetGroupId &&
        isTabInScope(t)
      ) {
        memberSlots.push(i)
      }
    })
    const k = Math.max(0, Math.min(opts.index, memberSlots.length))
    const insertPos =
      k < memberSlots.length
        ? memberSlots[k]
        : memberSlots.length > 0
          ? memberSlots[memberSlots.length - 1] + 1
          : without.length
    const nextRaw = [
      ...without.slice(0, insertPos),
      moving,
      ...without.slice(insertPos),
    ]
    set({
      rawTabs: nextRaw,
      groupOf: { ...st.groupOf, [tabId]: targetGroupId },
      activeTabId: tabId,
    })
    recomputeTabs()
    runtime.activateConversationPane()
  },

  updateTabDrag: (drag) => {
    const prev = get().tabDrag
    // Per-frame writes: skip the set when nothing observable changed.
    if (
      prev != null &&
      prev.tabId === drag.tabId &&
      prev.x === drag.x &&
      prev.y === drag.y &&
      prev.overGroupId === drag.overGroupId
    ) {
      return
    }
    set({ tabDrag: drag })
  },

  endTabDrag: () => {
    if (get().tabDrag == null) return
    set({ tabDrag: null })
  },

  toggleGroupOrientation: (groupId) => {
    const st = get()
    const next = toggleOrientation(st.groupLayout, groupId)
    if (next === st.groupLayout) return
    set({ groupLayout: next })
    persistGroupState()
  },

  dissolveGroup: (groupId) => {
    const st = get()
    const target = neighborGroupId(st.groupLayout, groupId)
    if (!target) return
    const groupOf = { ...st.groupOf }
    for (const tab of st.rawTabs) {
      if (
        isTabInScope(tab) &&
        groupOfTab(st.groupOf, st.groupLayout, tab.id) === groupId
      ) {
        groupOf[tab.id] = target
      }
    }
    set({ groupOf, groupLayout: removeGroup(st.groupLayout, groupId) })
    recomputeTabs()
  },

  unsplitAll: () => {
    const st = get()
    if (st.groupLayout.type === "group") return
    // Everyone falls back to the (kept) first leaf; rawTabs order is already
    // the merged display order, so the synced payload doesn't change. Only
    // the view on screen unsplits: its assignments are its own.
    set({
      groupLayout: singleGroupLayout(firstLeafId(st.groupLayout)),
      groupOf: {},
    })
    recomputeTabs()
  },

  reorderGroupTabs: (groupId, orderedTabs) => {
    const st = get()
    const raw = st.rawTabs
    const slots: number[] = []
    raw.forEach((tab, i) => {
      if (
        isTabInScope(tab) &&
        groupOfTab(st.groupOf, st.groupLayout, tab.id) === groupId
      ) {
        slots.push(i)
      }
    })
    // Partition permutation: only this group's slots move, so the other
    // groups' persisted positions stay byte-stable.
    const next = permuteSlots(raw, slots, orderedTabs)
    if (!next) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  resizeGroupSplit: (splitId, handleIndex, boundaryFraction) => {
    const st = get()
    const next = resizeSplitAt(
      st.groupLayout,
      splitId,
      handleIndex,
      boundaryFraction
    )
    if (next === st.groupLayout) return
    set({ groupLayout: next })
    schedulePersistGroupState()
  },

  reorderTabs: (reorderedTabs) => {
    // The unsplit strip shows every tab, so its slots are the whole array —
    // otherwise identical to a group reorder, guards included.
    const raw = get().rawTabs
    const next = permuteSlots(
      raw,
      raw.flatMap((tab, i) => (isTabInScope(tab) ? [i] : [])),
      reorderedTabs
    )
    if (!next) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  openNewConversationTab: (folderId, workingDir, options) => {
    // "New conversation" while a chat conversation is active resolves the active
    // (hidden) chat folder. Never pile a second conversation into a
    // per-conversation chat folder — start a fresh folderless chat draft
    // instead. Single choke point for every "new conversation" entry point.
    if (
      useAppWorkspaceStore.getState().allFolders.find((f) => f.id === folderId)
        ?.kind === "chat"
    ) {
      return get().openChatModeTab({
        ...(options?.targetGroup != null
          ? { targetGroup: options.targetGroup }
          : {}),
        ...(options?.forceAgent != null
          ? { forceAgent: options.forceAgent }
          : {}),
      })
    }
    // Read before any folder scope switch: "inherit from active" means the
    // tab the user is on, not whatever the target folder had selected.
    const inheritFromActive = options?.inheritFromActive === true
    let inherit: AgentType | null = null
    if (inheritFromActive) {
      const st = get()
      const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId)
      if (
        activeTab &&
        (activeTab.conversationId != null || !activeTab.agentTypeProvisional)
      ) {
        inherit = activeTab.agentType
      }
    }
    // A draft MOVED to this folder (the composer's folder picker) stays the
    // same tab, so its composer and typed prompt come along. While tabs
    // follow the folder it keeps its scope until the queued retarget lands
    // and the scope follows it (`consumeDraftRetargets`); switching first
    // would hide it and hand the user the target folder's own draft instead.
    const movingDraft =
      options?.retargetTabId != null
        ? get().rawTabs.find(
            (t) => t.id === options.retargetTabId && t.conversationId == null
          )
        : undefined
    if (!movingDraft) {
      useFolderTabsStore.getState().activateScope(folderScope(folderId))
    }
    // A forced agent short-circuits resolution entirely (it outranks the folder
    // default, which `inherit` would lose to) and is never provisional — it is
    // explicit caller intent, not a guess to be corrected once the agent list
    // goes fresh.
    const { agentType: targetAgent, provisional } =
      options?.forceAgent != null
        ? { agentType: options.forceAgent, provisional: false }
        : resolveAgentForFolder(folderId, inherit, options?.folderDefaultAgent)

    const tabId = makeNewConversationTabId()
    const prevState = get()
    // Per-group draft singleton: reuse the target group's existing draft tab
    // (regardless of folder), so each group carries at most one draft.
    const targetGroup = movingDraft
      ? groupOfTab(prevState.groupOf, prevState.groupLayout, movingDraft.id)
      : resolveTargetGroup(prevState, options?.targetGroup)
    const existingTab =
      movingDraft ??
      prevState.rawTabs.find(
        (t) =>
          t.conversationId == null &&
          isTabInScope(t) &&
          groupOfTab(prevState.groupOf, prevState.groupLayout, t.id) ===
            targetGroup
      )

    // Cowork（#1042）：这个项目寄存着关掉的草稿没发出去的消息时，交给这次
    // 新建或重开的草稿，一次领一份（最后关掉的那份）。搬草稿（retargetTabId）
    // 不算新建，不领。复用的草稿自己排队区还存着消息时不领：两份的新工作树
    // 选择可能不一样，混在一起重试会走错目录；寄存的那份留给之后的草稿。
    // 只交给工作目录对得上的草稿（不管带没带新工作树选择），不然重试就在
    // 别的目录里发了。复用的是别的项目的草稿也照领：它换到这个项目时把领回
    // 的新工作树选择一起带上（DraftRetargetRequest.pendingWorktree）。
    const claimed =
      movingDraft ||
      (existingTab != null && hasStoredDraftQueue(existingTab.id))
        ? null
        : claimParkedDraftQueue(
            folderId,
            existingTab?.id ?? tabId,
            (handoff) => (handoff.workingDir ?? workingDir) === workingDir
          )
    const claimedWorktree = claimed
      ? sanitizeWorktreeSpec(claimed.pendingWorktree)
      : undefined

    if (!existingTab) {
      const newTab: TabItemInternal = {
        id: tabId,
        kind: "conversation",
        folderId,
        conversationId: null,
        agentType: targetAgent,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir,
        agentTypeProvisional: provisional,
        ...(claimedWorktree ? { pendingWorktree: claimedWorktree } : {}),
      }
      set({
        rawTabs: insertTab(prevState.rawTabs, newTab, options?.index),
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
      // 领回的新工作树选择跟着草稿过刷新，像 setDraftWorktree 那样落盘。
      if (claimedWorktree) persistGroupState()
      runtime.activateConversationPane()
      return { tabId, agentType: targetAgent, folderId }
    }

    const folderChanged = existingTab.folderId !== folderId
    const workingDirChanged = existingTab.workingDir !== workingDir
    const agentChanged = existingTab.agentType !== targetAgent
    const provisionalChanged =
      (existingTab.agentTypeProvisional ?? false) !== provisional
    // #837：点「新建会话」复用分组里已有的草稿时，把它重置成「不用工作树」——
    // 上次选的分支（可能正是创建失败、刷新后又恢复出来的那个）不再跟着。
    // 搬草稿（retargetTabId，工作树建好后的那一步）和按原位置重新打开（index）
    // 不算新建，照旧保留。
    const clearWorktree =
      !movingDraft &&
      options?.index == null &&
      options?.keepDraftWorktree !== true &&
      existingTab.pendingWorktree != null

    // The singleton means a reopened draft resolves to THIS draft rather than a
    // tab of its own, so the slot it was closed from has to move this one — a
    // close-all walked back would otherwise leave the draft shunted to the end
    // of the strip it is meant to rebuild. Only the reopen path passes an
    // index, and drafts never reach `buildPersistItems`, so no save fires.
    const nextRawTabs =
      options?.index == null
        ? prevState.rawTabs
        : moveTabToSlot(prevState.rawTabs, existingTab.id, options.index)
    // 领回了关掉的草稿的消息（#1042）：新工作树选择换成那份消息自己的，
    // 它没选就清掉草稿原来的（重开时 index 不清，消息不能带上无关的选择）。
    const restoreWorktree =
      claimed != null && existingTab.pendingWorktree !== claimedWorktree
    const clearedRawTabs =
      clearWorktree || restoreWorktree
        ? nextRawTabs.map((tab) =>
            tab.id === existingTab.id
              ? {
                  ...tab,
                  pendingWorktree: restoreWorktree
                    ? claimedWorktree
                    : undefined,
                }
              : tab
          )
        : nextRawTabs
    const changed = clearedRawTabs !== prevState.rawTabs

    if (folderChanged || agentChanged) {
      set({
        ...(changed ? { rawTabs: clearedRawTabs } : {}),
        draftRetargetRequests: [
          ...prevState.draftRetargetRequests,
          {
            tabId: existingTab.id,
            expectedAgent: existingTab.agentType,
            folderId,
            workingDir,
            agentType: targetAgent,
            provisional,
            ...(claimedWorktree ? { pendingWorktree: claimedWorktree } : {}),
          },
        ],
      })
      focusTab(existingTab.id)
      if (changed) recomputeTabs()
    } else if (workingDirChanged || provisionalChanged) {
      set({
        rawTabs: clearedRawTabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, workingDir, agentTypeProvisional: provisional }
            : tab
        ),
        activeTabId: existingTab.id,
      })
      recomputeTabs()
    } else if (changed) {
      set({ rawTabs: clearedRawTabs, activeTabId: existingTab.id })
      recomputeTabs()
    } else {
      focusTab(existingTab.id)
    }
    // 清掉的选择也要落盘，不然刷新后又从存档里恢复出来。
    if (clearWorktree || restoreWorktree) persistGroupState()
    runtime.activateConversationPane()
    // Every branch above leaves the tab on `targetAgent` in `folderId` — either
    // already there, or once its queued retarget lands.
    return { tabId: existingTab.id, agentType: targetAgent, folderId }
  },

  openChatModeTab: (options) => {
    // Inherit the agent like openNewConversationTab's inherit path — read
    // before the folder-tabs switch to the global scope, from the tab the user
    // is on.
    const before = get()
    const activeTab = before.rawTabs.find((x) => x.id === before.activeTabId)
    const inherit =
      activeTab &&
      (activeTab.conversationId != null || !activeTab.agentTypeProvisional)
        ? activeTab.agentType
        : null
    // A draft MOVED into chat mode (the composer's picker) stays the same tab,
    // prompt and all. It is flipped synchronously below, so the global scope
    // shows it straight away.
    const movingDraft =
      options?.retargetTabId != null
        ? before.rawTabs.find(
            (t) => t.id === options.retargetTabId && t.conversationId == null
          )
        : undefined
    useFolderTabsStore.getState().activateScope("global")
    const st = get()
    // Same short-circuit as openNewConversationTab: an explicitly forced agent
    // is caller intent and skips resolution.
    const { agentType: targetAgent, provisional } =
      options?.forceAgent != null
        ? { agentType: options.forceAgent, provisional: false }
        : resolveAgentForFolder(0, inherit, null)

    // Per-group draft singleton — all draft handling below is scoped to the
    // target group. Capture its existing draft (if any) up front so a stale
    // ACP session can be torn down after we flip it to chat mode.
    const targetGroup = movingDraft
      ? groupOfTab(st.groupOf, st.groupLayout, movingDraft.id)
      : resolveTargetGroup(st, options?.targetGroup)
    const inTargetGroup = (t: TabItemInternal) =>
      groupOfTab(st.groupOf, st.groupLayout, t.id) === targetGroup
    const isTargetDraft = (t: TabItemInternal) =>
      movingDraft
        ? t.id === movingDraft.id
        : t.conversationId == null && isTabInScope(t) && inTargetGroup(t)
    const existingDraft = st.rawTabs.find(isTargetDraft)
    const needsDisconnect =
      existingDraft != null &&
      !(existingDraft.isChat && existingDraft.folderId === 0)

    const tabId = makeNewConversationTabId()
    const prevState = get()
    const existingTab = prevState.rawTabs.find(isTargetDraft)

    if (!existingTab) {
      const newTab: TabItemInternal = {
        id: tabId,
        kind: "conversation",
        folderId: 0,
        conversationId: null,
        agentType: targetAgent,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir: undefined,
        agentTypeProvisional: provisional,
        isChat: true,
      }
      set({
        rawTabs: [...prevState.rawTabs, newTab],
        activeTabId: tabId,
        groupOf: { ...prevState.groupOf, [tabId]: targetGroup },
      })
      recomputeTabs()
    } else if (existingTab.isChat && existingTab.folderId === 0) {
      // Already a chat-mode draft. Normally there is nothing to do but focus it
      // — it keeps whatever agent it was on, because `inherit` is only ever a
      // suggestion. A FORCED agent is not: the caller needs this draft to run on
      // that agent (an "ask about this selection" continuing a chat
      // conversation), so re-point it. No explicit disconnect: the connection
      // lifecycle is keyed on the agent and tears the old one down itself, the
      // same way the agent picker's `confirmDraftAgent` relies on.
      if (
        options?.forceAgent != null &&
        (existingTab.agentType !== targetAgent ||
          (existingTab.agentTypeProvisional ?? false) !== provisional)
      ) {
        set({
          activeTabId: existingTab.id,
          rawTabs: prevState.rawTabs.map((tab) =>
            tab.id === existingTab.id
              ? {
                  ...tab,
                  agentType: targetAgent,
                  agentTypeProvisional: provisional,
                }
              : tab
          ),
        })
        recomputeTabs()
      } else {
        focusTab(existingTab.id)
      }
    } else {
      // Existing draft on a real folder: flip it to chat mode SYNCHRONOUSLY
      // (folderId + isChat together), so a send issued before any async teardown
      // can never still create/send in the old folder. The agent is re-resolved
      // for chat mode (no folder default).
      set({
        activeTabId: existingTab.id,
        rawTabs: prevState.rawTabs.map((tab) =>
          tab.id === existingTab.id
            ? {
                ...tab,
                folderId: 0,
                workingDir: undefined,
                isChat: true,
                pendingWorktree: undefined,
                agentType: targetAgent,
                agentTypeProvisional: provisional,
              }
            : tab
        ),
      })
      recomputeTabs()
      // A draft moved in from a folder can land beside the chat view's own.
      if (movingDraft && useFolderTabsStore.getState().enabled) {
        closeBlankDraftsBeside(existingTab.id)
      }
    }

    if (needsDisconnect && existingDraft) {
      void runtime.acpDisconnect(existingDraft.id).catch((err) => {
        console.error("[TabStore] disconnect chat-mode draft:", err)
      })
    }
    runtime.activateConversationPane()
    // A reused chat draft that was NOT force-agented keeps its own agent (the
    // focus-only branch above), so report that rather than the resolved one.
    const settledAgent =
      existingTab && existingTab.isChat && existingTab.folderId === 0
        ? options?.forceAgent != null
          ? targetAgent
          : existingTab.agentType
        : targetAgent
    return {
      tabId: existingTab ? existingTab.id : tabId,
      agentType: settledAgent,
      folderId: 0,
    }
  },

  setChatDraftWorkingDir: (tabId, workingDir) => {
    const prev = get().rawTabs
    const next = prev.map((tab) => {
      if (tab.id !== tabId) return tab
      // Guard against a stale eager-prepare result landing after the draft
      // already bound, retargeted, or left chat mode. Only patch a still-unbound
      // chat draft, and skip a redundant write to keep the reference stable.
      if (
        tab.conversationId != null ||
        tab.isChat !== true ||
        tab.workingDir === workingDir
      ) {
        return tab
      }
      return { ...tab, workingDir }
    })
    if (next.every((tab, i) => tab === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  setDraftWorktree: (tabId, spec) => {
    const prev = get().rawTabs
    const next = prev.map((tab) => {
      if (tab.id !== tabId || tab.conversationId != null) return tab
      if (spec == null) {
        if (tab.pendingWorktree == null) return tab
        return { ...tab, pendingWorktree: undefined }
      }
      return { ...tab, pendingWorktree: spec }
    })
    if (next.every((tab, i) => tab === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
    // The intent rides along with the draft across a reload.
    persistGroupState()
  },

  confirmDraftAgent: (tabId, agentType) => {
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (t.conversationId != null) return t // not a draft
      if (t.agentType === agentType && !t.agentTypeProvisional) return t
      return { ...t, agentType, agentTypeProvisional: false }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  setDraftAgentFromFallback: (tabId, agentType) => {
    // Cowork fork（AI QA #436）：草稿在 provisional 时不自动连接，而纠正一次会话
    // 只跑一次。纠正跑过以后再发生的替补没人会再纠正，留成 provisional 这个草稿
    // 就永远连不上，所以那之后的替补直接算定下来。
    const provisional = !correctionRan
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (t.conversationId != null) return t // not a draft
      if (
        t.agentType === agentType &&
        (t.agentTypeProvisional ?? false) === provisional
      )
        return t
      return { ...t, agentType, agentTypeProvisional: provisional }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  bindConversationTab: (
    tabId,
    conversationId,
    agentType,
    title,
    runtimeConversationId,
    folderId,
    workingDir
  ) => {
    const prevState = get()
    const nextTabs = prevState.rawTabs.flatMap((tab) => {
      if (tab.id === tabId) {
        const nextTab: TabItemInternal = {
          ...tab,
          conversationId,
          agentType,
          title: formatConversationTitle(title) || tab.title,
          runtimeConversationId,
          agentTypeProvisional: false,
          ...(folderId != null ? { folderId } : {}),
          ...(workingDir != null ? { workingDir } : {}),
        }
        return [nextTab]
      }
      // Drop any other tab that already represents the same (conversationId,
      // agentType) — conversation IDs are globally unique.
      if (
        tab.conversationId === conversationId &&
        tab.agentType === agentType
      ) {
        return []
      }
      return [tab]
    })

    const activeStillExists =
      prevState.activeTabId != null &&
      nextTabs.some((tab) => tab.id === prevState.activeTabId)
    const boundTab = nextTabs.find((tab) => tab.id === tabId)

    set({
      rawTabs: nextTabs,
      activeTabId: activeStillExists
        ? prevState.activeTabId
        : (boundTab?.id ?? nextTabs[0]?.id ?? null),
    })
    recomputeTabs()
  },

  setTabRuntimeConversationId: (tabId, runtimeConversationId) => {
    const prev = get().rawTabs
    const target = prev.find((tab) => tab.id === tabId)
    if (!target || target.runtimeConversationId === runtimeConversationId) {
      return
    }
    set({
      rawTabs: prev.map((tab) =>
        tab.id === tabId ? { ...tab, runtimeConversationId } : tab
      ),
    })
    recomputeTabs()
  },

  consumeRemoteActivation: () => {
    if (!remoteActivationPending) return false
    remoteActivationPending = false
    return true
  },

  onPreviewTabReplaced: (callback) => {
    previewReplacedCallbacks.add(callback)
    return () => {
      previewReplacedCallbacks.delete(callback)
    }
  },

  hydrate: () => {
    // 远端窗口：store 建好时还没有远端 id，读的是本机窗口那份记录，换成自己的
    // 重读一遍（#1063）。还没恢复过标签，这时换掉分组状态不丢东西。
    if (
      typeof window !== "undefined" &&
      !get().tabsHydrated &&
      groupStateReadKey !== tabGroupsStorageKey()
    ) {
      lastGroupBlob = null
      set(readPersistedGroupState())
    }
    let cancelled = false
    void (async () => {
      let snapshotLoaded = false
      try {
        const snap = await listOpenedTabs()
        if (cancelled) return
        snapshotLoaded = true
        tabsSnapshotLoaded = true
        version = snap.version
        serverKnownTabKeys = snapshotSyncKeys(snap.items)
        const snapshotTabs: TabItemInternal[] = snap.items.map((it) => ({
          id:
            it.conversation_id != null
              ? makeConversationTabId(
                  it.folder_id,
                  it.agent_type,
                  it.conversation_id
                )
              : makeNewConversationTabId(),
          kind: "conversation",
          folderId: it.folder_id,
          conversationId: it.conversation_id,
          agentType: it.agent_type,
          title:
            it.conversation_id != null
              ? runtime.labels.loadingConversation
              : runtime.labels.newConversation,
          isPinned: it.is_pinned,
        }))
        const activeItem = snap.items.find(
          (it) => it.is_active && it.conversation_id != null
        )
        let restoredActive: string | null = activeItem
          ? makeConversationTabId(
              activeItem.folder_id,
              activeItem.agent_type,
              activeItem.conversation_id as number
            )
          : null
        // Splice the device-local drafts back in (same frame as the conversation
        // tabs, so the first invariant pass sees complete groups and can't
        // collapse a draft-only one).
        // 服务器还没确认的会话标签（#626）一起按原来的位置插回去；分组沿用
        // blob 的 assignments（按规范 id 记的）。
        dropEmptyFillerDraft()
        const {
          tabs: withDrafts,
          groupOf: draftGroups,
          unsyncedIds: restoredUnsyncedIds,
        } = mergeRestoredLocalTabs(snapshotTabs)
        // Cowork: this device's own last focus wins over the server's
        // `is_active` (which is whatever any client focused last), so opening
        // the app here never lands on what another computer was looking at.
        const localActive = [
          pendingRestoreActiveDraft,
          pendingRestoreActiveConversation,
        ].find((id) => id != null && withDrafts.some((tab) => tab.id === id))
        if (localActive != null) {
          restoredActive = localActive
        }
        if (!restoredActive && withDrafts.length > 0) {
          restoredActive = withDrafts[0].id
        }
        set({
          rawTabs: withDrafts,
          activeTabId: restoredActive,
          ...(Object.keys(draftGroups).length > 0
            ? { groupOf: { ...get().groupOf, ...draftGroups } }
            : {}),
        })
        recomputeTabs()
        // Baseline from the POST-restore state: drafts never enter the payload,
        // so restoring focus onto a draft simply means no tab carries
        // `is_active`. Seeding that as the baseline keeps the restore free of a
        // CAS save (and of the focus broadcast that would follow it).
        // 补回来的标签不算进基线，让紧接着的保存把它们存上服务器。
        lastSavedPayload = JSON.stringify(
          buildPersistItems(
            withDrafts.filter((tab) => !restoredUnsyncedIds.has(tab.id)),
            restoredActive
          )
        )
      } catch (err) {
        console.error("[TabStore] listOpenedTabs failed:", err)
        if (!cancelled) {
          snapshotReadFailed = true
          readFailedHomeFolder = folderOfConversationTabId(
            pendingRestoreActiveConversation
          )
          // The snapshot is the CONVERSATION half only; the drafts are
          // device-local and still valid, so restore them rather than starting
          // blank. Everything that could destroy on-disk state — the invariant
          // prune, the blob write, the composer-key sweep — stays parked behind
          // `tabsSnapshotLoaded` until a snapshot actually lands (the refetch
          // that follows the subscription usually rescues it seconds later).
          // 服务器还没确认的会话标签（#626）也是本机才知道的，一起补回来：
          // 留到之后的快照再补就没人读它了，blob 也会被改写掉。它们算进下面的
          // 基线，快照落地前不往服务器推；快照到了以后 applyRemoteSnapshot
          // 把它们当作服务器没见过的本机新增保留下来、再推上去。
          const {
            tabs: draftsOnly,
            groupOf: draftGroups,
            recordedIndex,
          } = mergeRestoredLocalTabs(get().rawTabs)
          restoredLocalIndex = recordedIndex
          // 上次故障期间补的占位草稿补回来了，仍认成占位（不算焦点）。
          if (
            pendingRestoreFillerDraft != null &&
            draftsOnly.some(
              (tab) =>
                tab.id === pendingRestoreFillerDraft &&
                tab.conversationId == null
            )
          ) {
            readFailedFillerDraftId = pendingRestoreFillerDraft
          }
          if (draftsOnly.length > 0) {
            const focus =
              [
                pendingRestoreActiveDraft,
                pendingRestoreActiveConversation,
              ].find(
                (id) => id != null && draftsOnly.some((tab) => tab.id === id)
              ) ?? draftsOnly[0].id
            set({
              rawTabs: draftsOnly,
              activeTabId: focus,
              groupOf: { ...get().groupOf, ...draftGroups },
            })
            recomputeTabs()
          }
          // Drafts contribute nothing to the payload, so this baseline is the
          // empty list — which stops the save effect from pushing an empty tab
          // set at the server just because the read failed.
          // 补回的未确认会话标签也在基线里，读取失败时同样不推（版本号未知，
          // 推上去可能盖掉服务器上的标签）。
          lastSavedPayload = JSON.stringify(
            buildPersistItems(get().rawTabs, get().activeTabId)
          )
        }
      } finally {
        if (!cancelled) {
          set({ tabsHydrated: true })
          // First full invariant pass: with hydration done, blob-seeded group
          // entries that matched nothing (tabs closed on another client) prune
          // and ghost empty groups collapse.
          applyGroupInvariants()
          // Retire composer drafts left behind by tabs that no longer exist
          // (crash / pre-per-tab-key builds). The live set is read when the
          // sweep runs, so a draft opened in the meantime is never swept. Only
          // safe once the tab set is known — after a failed fetch every key
          // would look orphaned and the user's unsent text would be deleted.
          if (snapshotLoaded) {
            // 别的窗口记录里的草稿也算活的（#1063），它们的文字不能删。
            sweepOrphanDraftKeys(() => {
              const live = draftIdsInOtherTabGroupBlobs()
              for (const tab of get().rawTabs) {
                if (tab.conversationId == null) live.add(tab.id)
              }
              return live
            })
          }
          // Apply a remote change that raced ahead of hydration. Call
          // applyRemoteSnapshot directly (not handleTabsChanged): `pending` is
          // an authoritative server snapshot, and routing it through the live
          // handler's `version` gate would drop an equal-version reconcile.
          const pending = pendingRemote
          if (pending && pending.version > version) {
            pendingRemote = null
            applyRemoteSnapshot(pending)
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  },

  runSaveEffect: () => {
    const st = get()
    if (!st.tabsHydrated) return
    // 首次读取失败、服务器的标签还不知道时不保存（#626）：本机列表不完整，
    // 版本号也可能还是默认的 0，推上去可能被接受、盖掉服务器上原有的标签。
    // 快照落地后 applyRemoteSnapshot 会保留本机新增的，再由下一次保存推上去。
    if (snapshotReadFailed) {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return
    }

    // A remote snapshot just mutated rawTabs/focus — consume the one-shot guard
    // so we don't echo it back (which would re-broadcast and ping-pong).
    if (applyingRemote) {
      applyingRemote = false
      return
    }

    const items = buildPersistItems(st.rawTabs, st.activeTabId)
    const payload = JSON.stringify(items)
    // Reverted to the last-saved state → cancel any save still armed.
    if (payload === lastSavedPayload) {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return
    }

    if (saveTimer) clearTimeout(saveTimer)
    const expectedVersion = version
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveOpenedTabs(items, expectedVersion, TAB_ORIGIN)
        .then((res) => {
          version = Math.max(version, res.version)
          if (!res.accepted) {
            // Rejected (another client committed first) → adopt server truth.
            // Apply directly, NOT via handleTabsChanged: we just advanced
            // `version` to `res.version`, so the live handler's
            // `change.version <= version` gate would drop this equal-version
            // snapshot and leave the stale local set in place. applyRemoteSnapshot
            // reconciles on equal version (its guard is strict `<`).
            applyRemoteSnapshot({
              version: res.version,
              origin: "server",
              tabs: res.tabs,
            })
            return
          }
          lastSavedPayload = payload
          // The server now holds exactly what we sent — unless a newer snapshot
          // landed while this was in flight, in which case that apply already
          // recorded the fresher truth and must not be walked back.
          if (res.version === version) {
            serverKnownTabKeys = snapshotSyncKeys(res.tabs)
            // 服务器确认了，把它们从 blob 的 unsyncedConversations 里去掉。
            persistGroupState()
          }
          const current = JSON.stringify(
            buildPersistItems(get().rawTabs, get().activeTabId)
          )
          if (current !== lastSavedPayload) {
            set({ saveReconcileTick: get().saveReconcileTick + 1 })
          }
        })
        .catch(() => {
          // Ignore save errors; the reconnect refetch reconciles.
        })
    }, 500)
  },

  clearSaveTimer: () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  },

  reconcileChildSummaries: () => {
    const { conversations, conversationsLoading } =
      useAppWorkspaceStore.getState()
    if (conversationsLoading) return
    const conversationKeys = new Set<string>()
    for (const c of conversations) {
      conversationKeys.add(`${c.folder_id}-${c.agent_type}-${c.id}`)
    }
    const rawTabs = get().rawTabs
    const openChildIds = new Set<number>()
    for (const tab of rawTabs) {
      const id = tab.conversationId
      if (id == null) continue
      if (conversationKeys.has(`${tab.folderId}-${tab.agentType}-${id}`)) {
        continue
      }
      // Just deleted, not a child: the Deleted event drops the row from the
      // sidebar list a beat before the tab itself closes (the server's tab
      // snapshot / the deleter's own close), and in that window the tab would
      // read as an unseeded child and fetch a row that no longer exists.
      if (isConversationDeleted(id)) continue
      openChildIds.add(id)
    }
    // Prune cached summaries for child tabs that have since closed.
    const prevChild = get().childSummaries
    let prunedChild: Map<number, DbConversationSummary> | null = null
    for (const id of prevChild.keys()) {
      if (!openChildIds.has(id)) {
        prunedChild = prunedChild ?? new Map(prevChild)
        prunedChild.delete(id)
      }
    }
    if (prunedChild) {
      set({ childSummaries: prunedChild })
      recomputeTabs()
    }
    // Seed the open child tabs that aren't cached or already being fetched.
    for (const id of openChildIds) {
      if (get().childSummaries.has(id)) continue
      if (childSummaryInFlight.has(id)) continue
      childSummaryInFlight.add(id)
      const epoch = seedEpoch
      // Only the SUMMARY is used below, so ask for the smallest window the
      // backend accepts instead of the legacy full detail. Without a window the
      // response carries every turn of the child session — for a long child
      // that is megabytes of transcript transferred and re-parsed purely to
      // read `detail.summary`. `tailTurns: 1` is the smallest window the
      // backend accepts (it still widens back to the last user turn). The
      // summary describes the whole transcript whatever the window, and it is
      // all the tab label and status read.
      void getFolderConversation(id, { tailTurns: 1 })
        .then((detail) => {
          if (seedEpoch !== epoch) return
          const buffered = childSeedBuffer.get(id)
          if (buffered?.deleted) return
          if (!get().rawTabs.some((tb) => tb.conversationId === id)) return
          let summary = buffered?.summary ?? detail.summary
          if (buffered?.status != null) {
            summary = { ...summary, status: buffered.status }
          }
          const nextChild = new Map(get().childSummaries)
          nextChild.set(id, summary)
          set({ childSummaries: nextChild })
          recomputeTabs()
        })
        .catch(() => {
          // Leave unseeded (e.g. deleted) — a later pass or live event retries.
        })
        .finally(() => {
          if (seedEpoch !== epoch) return
          childSummaryInFlight.delete(id)
          childSeedBuffer.delete(id)
        })
    }
  },

  handleChildConversationChange: (change) => {
    const id = change.kind === "upsert" ? change.summary.id : change.id
    if (get().childSummaries.has(id)) {
      if (change.kind === "upsert") {
        const summary = change.summary
        const prev = get().childSummaries
        if (!prev.has(summary.id)) return
        const next = new Map(prev)
        next.set(summary.id, summary)
        set({ childSummaries: next })
        recomputeTabs()
      } else if (change.kind === "status") {
        const prev = get().childSummaries
        const cur = prev.get(change.id)
        if (!cur || cur.status === change.status) return
        const next = new Map(prev)
        // 状态一变就不再算被打断（#369）。
        next.set(change.id, {
          ...cur,
          status: change.status,
          interrupted_at: null,
        })
        set({ childSummaries: next })
        recomputeTabs()
      } else {
        const prev = get().childSummaries
        if (!prev.has(change.id)) return
        const next = new Map(prev)
        next.delete(change.id)
        set({ childSummaries: next })
        recomputeTabs()
      }
      return
    }
    // Seed for this id is still in flight — accumulate into the pending buffer.
    if (childSummaryInFlight.has(id)) {
      const pending = childSeedBuffer.get(id) ?? {}
      if (change.kind === "deleted") {
        pending.deleted = true
      } else if (!pending.deleted) {
        if (change.kind === "upsert") {
          pending.summary = change.summary
          pending.status = undefined
        } else {
          pending.status = change.status
        }
      }
      childSeedBuffer.set(id, pending)
    }
  },

  handleChildReconnect: () => {
    seedEpoch += 1
    childSummaryInFlight.clear()
    childSeedBuffer.clear()
    if (get().childSummaries.size !== 0) {
      set({ childSummaries: new Map() })
      recomputeTabs()
    }
    set({ reseedTick: get().reseedTick + 1 })
  },

  handleTabsChanged: (change) => {
    if (change.origin === TAB_ORIGIN) {
      // Our own accepted save, echoed back: nothing to apply, but the snapshot
      // is authoritative — record it as the merge ancestor in case it beats the
      // save's own resolution (see `runSaveEffect`).
      if (change.version > version) {
        version = change.version
        serverKnownTabKeys = snapshotSyncKeys(change.tabs)
        persistGroupState()
      }
      return
    }
    if (change.version <= version) return
    if (!get().tabsHydrated) {
      const pending = pendingRemote
      if (!pending || change.version >= pending.version) {
        pendingRemote = change
      }
      return
    }
    applyRemoteSnapshot(change)
  },

  refetchTabs: async () => {
    try {
      const snap = await listOpenedTabs()
      const change: TabsChanged = {
        version: snap.version,
        origin: "server",
        tabs: snap.items,
      }
      if (!get().tabsHydrated) {
        const pending = pendingRemote
        if (!pending || snap.version >= pending.version) {
          pendingRemote = change
        }
        return
      }
      // While the tab set is still UNKNOWN (hydration failed, so local state is
      // device-local drafts only) the snapshot's CONTENTS matter, not just its
      // version: the backend's version key defaults to 0 when absent, so a
      // non-empty set can legitimately arrive as version 0 and lose the `>`
      // comparison. Treating that as "nothing new" would mark the set known
      // while keeping the drafts-only state, and the next invariant pass would
      // prune the real tabs' groups away and persist the wreckage. Applying is
      // safe on an equal version — `applyRemoteSnapshot` reconciles rather than
      // clobbering (its own guard is a strict `<`).
      if (snap.version > version || !tabsSnapshotLoaded) {
        applyRemoteSnapshot(change)
      } else {
        version = Math.max(version, snap.version)
      }
    } catch (err) {
      console.error("[TabStore] refetchTabs failed:", err)
    }
  },

  correctDraftAgents: () => {
    const candidates = get().rawTabs.filter((tab) => {
      if (tab.conversationId != null) return false
      if (tab.agentTypeProvisional) return true
      if (!runtime.sortedAvailableAgents.includes(tab.agentType)) return true
      return false
    })
    if (candidates.length === 0) return

    for (const tab of candidates) {
      void (async () => {
        const { agentType: newAgent } = resolveAgentForFolder(
          tab.folderId,
          null
        )
        const current = get().rawTabs.find((t) => t.id === tab.id)
        if (!current || current.conversationId != null) return

        if (current.agentType === newAgent) {
          if (!current.agentTypeProvisional) return
          const prev = get().rawTabs
          const next = prev.map((t) =>
            t.id === tab.id &&
            t.conversationId == null &&
            t.agentTypeProvisional
              ? { ...t, agentTypeProvisional: false }
              : t
          )
          if (next.every((t, i) => t === prev[i])) return
          set({ rawTabs: next })
          recomputeTabs()
          return
        }

        const expectedAgent = current.agentType
        try {
          await runtime.acpDisconnect(tab.id)
        } catch (err) {
          console.error("[TabStore] correct provisional disconnect:", err)
        }

        const prev = get().rawTabs
        const target = prev.find((t) => t.id === tab.id)
        if (!target) return
        if (target.conversationId != null) return
        if (
          target.agentType !== expectedAgent &&
          !target.agentTypeProvisional
        ) {
          return
        }
        set({
          rawTabs: prev.map((t) =>
            t.id === tab.id
              ? { ...t, agentType: newAgent, agentTypeProvisional: false }
              : t
          ),
        })
        recomputeTabs()
      })()
    }
  },

  recoverActiveContext: () => {
    const hint = loadLastActiveContext()
    if (hint?.isChat) {
      get().openChatModeTab()
      return
    }
    const folders = useAppWorkspaceStore.getState().folders
    if (hint) {
      const f = folders.find((x) => x.id === hint.folderId)
      if (f) {
        get().openNewConversationTab(f.id, f.path, { keepDraftWorktree: true })
        return
      }
    }
    // 读取标签失败时，上次聚焦的是会话（这时不记 hint），回到它的项目（#785）。
    const home = folders.find((x) => x.id === readFailedHomeFolderInSidebar())
    if (home) {
      get().openNewConversationTab(home.id, home.path)
      return
    }
    const first = folders[0]
    if (first) {
      get().openNewConversationTab(first.id, first.path, {
        keepDraftWorktree: true,
      })
      return
    }
    get().openChatModeTab()
  },

  consumePreviewReplaced: () => {
    const consumedIds = get().previewReplacedTabIds
    if (consumedIds.length === 0) return
    for (const tabId of consumedIds) {
      for (const cb of previewReplacedCallbacks) {
        cb(tabId)
      }
    }
    const prev = get().previewReplacedTabIds
    const matchesPrefix = consumedIds.every(
      (tabId, index) => prev[index] === tabId
    )
    if (!matchesPrefix) return
    set({ previewReplacedTabIds: prev.slice(consumedIds.length) })
  },

  consumeDraftRetargets: () => {
    const consumedRequests = get().draftRetargetRequests
    if (consumedRequests.length === 0) return

    const prev = get().draftRetargetRequests
    const matchesPrefix = consumedRequests.every(
      (request, index) => prev[index] === request
    )
    if (matchesPrefix) {
      set({
        draftRetargetRequests: prev.slice(consumedRequests.length),
      })
    }

    for (const request of consumedRequests) {
      void (async () => {
        try {
          await runtime.acpDisconnect(request.tabId)
        } catch (err) {
          console.error("[TabStore] disconnect draft tab:", err)
        }

        const rawTabs = get().rawTabs
        const target = rawTabs.find((tab) => tab.id === request.tabId)
        if (!target) return
        if (target.conversationId != null) return
        if (
          target.agentType !== request.expectedAgent &&
          !target.agentTypeProvisional
        ) {
          return
        }
        // Tabs follow the folder: a draft the user is still on carries the
        // view into its new folder, instead of vanishing from the scope it
        // leaves.
        const followScope =
          useFolderTabsStore.getState().enabled &&
          get().activeTabId === request.tabId &&
          folderScope(request.folderId) !== folderScope(target.folderId)
        set({
          rawTabs: rawTabs.map((tab) =>
            tab.id === request.tabId
              ? {
                  ...tab,
                  folderId: request.folderId,
                  workingDir: request.workingDir,
                  agentType: request.agentType,
                  agentTypeProvisional: request.provisional,
                  isChat: false,
                  pendingWorktree: request.pendingWorktree,
                }
              : tab
          ),
        })
        recomputeTabs()
        // 放回的新工作树选择（#1042）也要落盘，刷新后还在。
        if (request.pendingWorktree) persistGroupState()
        if (followScope) {
          useFolderTabsStore
            .getState()
            .activateScope(folderScope(request.folderId))
          focusTab(request.tabId)
        }
        if (useFolderTabsStore.getState().enabled) {
          closeBlankDraftsBeside(request.tabId)
        }
      })()
    }
  },

  syncActiveFolderId: () => {
    const st = get()
    const folderTabs = useFolderTabsStore.getState()
    const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId) ?? null
    if (folderTabs.enabled && (activeTab == null || !isTabInScope(activeTab))) {
      // An empty scope still owns the folder chrome (file tree, terminal).
      useAppWorkspaceStore
        .getState()
        .setActiveFolderId(
          folderTabs.scope === "global" ? null : folderTabs.scope
        )
      return
    }
    // Otherwise the active tab decides, exactly as in normal mode: a chat
    // conversation in the global scope keeps its hidden chat folder, which is
    // how chat mode is recognised (`useIsActiveChatMode`).
    useAppWorkspaceStore
      .getState()
      .setActiveFolderId(activeTab?.folderId ?? null)
  },

  persistLastActiveContext: () => {
    const st = get()
    if (!st.tabsHydrated) return
    const active = st.rawTabs.find((t) => t.id === st.activeTabId)
    if (!active) return
    if (active.conversationId == null) {
      saveLastActiveContext({
        folderId: active.folderId,
        isChat: active.isChat === true,
      })
    } else {
      clearLastActiveContext()
    }
  },

  setLabels: (labels) => {
    runtime.labels = labels
    recomputeTabs()
  },

  setSideEffects: (deps) => {
    runtime.activateConversationPane = deps.activateConversationPane
    runtime.acpDisconnect = deps.acpDisconnect
  },

  setAgentAvailability: (sortedTypes, fresh) => {
    runtime.sortedAvailableAgents = sortedTypes
    runtime.agentsFresh = fresh
  },
}))

/**
 * Correction / recovery are one-shot per session (module flags). `TabProvider`
 * calls these gate wrappers when their conditions flip, replacing the former
 * `correctionRanRef` / `recoveryRanRef`.
 */
export function runCorrectionOnce() {
  if (correctionRan) return
  correctionRan = true
  useTabStore.getState().correctDraftAgents()
}

/**
 * 刷新后回到本机上次停在的项目（#741）。TabProvider 在跟随模式按存的设置
 * 恢复以后调一次：这时的项目是从选中的标签推出来的，停在没开会话的项目里
 * 刷新会落到别的项目。存的项目已经不在侧栏里时不动，照旧按标签走。切项目
 * 由 folder-tabs 的订阅者接着选这个项目里的标签（没有就不选）、同步当前项目。
 */
export function restorePersistedFolderScope() {
  const scope = pendingRestoreActiveScope
  pendingRestoreActiveScope = null
  const folderTabs = useFolderTabsStore.getState()
  if (!folderTabs.enabled) return
  if (
    scope != null &&
    scope !== folderTabs.scope &&
    (scope === "global" ||
      useAppWorkspaceStore.getState().folders.some((f) => f.id === scope))
  ) {
    folderTabs.activateScope(scope)
  }
  // 读取标签失败、停在全局又一个标签都没有时（上次停在全局，或者老记录没记
  // 项目），推不出当前项目，「新建会话」会退成聊天。回到本机上次聚焦的会话
  // 所在的项目（#785）。
  const home = readFailedHomeFolderInSidebar()
  if (
    home != null &&
    useFolderTabsStore.getState().scope === "global" &&
    !useTabStore.getState().rawTabs.some(isTabInScope)
  ) {
    useFolderTabsStore.getState().activateScope(home)
  }
}

/** 从会话标签的规范 id（conv-项目-agent-会话）取出项目 id。 */
function folderOfConversationTabId(id: string | null): number | null {
  const m = id != null ? /^conv-(\d+)-/.exec(id) : null
  const folderId = m ? Number(m[1]) : NaN
  return Number.isInteger(folderId) && folderId > 0 ? folderId : null
}

/** 读取失败期间可以回去的项目：还在侧栏里才算（#785）。 */
function readFailedHomeFolderInSidebar(): number | null {
  if (!snapshotReadFailed || readFailedHomeFolder == null) return null
  const home = readFailedHomeFolder
  return useAppWorkspaceStore.getState().folders.some((f) => f.id === home)
    ? home
    : null
}

export function runRecoveryOnce() {
  if (recoveryRan || useFolderTabsStore.getState().enabled) return
  recoveryRan = true
  // 读取失败时补出来的草稿只是占位，不是用户选的焦点（#785）。补的过程中就会
  // 写 blob，所以先挂上标记，让那次写把新开的草稿认成占位。
  readFailedRecovering = snapshotReadFailed
  try {
    useTabStore.getState().recoverActiveContext()
  } finally {
    readFailedRecovering = false
  }
}

/**
 * Drop restored drafts whose folder no longer exists (deleted while the app was
 * closed, so no `closeTabsByFolder` ever ran). Folder-blind at hydrate time by
 * design — hydration must not wait on the folder list — so this runs once the
 * folders land, and `applyGroupInvariants` collapses any group it empties.
 * Chat drafts are folderless (`folderId` 0) and always survive.
 */
export function pruneOrphanDraftsOnce() {
  if (orphanDraftPruneRan) return
  orphanDraftPruneRan = true
  const st = useTabStore.getState()
  const { allFolders } = useAppWorkspaceStore.getState()
  const orphaned = st.rawTabs.filter(
    (tab) =>
      tab.conversationId == null &&
      tab.isChat !== true &&
      !allFolders.some((folder) => folder.id === tab.folderId)
  )
  if (orphaned.length === 0) return
  const orphanIds = new Set(orphaned.map((tab) => tab.id))
  const next = st.rawTabs.filter((tab) => !orphanIds.has(tab.id))
  useTabStore.setState({
    rawTabs: next,
    activeTabId:
      st.activeTabId != null && orphanIds.has(st.activeTabId)
        ? (next[0]?.id ?? null)
        : st.activeTabId,
  })
  for (const tab of orphaned) {
    clearMessageInputDraftV2(buildNewConversationDraftStorageKey(tab.id))
  }
  recomputeTabs()
}

// Recompute `tabs` whenever the app-workspace `conversations` list changes (any
// agent's turn start/stop): titles/status decorate from it. Reference reuse in
// recomputeTabs keeps the array stable when no open tab is affected.
useAppWorkspaceStore.subscribe((next, previous) => {
  const c = next.conversations
  if (c !== lastConversations) {
    lastConversations = c
    recomputeTabs()
  } else if (previous.conversationsLoading && !next.conversationsLoading) {
    // A refetch just settled. Its rows landed while it still read as loading,
    // when `alignConversationTabFolders` holds off; run it now.
    recomputeTabs()
  }
})

// ── Tab cap (jenny fork) ─────────────────────────────────────────────────────
// At most MAX_CONVERSATION_TABS conversation tabs stay open. Any change that
// pushes the strip over the cap (open, reopen, split, hydrate, a remote
// snapshot) closes the least recently used tabs. The close is deferred to a
// microtask so the action that added the tab finishes first, and it still
// lands before the next paint. Closing never stops a running turn: the tab
// unmount teardown skips busy connections (see connection-teardown.ts).
const conversationTabRecency = new TabRecency()
let tabCapScheduled = false

/** A draft tab whose composer holds something the user has not sent (saved
 *  text, or typing and attachments not saved yet). Closing it would discard
 *  that, so the cap leaves it open. */
function hasUnsentDraft(tab: TabItemInternal): boolean {
  return tab.conversationId == null && !isBlankDraft(tab)
}

function enforceConversationTabCap() {
  tabCapScheduled = false
  // Read on every pass, so it applies only to the change that a reopen made.
  const toBottom = takeClosedTabJustReopened()
  const { rawTabs, activeTabId, tabsHydrated, groupLayout, groupSelection } =
    useTabStore.getState()
  if (!tabsHydrated || rawTabs.length <= MAX_CONVERSATION_TABS) return
  const byId = new Map(rawTabs.map((tab) => [tab.id, tab]))
  // While split, each pane's shown tab stays: closing it would collapse the
  // pane under the user.
  const shown = new Set(
    groupLayout.type === "group" ? [] : Object.values(groupSelection)
  )
  const victims = pickTabsToEvict(
    rawTabs.map((tab) => tab.id),
    MAX_CONVERSATION_TABS,
    conversationTabRecency,
    (id) => {
      const tab = byId.get(id)
      return (
        id === activeTabId ||
        shown.has(id) ||
        (tab != null && hasUnsentDraft(tab))
      )
    }
  )
  // A tab closed to make room for a reopened one goes under the older
  // entries, so repeated ⌘⇧T walks back through all of them.
  for (const id of victims) {
    if (toBottom) {
      const index = useTabStore.getState().rawTabs.findIndex((t) => t.id === id)
      const tab = byId.get(id)
      if (tab && index >= 0) {
        pushClosedTabBottom(snapshotConversationTab(tab, index))
      }
      useTabStore.getState().closeTab(id, { recordForReopen: false })
    } else {
      useTabStore.getState().closeTab(id)
    }
  }
}

useTabStore.subscribe((state, prev) => {
  if (
    state.rawTabs === prev.rawTabs &&
    state.activeTabId === prev.activeTabId &&
    state.tabsHydrated === prev.tabsHydrated
  ) {
    return
  }
  conversationTabRecency.sync(
    state.rawTabs.map((tab) => tab.id),
    state.activeTabId
  )
  if (
    !tabCapScheduled &&
    state.tabsHydrated &&
    state.rawTabs.length > MAX_CONVERSATION_TABS
  ) {
    tabCapScheduled = true
    queueMicrotask(enforceConversationTabCap)
  } else if (
    !tabCapScheduled &&
    state.rawTabs !== prev.rawTabs &&
    state.rawTabs.length <= MAX_CONVERSATION_TABS
  ) {
    // A reopen that fit under the cap: nothing to send to the bottom.
    takeClosedTabJustReopened()
  }
})

/** All tab actions as a shallow-stable object. Actions never change identity, so
 *  this hook never triggers a re-render — consumers that only dispatch use it
 *  instead of subscribing to any state slice. */
export function useTabActions() {
  return useTabStore(
    useShallow((s) => ({
      openTab: s.openTab,
      closeTab: s.closeTab,
      closeConversationTab: s.closeConversationTab,
      closeOtherTabs: s.closeOtherTabs,
      closeAllTabs: s.closeAllTabs,
      closeTabsByFolder: s.closeTabsByFolder,
      switchTab: s.switchTab,
      pinTab: s.pinTab,
      toggleGroupTile: s.toggleGroupTile,
      splitTab: s.splitTab,
      moveTabToGroup: s.moveTabToGroup,
      toggleGroupOrientation: s.toggleGroupOrientation,
      dissolveGroup: s.dissolveGroup,
      unsplitAll: s.unsplitAll,
      reorderGroupTabs: s.reorderGroupTabs,
      resizeGroupSplit: s.resizeGroupSplit,
      updateTabDrag: s.updateTabDrag,
      endTabDrag: s.endTabDrag,
      openNewConversationTab: s.openNewConversationTab,
      openChatModeTab: s.openChatModeTab,
      setChatDraftWorkingDir: s.setChatDraftWorkingDir,
      setDraftWorktree: s.setDraftWorktree,
      confirmDraftAgent: s.confirmDraftAgent,
      setDraftAgentFromFallback: s.setDraftAgentFromFallback,
      bindConversationTab: s.bindConversationTab,
      setTabRuntimeConversationId: s.setTabRuntimeConversationId,
      reorderTabs: s.reorderTabs,
      consumeRemoteActivation: s.consumeRemoteActivation,
      onPreviewTabReplaced: s.onPreviewTabReplaced,
    }))
  )
}

/**
 * Restore pristine state (store + module coordination vars + injected runtime).
 * Used by tests, and by the backend-scoped reset registry if a realm's backend
 * identity ever changes (an invariant-violating transition that does not occur
 * today — see `RemoteConnectionGate`). In normal operation the store lives for
 * the window's lifetime and is never reset.
 */
export function resetTabStore() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (groupPersistTimer) {
    clearTimeout(groupPersistTimer)
    groupPersistTimer = null
  }
  version = 0
  applyingRemote = false
  remoteActivationPending = false
  pendingRemote = null
  lastSavedPayload = null
  serverKnownTabKeys = new Set()
  lastGroupBlob = null
  childSummaryInFlight.clear()
  childSeedBuffer.clear()
  seedEpoch = 0
  previewReplacedCallbacks.clear()
  correctionRan = false
  recoveryRan = false
  orphanDraftPruneRan = false
  tabsSnapshotLoaded = false
  snapshotReadFailed = false
  readFailedBlobBaseline = null
  readFailedHomeFolder = null
  readFailedFillerDraftId = null
  conversationTabRecency.clear()
  runtime = defaultRuntime()
  lastConversations = useAppWorkspaceStore.getState().conversations
  // Merge (not replace) so the action methods are preserved; only the data
  // fields reset to their initial values.
  useTabStore.setState(initialTabState())
}

// Reset this backend-scoped store on any (currently-unreachable) in-realm
// backend switch. See `backend-scoped-store-reset.ts`.
registerBackendScopedStoreReset(resetTabStore)

/**
 * Standalone `applyRemoteSnapshot` (not a store method: it is only called
 * internally by handleTabsChanged / refetchTabs / hydrate, and closing over the
 * module coordination vars keeps the semantics identical to the former
 * `applyRemoteSnapshot` callback).
 */
function applyRemoteSnapshot(change: TabsChanged) {
  // Stale-safe: a snapshot older than what we've applied must not move the UI or
  // version backwards. Equal versions still reconcile.
  if (change.version < version) return
  version = change.version
  // An authoritative tab set just landed: if hydration had failed, this is what
  // un-parks the invariant prune and the blob write (see `tabsSnapshotLoaded`).
  tabsSnapshotLoaded = true
  snapshotReadFailed = false
  readFailedFillerDraftId = null
  // A newer remote truth supersedes any debounced local save still waiting.
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const snapshotItems = change.tabs.filter((it) => it.conversation_id != null)

  const prev = useTabStore.getState()
  // ── Three-way merge against `serverKnownTabKeys` (the common ancestor) ──────
  // A snapshot is the SERVER's set, not a newer truth about ours: the two can
  // have diverged in both directions since the last sync. Classify per tab
  // instead of adopting wholesale.
  const ancestorKeys = serverKnownTabKeys
  const snapshotKeys = snapshotSyncKeys(snapshotItems)
  serverKnownTabKeys = snapshotKeys
  const localKeys = new Set<string>()
  for (const tb of prev.rawTabs) {
    const key = tabSyncKey(tb)
    if (key) localKeys.add(key)
  }
  // Present on the server but gone here AND the server already had it at our
  // last sync → we closed it locally and our save hasn't landed (or was just
  // rejected). The local close is the newer intent: keep it closed. Anything
  // else on the server is adopted — including tabs opened on another client.
  const convItems = snapshotItems.filter((it) => {
    const key = conversationSyncKey(it.agent_type, it.conversation_id as number)
    return localKeys.has(key) || !ancestorKeys.has(key)
  })
  // Open here, absent from the snapshot, and never acknowledged by the server →
  // a local addition the snapshot simply predates (a draft that just bound to a
  // freshly-created conversation is the important one). Keep it and push it;
  // dropping it would strand a live, streaming conversation with no tab. A tab
  // the server DID know and no longer lists was closed elsewhere — that one
  // still goes away, which is the whole point of the ancestor set.
  const unsyncedLocal = prev.rawTabs.filter((tb) => {
    const key = tabSyncKey(tb)
    if (!key) return false
    return !snapshotKeys.has(key) && !ancestorKeys.has(key)
  })
  // Our set is ahead of the server's in at least one direction, so this apply
  // must NOT arm the echo guard or seed the no-op baseline — the save effect has
  // to push the merged set (against the version we just learned) or the
  // divergence never converges.
  const diverged =
    unsyncedLocal.length > 0 || convItems.length !== snapshotItems.length

  applyingRemote = !diverged

  const prevById = new Map(prev.rawTabs.map((tb) => [tb.id, tb]))
  const claimedIds = new Set<string>()
  const remoteTabs: TabItemInternal[] = convItems.map((it) => {
    const canonicalId = makeConversationTabId(
      it.folder_id,
      it.agent_type,
      it.conversation_id as number
    )
    // Prefer an already-open local tab for this conversation (including a draft
    // that just bound to it and still carries its `new-*` id) so we keep that
    // stable id and its live runtime session — in whichever folder it is open
    // here: the conversation may have been moved to another project, and the
    // snapshot's folder is then the newer one.
    const found =
      prevById.get(canonicalId) ??
      prev.rawTabs.find(
        (tb) =>
          tb.conversationId === it.conversation_id &&
          tb.agentType === it.agent_type
      )
    const existing = found && !claimedIds.has(found.id) ? found : undefined
    if (existing) claimedIds.add(existing.id)
    const sameFolder = existing?.folderId === it.folder_id
    return {
      id: existing?.id ?? canonicalId,
      kind: "conversation",
      folderId: it.folder_id,
      conversationId: it.conversation_id,
      agentType: it.agent_type,
      title: existing?.title ?? runtime.labels.loadingConversation,
      isPinned: it.is_pinned,
      runtimeConversationId: existing?.runtimeConversationId,
      status: existing?.status,
      // Device-local per-tab fields the payload doesn't carry. Rebuilding the
      // tab from the snapshot must not blank them (a bound chat tab would lose
      // the scratch working dir it is connected in) — unless the folder
      // changed, when the working dir is re-derived from the new one.
      workingDir: sameFolder ? existing?.workingDir : undefined,
      isChat: existing?.isChat,
    }
  })

  const folders = useAppWorkspaceStore.getState().folders
  // Keep every device-local draft (one per split group) that's a folderless
  // chat draft or whose real folder still exists. Never yank the user off an
  // in-progress draft.
  // 本机新增的标签插回它原来的位置，不追加到最后（#626）：首次读取失败时补回
  // 的（未确认的会话标签和草稿）一起按 blob 里记下的位置插回，补回的预览标签
  // 替掉同组里快照带来的预览；其余本机新增的会话标签紧跟在本机顺序里排它前面、
  // 且仍保留的那个标签后面。
  const restoredIndex = restoredLocalIndex
  restoredLocalIndex = new Map()
  const keptDrafts = prev.rawTabs.filter(
    (tb) =>
      tb.conversationId == null &&
      (tb.isChat === true || folders.some((f) => f.id === tb.folderId))
  )
  const recordedEntries: RestoredLocalEntry[] = []
  for (const tab of [...unsyncedLocal, ...keptDrafts]) {
    const index = restoredIndex.get(tab.id)
    if (index != null) recordedEntries.push({ tab, index })
  }
  const nextTabs = spliceAtRecordedIndex(
    dropRivalPreviews(
      remoteTabs,
      recordedEntries
        .map((entry) => entry.tab)
        .filter((tab) => tab.conversationId != null)
    ),
    recordedEntries
  )
  for (const tab of unsyncedLocal) {
    if (restoredIndex.has(tab.id)) continue
    const prevIndex = prev.rawTabs.indexOf(tab)
    let insertAt = 0
    for (let i = prevIndex - 1; i >= 0; i--) {
      const at = nextTabs.findIndex((tb) => tb.id === prev.rawTabs[i].id)
      if (at !== -1) {
        insertAt = at + 1
        break
      }
    }
    nextTabs.splice(insertAt, 0, tab)
  }
  for (const localDraft of keptDrafts) {
    if (restoredIndex.has(localDraft.id)) continue
    nextTabs.push(localDraft)
  }

  // Never leave the workspace blank: synthesize a draft when empty.
  if (nextTabs.length === 0) {
    if (folders.length === 0 || useFolderTabsStore.getState().enabled) {
      lastSavedPayload = diverged ? null : JSON.stringify([])
      useTabStore.setState({ rawTabs: [], activeTabId: null })
      recomputeTabs()
      return
    }
    const replacement = makeReplacementDraftTab()
    lastSavedPayload = diverged
      ? null
      : JSON.stringify(buildPersistItems([replacement], replacement.id))
    useTabStore.setState({
      rawTabs: [replacement],
      activeTabId: replacement.id,
    })
    recomputeTabs()
    return
  }

  // Focus resolution. Cowork: focus is per device — the snapshot's
  // `is_active` (another client's focus) is never followed, so looking at a
  // conversation on one computer doesn't switch what another one shows. Keep
  // our focus if it survived; if it left (closed elsewhere), re-pick its
  // neighbor the way a local close does.
  let nextActiveId: string | null
  if (
    prev.activeTabId != null &&
    nextTabs.some((tb) => tb.id === prev.activeTabId)
  ) {
    nextActiveId = prev.activeTabId
  } else if (prev.activeTabId != null) {
    nextActiveId = focusAfterLosing(prev, nextTabs, prev.activeTabId)
  } else {
    nextActiveId = nextTabs[0].id
  }

  if (useFolderTabsStore.getState().enabled) {
    // Remote clients synchronize open membership, but cannot move this client's
    // explicit folder scope or steal its current local selection.
    const visible = nextTabs.filter(isTabInScope)
    nextActiveId = visible.some((tab) => tab.id === prev.activeTabId)
      ? prev.activeTabId
      : (visible[0]?.id ?? null)
  }

  // A focus change driven by the remote snapshot must not trip the route-sync
  // chokepoint into the conversations route.
  if (nextActiveId !== prev.activeTabId) {
    remoteActivationPending = true
  }
  // Seed the last-saved payload from the state we're about to commit so the
  // guarded save-effect run is a confirmed no-op AND a passive focus fallback
  // never propagates to yank another client. When the merge diverged from the
  // server there is nothing to seed — clearing the baseline is what lets the
  // save effect push the difference back.
  lastSavedPayload = diverged
    ? null
    : JSON.stringify(buildPersistItems(nextTabs, nextActiveId))
  useTabStore.setState({ rawTabs: nextTabs, activeTabId: nextActiveId })
  recomputeTabs()
}

// A scope change swaps the view on screen: the leaving view's group state is
// parked, the arriving one's loaded, and the selection repaired. Membership and
// server persistence always keep the complete tab set, including live
// background sessions.
useFolderTabsStore.subscribe((next, previous) => {
  if (next.scope === previous.scope && next.enabled === previous.enabled) return
  const st = useTabStore.getState()
  const leavingKey = groupViewKey(previous)
  const arrivingKey = groupViewKey(next)
  // Only a folder SWITCH offers the folder's last tab back. Turning the mode on
  // starts from the tab (and per-group picks) the user is looking at.
  let remembered: string | null = null
  if (leavingKey !== arrivingKey) {
    const leaving = groupViewOnScreen(st)
    let views: Record<string, GroupView>
    let arriving: GroupView
    if (next.enabled) {
      views = { ...st.groupViews, [leavingKey]: leaving }
      arriving =
        views[arrivingKey] ??
        projectGroupView(
          views[ALL_GROUP_VIEW] ?? leaving,
          st.rawTabs.filter(isTabInScope),
          st.tabsHydrated && tabsSnapshotLoaded
        )
      delete views[arrivingKey]
      if (previous.enabled) remembered = arriving.active
    } else {
      // One layout for every tab again: the normal-mode one as it was left.
      // Folder views go with the mode; next time each starts from that one.
      arriving = st.groupViews[ALL_GROUP_VIEW] ?? leaving
      views = {}
    }
    useTabStore.setState({
      groupLayout: arriving.layout,
      groupOf: arriving.groupOf,
      groupSelection: arriving.selection,
      tileByGroup: arriving.tileByGroup,
      groupViews: views,
      tabDrag: null,
    })
  }
  const after = useTabStore.getState()
  if (next.enabled) {
    const visible = after.rawTabs.filter(isTabInScope)
    const active = remembered ?? after.activeTabId
    useTabStore.setState({
      activeTabId: visible.some((t) => t.id === active)
        ? active
        : (visible[0]?.id ?? null),
    })
  } else if (!after.rawTabs.some((tab) => tab.id === after.activeTabId)) {
    useTabStore.setState({ activeTabId: after.rawTabs[0]?.id ?? null })
  }
  applyGroupInvariants()
  if (previous.enabled && !next.enabled) {
    closeBlankDraftsPerGroup()
    if (previous.scope !== "global") keepFolderOnScreen(previous.scope)
  }
  useTabStore.getState().syncActiveFolderId()
})

/**
 * 关掉「标签页跟随文件夹」时，原来停着的项目（`folderId`）还留在屏幕上。
 * 普通模式由当前标签决定项目：当前标签不在这个项目里，就换成它的第一个标签；
 * 这个项目一个标签都没有（跟随模式下撑着它的是 scope），就在当前分组里给它
 * 开一个空草稿。不走 `openNewConversationTab`：那条路会把分组里别的项目的草稿
 * 改挂到这个项目、还会把主区切回会话面板，用户只是取消了一个勾。
 */
function keepFolderOnScreen(folderId: number) {
  const st = useTabStore.getState()
  const inFolder = (tab: TabItemInternal) =>
    folderScope(tab.folderId) === folderId
  const active = st.rawTabs.find((t) => t.id === st.activeTabId)
  if (active && inFolder(active)) return
  const first = st.rawTabs.find(inFolder)
  if (first) {
    focusTab(first.id)
    return
  }
  const folder = useAppWorkspaceStore
    .getState()
    .folders.find((f) => f.id === folderId)
  if (!folder) return
  const group = resolveTargetGroup(st)
  const { agentType, provisional } = resolveAgentForFolder(folder.id, null)
  const tabId = makeNewConversationTabId()
  useTabStore.setState({
    rawTabs: [
      ...st.rawTabs,
      {
        id: tabId,
        kind: "conversation",
        folderId: folder.id,
        conversationId: null,
        agentType,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir: folder.path,
        agentTypeProvisional: provisional,
      },
    ],
    activeTabId: tabId,
    groupOf: { ...st.groupOf, [tabId]: group },
  })
  recomputeTabs()
  // 一个分组一个草稿：同组里别的项目的空草稿关掉；有内容的留着（两个草稿
  // 好过丢掉用户打的字）。
  for (const tab of useTabStore.getState().rawTabs) {
    if (
      tab.id !== tabId &&
      tab.conversationId == null &&
      isBlankDraft(tab) &&
      groupOfTab(
        useTabStore.getState().groupOf,
        useTabStore.getState().groupLayout,
        tab.id
      ) === group
    ) {
      useTabStore.getState().closeTab(tab.id, { recordForReopen: false })
    }
  }
  applyGroupInvariants()
}

/** The stored mode came back off at hydration: folder views parked from the
 *  last session's blob are stale by now, so they go (turning the mode on later
 *  starts every folder from the normal-mode layout). */
export function dropParkedFolderGroupViews() {
  const st = useTabStore.getState()
  if (useFolderTabsStore.getState().enabled) return
  if (Object.keys(st.groupViews).length === 0) return
  useTabStore.setState({ groupViews: {} })
  persistGroupState()
}

// A scope whose folder left the workspace (its worktree was deleted, or the
// folder was removed from the sidebar) would keep the folder chrome — file
// tree, terminal, search — pointed at it. `closeTabsByFolder` cannot catch
// this: it returns early for a folder with no tabs. Move to the parent repo
// when it is still open, else to a remaining tab's scope, else the first
// open folder.
useAppWorkspaceStore.subscribe((next, previous) => {
  if (
    next.folders === previous.folders &&
    next.foldersHydrated === previous.foldersHydrated
  ) {
    return
  }
  const folderTabs = useFolderTabsStore.getState()
  const scope = folderTabs.scope
  if (!folderTabs.enabled || scope === "global" || !next.foldersHydrated) return
  const isOpen = (id: number | null | undefined) =>
    id != null && next.folders.some((f) => f.id === id)
  if (isOpen(scope)) return
  const parentId = (
    previous.allFolders.find((f) => f.id === scope) ??
    next.allFolders.find((f) => f.id === scope)
  )?.parent_id
  const fromTabs = useTabStore
    .getState()
    .rawTabs.map((tab) => folderScope(tab.folderId))
    .find((s) => s !== scope && (s === "global" || isOpen(s)))
  const target: TabScope =
    parentId != null && isOpen(parentId)
      ? parentId
      : (fromTabs ?? next.folders[0]?.id ?? "global")
  folderTabs.activateScope(target)
})
