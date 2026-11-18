// 智能体还没连上时，新草稿按回车就把会话建出来（AI QA #650）。
//
// 以前要等连上才建会话：这段时间消息只在页面内存的排队区里（没有会话号，
// 存不下来），侧栏也没有这个会话，一刷新就全没了。现在一按
// 回车就建会话、绑到这个标签上，排队区随即按会话号存起来（#159 的规则：
// 刷新回来读成失败、带重试），连上以后由排队区的自动发送照已有会话发出。

import { getActiveRemoteConnectionId } from "@/lib/transport"
import type {
  AgentType,
  CreateChatConversationResult,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"

export interface DraftEarlyCreateGate {
  /** 这个标签已经有会话行了。 */
  persisted: boolean
  /** 已经有一次建会话在路上（和发送那条路共用的单飞）。 */
  createPending: boolean
  /** 不选文件夹的 chat 草稿。 */
  isChat: boolean
  /** chat 草稿事先建好的临时目录；还没建好时不提前建会话（否则会另建一个目录，连接的 cwd 对不上）。 */
  chatDir: string | null | undefined
}

/** 这次发送要不要当场把会话建出来。 */
export function shouldCreateDraftEarly(gate: DraftEarlyCreateGate): boolean {
  if (gate.persisted || gate.createPending) return false
  if (gate.isChat && !gate.chatDir) return false
  return true
}

export interface QueuedDraftEarlyCreateGate {
  connectionReady: boolean
  /** 这个标签已经有会话行了。 */
  persisted: boolean
  queueLength: number
  /** 队首是失败的（刷新读回来的就是）：等用户点重试，不自动建。 */
  headFailed: boolean
  /** 要在新工作树里开的草稿：有自己的那条路。 */
  pendingWorktree: boolean
}

/**
 * 回车时没能当场建会话（chat 草稿的临时目录还没好），消息还在排队等连接：
 * 现在要不要补建。连接好了的交给自动发送那条路；刷新读回来的失败消息不建，
 * 刷新前那次建会话可能已经成功了，等用户点重试，免得建两个。
 */
export function queuedDraftNeedsEarlyCreate(
  gate: QueuedDraftEarlyCreateGate
): boolean {
  if (gate.connectionReady || gate.persisted || gate.pendingWorktree)
    return false
  return gate.queueLength > 0 && !gate.headFailed
}

/**
 * 单飞地跑一次建会话：条件不满足或已有一次在路上时返回 null、什么都不做；
 * 否则占住 `pendingRef`，跑完（成功或失败）都放开。失败交给 `onError`，
 * 消息还在排队区里，连上以后发送那条路会再建一次。
 */
export function startDraftCreateEarly(
  pendingRef: { current: boolean },
  gate: Omit<DraftEarlyCreateGate, "createPending">,
  task: () => Promise<void>,
  onError: (error: unknown) => void
): Promise<void> | null {
  if (!shouldCreateDraftEarly({ ...gate, createPending: pendingRef.current }))
    return null
  pendingRef.current = true
  return (async () => {
    try {
      await task()
    } catch (e) {
      onError(e)
    } finally {
      pendingRef.current = false
    }
  })()
}

// ── 建会话请求的票据（#650 第 2 次返工）──────────────────────────────────
//
// 按回车后马上刷新：建会话的请求可能已经在后端成功了，浏览器却没收到会话号，
// 刷新回来的草稿标签没绑上会话。用户点重试时如果再建一次，就会多出一个空会话。
// 所以发请求之前先按标签记一张票据（这次要建的智能体、标题、文件夹、什么时候发的），
// 建好、绑上标签以后清掉；刷新回来再建时，有票据就先去会话列表里找那次建出来的行
// （同一个智能体、同一个标题、同一个文件夹或临时目录、还没有消息、时间对得上），
// 找到就直接用它，找不到才真的建。
//
// 第 4 次返工：只按这些条件找，同一文件夹里恰好有另一条同标题的空会话时会认错，
// 消息发进别的对话。所以记票据前先查一次列表，把当时已经存在、条件相同的行的
// 会话号记进票据（knownIds），找回时排除它们：那次请求建出来的行一定不在里面。
// 排除以后还剩不止一条的，分不清哪条是自己的，不认，照常建（多一个空会话总比
// 消息进错对话好）。记票据前那次查列表失败的，这次不建（第 8 次返工：以前是
// 照常建、不记票据，刷新后就认不回来），「要建」的票据留着。

const TICKET_PREFIX = "cowork:draft-create:v1"
/** 票据过了这么久就不认了（刷新回来点重试一般在几分钟内）。 */
export const DRAFT_CREATE_TICKET_MAX_AGE_MS = 30 * 60 * 1000
/** 后端记的建会话时间和票据时间最多差多少（两边的时钟可能不准）。 */
export const DRAFT_CREATE_CLOCK_SLACK_MS = 10 * 60 * 1000

export interface DraftCreateTicket {
  /** 发请求的时间（浏览器时钟，毫秒）。 */
  startedAt: number
  agent: AgentType
  title: string
  chat: boolean
  /** 普通会话建在哪个文件夹；chat 是 null。 */
  folderId: number | null
  /** chat 复用的临时目录；没有时是 null。 */
  chatDir: string | null
  /**
   * 发请求前就已经存在、条件相同的会话号：找回时不认它们。
   * null：回车时先记下的「要建」，建会话的请求还没发出去（第 7 次返工），
   * 刷新回来不用找，直接建。
   */
  knownIds: number[] | null
}

export function draftCreateTicketKey(tabId: string): string {
  const remoteId = getActiveRemoteConnectionId()
  const scope = remoteId == null ? "local" : `remote-${remoteId}`
  return `${TICKET_PREFIX}:${scope}:${tabId}`
}

function ticketStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
  }
}

function isTicket(value: unknown): value is DraftCreateTicket {
  if (!value || typeof value !== "object") return false
  const t = value as Record<string, unknown>
  return (
    typeof t.startedAt === "number" &&
    typeof t.agent === "string" &&
    typeof t.title === "string" &&
    typeof t.chat === "boolean" &&
    (t.folderId === null || typeof t.folderId === "number") &&
    (t.chatDir === null || typeof t.chatDir === "string") &&
    (t.knownIds === null ||
      (Array.isArray(t.knownIds) &&
        t.knownIds.every((id) => typeof id === "number")))
  )
}

/** 读这个标签的票据；没有、读不出、过期了都是 null。 */
export function readDraftCreateTicket(
  tabId: string,
  now: number = Date.now()
): DraftCreateTicket | null {
  const store = ticketStorage()
  if (!store) return null
  try {
    const raw = store.getItem(draftCreateTicketKey(tabId))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isTicket(parsed)) return null
    if (now - parsed.startedAt > DRAFT_CREATE_TICKET_MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function writeDraftCreateTicket(
  tabId: string,
  ticket: DraftCreateTicket
): void {
  try {
    ticketStorage()?.setItem(
      draftCreateTicketKey(tabId),
      JSON.stringify(ticket)
    )
  } catch {
    // 存不下就算了：最坏是刷新后重试多建一个空会话，和以前一样。
  }
}

export function clearDraftCreateTicket(tabId: string): void {
  try {
    ticketStorage()?.removeItem(draftCreateTicketKey(tabId))
  } catch {
    // 同上
  }
}

type DraftCreateMatch = Pick<
  DraftCreateTicket,
  "agent" | "title" | "chat" | "folderId"
>

/** 这一行和要建的会话条件相同：同智能体、标题、种类、文件夹，空的、不是子会话。 */
function sameDraftShape(
  match: DraftCreateMatch,
  row: DbConversationSummary
): boolean {
  if (row.agent_type !== match.agent) return false
  if ((row.title ?? "") !== match.title) return false
  if (row.kind !== (match.chat ? "chat" : "regular")) return false
  if (!match.chat && row.folder_id !== match.folderId) return false
  if (row.message_count !== 0 || row.external_id != null) return false
  return row.parent_id == null
}

/**
 * 票据对应的那次建会话建出来的行可能是哪几条（新的在前）：同一个智能体、
 * 同一个标题、同一种（chat / 普通）、普通会话还要同一个文件夹，没有消息、
 * 没有绑智能体会话，建的时间和票据对得上。chat 的临时目录要另外查文件夹才知道。
 */
export function adoptableDraftConversations(
  ticket: DraftCreateTicket,
  rows: readonly DbConversationSummary[]
): DbConversationSummary[] {
  const known = ticket.knownIds
  // 请求还没发出去：不会有那次建出来的行
  if (known == null) return []
  return rows
    .filter((row) => {
      if (!sameDraftShape(ticket, row)) return false
      // 发请求前就在的行不是那次建出来的
      if (known.includes(row.id)) return false
      const created = Date.parse(row.created_at)
      if (Number.isNaN(created)) return false
      return Math.abs(created - ticket.startedAt) <= DRAFT_CREATE_CLOCK_SLACK_MS
    })
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
}

export interface DraftCreateSpec {
  tabId: string
  chat: boolean
  agent: AgentType
  title: string
  /** 普通会话的文件夹；chat 不看它。 */
  folderId: number
  chatDir: string | null | undefined
}

export interface DraftCreateResult {
  conversationId: number
  /** chat 会话所在的隐藏文件夹；普通会话是 null。 */
  folderId: number | null
  folder: FolderDetail | null
  /** 用的是刷新前那次已经建好的行。 */
  adopted: boolean
}

export interface DraftCreateDeps {
  listAllConversations: (params: {
    agent_type: AgentType
    folder_ids: number[] | null
  }) => Promise<DbConversationSummary[]>
  getFolder: (folderId: number) => Promise<FolderDetail>
  createConversation: (
    folderId: number,
    agent: AgentType,
    title: string
  ) => Promise<number>
  createChatConversation: (
    agent: AgentType,
    title: string,
    chatDir: string | undefined
  ) => Promise<CreateChatConversationResult>
  /** 把行标成不在运行（后端建行时就记成「进行中」）。 */
  markConversationNotRunning: (conversationId: number) => Promise<void>
}

// #650 第 5 次返工（P1-2）：后端建会话行时就把它记成「进行中」，第一条消息
// 发出去以后才真的在跑。提前建好、消息却没发出去（发送失败、排队的消息被删、
// 刷新后等着点重试）的会话，侧栏会一直转圈、算进「N 个会话进行中」。所以建好
// 或找回的行交给调用方之前先标成不在运行；真发消息时后端会再标回「进行中」。
// 标失败只记日志：会话照样能用，只是侧栏多转一会儿。
async function markNotRunning(
  deps: DraftCreateDeps,
  conversationId: number
): Promise<void> {
  try {
    await deps.markConversationNotRunning(conversationId)
  } catch (e) {
    console.error("[draft-early-create] mark conversation not running:", e)
  }
}

type TicketMatch =
  | { kind: "found"; result: DraftCreateResult }
  | { kind: "none" }
  | { kind: "unclear" }

/** 按票据在列表里认那次建会话建出来的行：排除已有的以后正好一条才认。 */
async function matchTicket(
  ticket: DraftCreateTicket,
  rows: readonly DbConversationSummary[],
  deps: Pick<DraftCreateDeps, "getFolder">
): Promise<TicketMatch> {
  const candidates: {
    row: DbConversationSummary
    folder: FolderDetail | null
  }[] = []
  for (const row of adoptableDraftConversations(ticket, rows)) {
    if (!ticket.chat) {
      candidates.push({ row, folder: null })
      continue
    }
    const folder = await deps.getFolder(row.folder_id)
    if (ticket.chatDir == null || folder.path === ticket.chatDir) {
      candidates.push({ row, folder })
    }
  }
  if (candidates.length === 0) return { kind: "none" }
  // 不止一条分不清哪条是那次建的，不冒险
  if (candidates.length > 1) return { kind: "unclear" }
  const { row, folder } = candidates[0]
  return {
    kind: "found",
    result: {
      conversationId: row.id,
      folderId: ticket.chat ? row.folder_id : null,
      folder,
      adopted: true,
    },
  }
}

async function adoptFromTicket(
  ticket: DraftCreateTicket,
  rows: readonly DbConversationSummary[],
  deps: Pick<DraftCreateDeps, "getFolder">
): Promise<DraftCreateResult | null> {
  const match = await matchTicket(ticket, rows, deps)
  return match.kind === "found" ? match.result : null
}

function ticketListParams(ticket: DraftCreateTicket) {
  return {
    agent_type: ticket.agent,
    folder_ids:
      ticket.chat || ticket.folderId == null ? null : [ticket.folderId],
  }
}

export interface RecoveredDraftConversation extends DraftCreateResult {
  /** 那次建会话用的智能体和标题（绑标签用）。 */
  agent: AgentType
  title: string
}

/**
 * 刷新回来没找到那次建出来的行时，隔多久再找（第 7 次返工）：刷新时建会话的
 * 请求可能还在路上，后端晚一点才建出来。都找过了还没有，就当场建。
 */
export const DRAFT_RECOVER_RETRY_DELAYS_MS = [400, 1200] as const

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface RecoverDraftOptions {
  /** 这个草稿标签还有排队的消息（刷新前按回车发的那条）。没有就不建。 */
  hasQueued: () => boolean
  now?: number
  retryDelaysMs?: readonly number[]
  wait?: (ms: number) => Promise<void>
}

/**
 * 刷新回来的草稿标签：刷新前按了回车（有票据），就要让标签落到那条会话上
 * （#650 第 5、7 次返工，人定的：回车后建好的那条会话就是这条消息的归宿，
 * 新会话页不带着上一条没发出去的消息）。
 * - 刷新前那次建会话的请求已经在后端建出了行、浏览器没收到会话号的，把那一行
 *   找回来（条件和 `createOrAdoptDraftConversation` 找回时一样）；没找到隔一会儿
 *   再找（请求可能还在路上）。
 * - 请求还没发出去（票据是回车时先记的「要建」），或者都找过了还是没有：
 *   消息还在排队区的话，当场建一条（经 `createOrAdoptDraftConversation`，建之前
 *   它会再找一次）。
 * - 找到不止一条、分不清的，不认也不建，返回 null，草稿照旧。
 * 没有票据返回 null。查列表失败直接抛出，调用方只记日志。
 */
export async function recoverDraftConversation(
  tabId: string,
  deps: DraftCreateDeps,
  opts: RecoverDraftOptions
): Promise<RecoveredDraftConversation | null> {
  const wait = opts.wait ?? defaultWait
  const delays = opts.retryDelaysMs ?? DRAFT_RECOVER_RETRY_DELAYS_MS
  const ticket = readDraftCreateTicket(tabId, opts.now)
  if (!ticket) return null
  const named = { agent: ticket.agent, title: ticket.title }
  if (ticket.knownIds != null) {
    for (let attempt = 0; ; attempt += 1) {
      const rows = await deps.listAllConversations(ticketListParams(ticket))
      const match = await matchTicket(ticket, rows, deps)
      if (match.kind === "unclear") return null
      if (match.kind === "found") {
        await markNotRunning(deps, match.result.conversationId)
        return { ...match.result, ...named }
      }
      if (attempt >= delays.length) break
      await wait(delays[attempt])
    }
  }
  if (!opts.hasQueued()) return null
  const res = await createOrAdoptDraftConversation(
    {
      tabId,
      chat: ticket.chat,
      agent: ticket.agent,
      title: ticket.title,
      folderId: ticket.folderId ?? 0,
      chatDir: ticket.chatDir,
    },
    deps,
    opts.now
  )
  return { ...res, ...named }
}

/**
 * 回车时就记下「这个草稿标签要建会话了」（第 7 次返工）：建会话的请求发出去
 * 之前刷新，刷新回来也知道要建。这个标签已经有发出去过的票据的不动它（那是
 * 更早一次、可能已经建出行的建会话，找回时要用它）。
 */
export function noteDraftCreateIntent(
  spec: DraftCreateSpec,
  now: number = Date.now()
): void {
  // 已有的也只是「要建」的，那次什么都没发出去，换成这次的
  if (readDraftCreateTicket(spec.tabId, now)?.knownIds != null) return
  writeDraftCreateTicket(spec.tabId, {
    startedAt: now,
    agent: spec.agent,
    title: spec.title,
    chat: spec.chat,
    folderId: spec.chat ? null : spec.folderId,
    chatDir: spec.chat ? (spec.chatDir ?? null) : null,
    knownIds: null,
  })
}

/**
 * 给这个草稿标签建会话；刷新前那次请求已经建好了的，找回来用它，不再建一个。
 * 查会话列表失败（有没有票据都一样），直接报错，不去建（建了就可能重复，或者
 * 刷新后认不回来），交给调用方按失败处理。
 * 排除发请求前就在的行以后还剩不止一条的，分不清，不认，照常建。
 * 建好以后票据还在：调用方绑好标签后调 `clearDraftCreateTicket`。
 * 建好或找回的行都先标成不在运行（见 `markNotRunning`），再交给调用方。
 */
export async function createOrAdoptDraftConversation(
  spec: DraftCreateSpec,
  deps: DraftCreateDeps,
  now: number = Date.now()
): Promise<DraftCreateResult> {
  // 第 7 次返工：先记下「要建」，查列表、建会话的请求发出去之前刷新也不丢
  noteDraftCreateIntent(spec, now)
  const ticket = readDraftCreateTicket(spec.tabId, now)
  const sameCreate =
    ticket != null &&
    ticket.chat === spec.chat &&
    ticket.agent === spec.agent &&
    ticket.title === spec.title &&
    (spec.chat || ticket.folderId === spec.folderId)
  const listParams = {
    agent_type: spec.agent,
    folder_ids: spec.chat ? null : [spec.folderId],
  }
  let rows: DbConversationSummary[] | null = null
  // 票据只是「要建」（请求还没发出去过）的，没有可找的行
  if (ticket && sameCreate && ticket.knownIds != null) {
    rows = await deps.listAllConversations(listParams)
    const adopted = await adoptFromTicket(ticket, rows, deps)
    if (adopted) {
      await markNotRunning(deps, adopted.conversationId)
      return adopted
    }
  }
  const chatDir = spec.chat ? (spec.chatDir ?? null) : null
  const match: DraftCreateMatch = {
    agent: spec.agent,
    title: spec.title,
    chat: spec.chat,
    folderId: spec.chat ? null : spec.folderId,
  }
  // 第 8 次返工：查列表失败直接抛出、不建：不知道发请求前有哪些行，建了以后
  // 刷新就认不回来，消息会挂在新会话页上。调用方按建会话失败处理；「要建」的
  // 票据留着，刷新回来或下次重试照样建。
  rows ??= await deps.listAllConversations(listParams)
  writeDraftCreateTicket(spec.tabId, {
    startedAt: now,
    ...match,
    chatDir,
    knownIds: rows.filter((r) => sameDraftShape(match, r)).map((r) => r.id),
  })
  if (spec.chat) {
    const res = await deps.createChatConversation(
      spec.agent,
      spec.title,
      chatDir ?? undefined
    )
    await markNotRunning(deps, res.conversationId)
    return {
      conversationId: res.conversationId,
      folderId: res.folderId,
      folder: res.folder,
      adopted: false,
    }
  }
  const id = await deps.createConversation(
    spec.folderId,
    spec.agent,
    spec.title
  )
  await markNotRunning(deps, id)
  return { conversationId: id, folderId: null, folder: null, adopted: false }
}

/**
 * 草稿标签绑上会话时，连接上现在这个智能体会话还能不能留给这条会话续用
 * （第 11 次返工，收件箱 #716 的 P1）。
 * 聊天模式的草稿刷新后会新建一个临时目录、在里面连上一个新会话；刷新前按回车
 * 建好（或刷新回来补建）的那条会话却在刷新前的临时目录里。绑上以后连接换到
 * 那个目录重连，这时还拿新目录里的会话号去续，智能体续不上：重试发出去以后
 * 一直「进行中」、没有回复，最后进程退出。所以会话所在目录和连接的目录不一样
 * 时不留，重连开一个新会话。普通会话没有自己的目录（`boundDir` 是 null），
 * 绑上不换目录，照旧留着。
 */
export function sessionIdForBoundDraft(opts: {
  boundDir: string | null | undefined
  connectionDir: string | null | undefined
  liveSessionId: string | null | undefined
}): string | null {
  if (!opts.liveSessionId) return null
  if (opts.boundDir == null) return opts.liveSessionId
  return opts.boundDir === opts.connectionDir ? opts.liveSessionId : null
}
