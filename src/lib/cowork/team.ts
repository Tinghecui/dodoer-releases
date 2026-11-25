// CoTeam 的会话分享（#1230）：工作界面和 CoTeam 服务端之间唯一的命令
// `cowork_team` 的封装、类型、可用性探测和 `summary` 轮询。
//
// 命令走现成的 `getTransport().call`：浏览器里是同源的 POST /api/cowork_team，
// 由 CoTeam 的 nginx 接走；桌面版远程窗口由 Rust 原样代发。codeg-server 自己
// 没有这条路由（回 501），本机桌面没有这条 Tauri 命令（调用失败），这两种都
// 当作「团队功能不可用」，入口不画。
//
// 谁能看哪个会话只由服务端判断，这里不做任何可见性判断。返回值宽容地读：
// 缺字段当空、多字段忽略（服务端和前端谁先发版都不能坏）。
//
// 轮询：启动后探一次 `status`；不可用（调用失败、signedOut、applicable 或
// enabled 为假）就每 10 分钟再探一次。可用时每 60 秒调一次 `summary`，页面
// 不可见时不调。收到 signedOut 立刻停掉 `summary`，等下一次探测（登录过期
// 后继续轮询会被服务器的防猜密码规则当成攻击）。

import { useEffect } from "react"
import { getTransport } from "@/lib/transport"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"

export const COWORK_TEAM_COMMAND = "cowork_team"
/** 不可用时多久再探一次 `status`。 */
export const TEAM_PROBE_MS = 10 * 60_000
/** 可用时多久调一次 `summary`。 */
export const TEAM_SUMMARY_MS = 60_000

// ─── 类型 ─────────────────────────────────────────────────────────────────

/** 服务端算好的会话状态：进行中、等人回答、已结束。 */
export type TeamSessionState = "running" | "waiting" | "done"

export interface TeamUser {
  name: string
  label: string
}

export interface TeamGroupRef {
  id: string
  name: string
}

export interface CoworkTeamStatus {
  applicable: boolean
  enabled: boolean
  me: TeamUser
  leaderOf: TeamGroupRef[]
  portalUrl: string | null
}

export interface TeamCommentUnreadSession {
  owner: string
  ownerLabel: string
  id: string
  title: string
  mine: boolean
  count: number
}

export interface TeamGroupNotice {
  id: string
  groupName: string
  leaders: string[]
}

export interface CoworkTeamSummary {
  sharedNew: number
  commentUnread: { total: number; sessions: TeamCommentUnreadSession[] }
  groupNotices: TeamGroupNotice[]
}

export interface TeamTargets {
  users: TeamUser[]
  groups: TeamGroupRef[]
}

export type TeamShareTarget =
  | { type: "user"; name: string }
  | { type: "group"; id: string }

export type TeamShare =
  | {
      type: "user"
      name: string
      label: string
      note: string
      createdAt: string
    }
  | { type: "group"; id: string; name: string; note: string; createdAt: string }

export interface TeamShares {
  id: string
  shares: TeamShare[]
}

export interface TeamSummaryText {
  text: string
}

export interface TeamSharedVia {
  type: string
  id?: string
  name?: string
}

export interface TeamSharedItem {
  owner: string
  ownerLabel: string
  id: string
  title: string
  state: TeamSessionState
  updatedAt: string
  note: string
  sharedAt: string
  isNew: boolean
  summary: TeamSummaryText | null
  via: TeamSharedVia[]
}

export interface TeamSeen {
  owner: string
  id: string
  seenAt: string
}

export type TeamEntryKind = "user" | "assistant" | "thought" | "tool"

export interface TeamEntry {
  seq: number
  kind: TeamEntryKind
  text: string
  ts: string
}

export interface TeamAgentInfo {
  owner: string
  ownerLabel: string
  id: string
  title: string
  state: TeamSessionState
  updatedAt: string
}

export interface TeamEntriesPage {
  agent: TeamAgentInfo
  entries: TeamEntry[]
  total: number
  reason: string | null
}

export interface TeamComment {
  id: string
  seq: number | null
  parentId: string | null
  author: string
  authorLabel: string
  former: boolean
  body: string
  createdAt: string
  mine: boolean
  canDelete: boolean
  anchor: string | null
  /** 主人已经把这条交给过智能体的时间；没交过、或者服务器还不带这个字段是 null。 */
  forwardedAt: string | null
}

export interface TeamCommentsPage {
  isOwner: boolean
  ids: string[]
  comments: TeamComment[]
}

export interface TeamCommentDeleted {
  id: string
  replies: number
}

export interface TeamCommentsSeen {
  owner: string
  id: string
  seenId: string | null
}

export interface TeamMemberSession {
  owner: string
  id: string
  title: string
  state: TeamSessionState
  updatedAt: string
  summary: TeamSummaryText | null
}

export interface TeamMember {
  name: string
  label: string
  running: number
  waiting: number
  sessions: TeamMemberSession[]
}

export interface TeamView {
  id: string
  name: string
  since: string
  members: TeamMember[]
}

export interface TeamSearchHit {
  owner: string
  ownerLabel: string
  id: string
  title: string
  seq: number | null
  snippet: string
}

// ─── 宽容地读 ───────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>

function obj(raw: unknown): Raw {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Raw)
    : {}
}

function arr(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}

function str(raw: unknown): string {
  if (typeof raw === "string") return raw
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
  return ""
}

function strOrNull(raw: unknown): string | null {
  const s = str(raw)
  return s ? s : null
}

function num(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0
}

function numOrNull(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null
}

function count(raw: unknown): number {
  return Math.max(0, Math.floor(num(raw)))
}

/** 只认三种状态；不认识的当「已结束」（不自己从别的字段推）。 */
function sessionState(raw: unknown): TeamSessionState {
  return raw === "running" || raw === "waiting" ? raw : "done"
}

function user(raw: unknown): TeamUser | null {
  const r = obj(raw)
  const name = str(r.name)
  if (!name) return null
  return { name, label: str(r.label) || name }
}

function group(raw: unknown): TeamGroupRef | null {
  const r = obj(raw)
  const id = str(r.id)
  if (!id) return null
  return { id, name: str(r.name) || id }
}

function summaryText(raw: unknown): TeamSummaryText | null {
  const text = str(obj(raw).text)
  return text ? { text } : null
}

function compact<T>(items: (T | null)[]): T[] {
  return items.filter((item): item is T => item !== null)
}

/** `signedOut` 是独立的一种结果：登录过期，要停掉轮询。 */
export function isSignedOut(raw: unknown): boolean {
  return obj(raw).signedOut === true
}

export function normalizeTeamStatus(raw: unknown): CoworkTeamStatus {
  const r = obj(raw)
  return {
    applicable: r.applicable === true,
    enabled: r.enabled === true,
    me: user(r.me) ?? { name: "", label: "" },
    leaderOf: compact(arr(r.leaderOf).map(group)),
    portalUrl: strOrNull(r.portalUrl),
  }
}

/** 团队功能可用：applicable、enabled 都为真，并且知道「我」是谁。 */
export function isTeamStatusUsable(raw: unknown): boolean {
  if (isSignedOut(raw)) return false
  const status = normalizeTeamStatus(raw)
  return status.applicable && status.enabled && status.me.name !== ""
}

export function normalizeTeamSummary(raw: unknown): CoworkTeamSummary {
  const r = obj(raw)
  const unread = obj(r.commentUnread)
  const sessions = compact(
    arr(unread.sessions).map((item): TeamCommentUnreadSession | null => {
      const s = obj(item)
      const id = str(s.id)
      if (!id) return null
      const owner = str(s.owner)
      return {
        owner,
        ownerLabel: str(s.ownerLabel) || owner,
        id,
        title: str(s.title),
        mine: s.mine === true,
        count: count(s.count),
      }
    })
  )
  return {
    sharedNew: count(r.sharedNew),
    commentUnread: { total: count(unread.total), sessions },
    groupNotices: compact(
      arr(r.groupNotices).map((item): TeamGroupNotice | null => {
        const n = obj(item)
        const id = str(n.id)
        if (!id) return null
        return {
          id,
          groupName: str(n.groupName),
          leaders: arr(n.leaders).map(str).filter(Boolean),
        }
      })
    ),
  }
}

export function normalizeTeamTargets(raw: unknown): TeamTargets {
  const r = obj(raw)
  return {
    users: compact(arr(r.users).map(user)),
    groups: compact(arr(r.groups).map(group)),
  }
}

export function normalizeTeamShares(raw: unknown): TeamShares {
  const r = obj(raw)
  return {
    id: str(r.id),
    shares: compact(
      arr(r.shares).map((item): TeamShare | null => {
        const s = obj(item)
        const note = str(s.note)
        const createdAt = str(s.createdAt)
        if (s.type === "user") {
          const name = str(s.name)
          if (!name) return null
          return {
            type: "user",
            name,
            label: str(s.label) || name,
            note,
            createdAt,
          }
        }
        if (s.type === "group") {
          const id = str(s.id)
          if (!id) return null
          return { type: "group", id, name: str(s.name) || id, note, createdAt }
        }
        return null
      })
    ),
  }
}

function sharedVia(raw: unknown): TeamSharedVia | null {
  const v = obj(raw)
  const type = str(v.type)
  if (!type) return null
  const via: TeamSharedVia = { type }
  const id = str(v.id)
  const name = str(v.name)
  if (id) via.id = id
  if (name) via.name = name
  return via
}

export function normalizeTeamShared(raw: unknown): TeamSharedItem[] {
  return compact(
    arr(raw).map((item): TeamSharedItem | null => {
      const s = obj(item)
      const owner = str(s.owner)
      const id = str(s.id)
      if (!owner || !id) return null
      return {
        owner,
        ownerLabel: str(s.ownerLabel) || owner,
        id,
        title: str(s.title),
        state: sessionState(s.state),
        updatedAt: str(s.updatedAt),
        note: str(s.note),
        sharedAt: str(s.sharedAt),
        isNew: s.isNew === true,
        summary: summaryText(s.summary),
        via: compact(arr(s.via).map(sharedVia)),
      }
    })
  )
}

export function normalizeTeamSeen(raw: unknown): TeamSeen {
  const r = obj(raw)
  return { owner: str(r.owner), id: str(r.id), seenAt: str(r.seenAt) }
}

function entryKind(raw: unknown): TeamEntryKind | null {
  return raw === "user" ||
    raw === "assistant" ||
    raw === "thought" ||
    raw === "tool"
    ? raw
    : null
}

export function normalizeTeamEntries(raw: unknown): TeamEntriesPage {
  const r = obj(raw)
  const a = obj(r.agent)
  const owner = str(a.owner)
  return {
    agent: {
      owner,
      ownerLabel: str(a.ownerLabel) || owner,
      id: str(a.id),
      title: str(a.title),
      state: sessionState(a.state),
      updatedAt: str(a.updatedAt),
    },
    entries: compact(
      arr(r.entries).map((item): TeamEntry | null => {
        const e = obj(item)
        const seq = numOrNull(e.seq)
        const kind = entryKind(e.kind)
        if (seq === null || kind === null) return null
        return { seq, kind, text: str(e.text), ts: str(e.ts) }
      })
    ),
    total: count(r.total),
    reason: strOrNull(r.reason),
  }
}

export function normalizeTeamComment(raw: unknown): TeamComment | null {
  const c = obj(raw)
  const id = str(c.id)
  if (!id) return null
  const author = str(c.author)
  return {
    id,
    seq: numOrNull(c.seq),
    parentId: strOrNull(c.parentId),
    author,
    authorLabel: str(c.authorLabel) || author,
    former: c.former === true,
    body: str(c.body),
    createdAt: str(c.createdAt),
    mine: c.mine === true,
    canDelete: c.canDelete === true,
    anchor: strOrNull(c.anchor),
    forwardedAt: strOrNull(c.forwardedAt),
  }
}

export function normalizeTeamComments(raw: unknown): TeamCommentsPage {
  const r = obj(raw)
  return {
    isOwner: r.isOwner === true,
    ids: arr(r.ids).map(str).filter(Boolean),
    comments: compact(arr(r.comments).map(normalizeTeamComment)),
  }
}

export function normalizeTeamView(raw: unknown): TeamView {
  const r = obj(raw)
  return {
    id: str(r.id),
    name: str(r.name),
    since: str(r.since),
    members: compact(
      arr(r.members).map((item): TeamMember | null => {
        const m = user(item)
        if (!m) return null
        const raw = obj(item)
        return {
          ...m,
          running: count(raw.running),
          waiting: count(raw.waiting),
          sessions: compact(
            arr(raw.sessions).map((s): TeamMemberSession | null => {
              const x = obj(s)
              const id = str(x.id)
              if (!id) return null
              return {
                owner: str(x.owner) || m.name,
                id,
                title: str(x.title),
                state: sessionState(x.state),
                updatedAt: str(x.updatedAt),
                summary: summaryText(x.summary),
              }
            })
          ),
        }
      })
    ),
  }
}

export function normalizeTeamSearch(raw: unknown): TeamSearchHit[] {
  return compact(
    arr(raw).map((item): TeamSearchHit | null => {
      const h = obj(item)
      const owner = str(h.owner)
      const id = str(h.id)
      if (!owner || !id) return null
      return {
        owner,
        ownerLabel: str(h.ownerLabel) || owner,
        id,
        title: str(h.title),
        seq: numOrNull(h.seq),
        snippet: str(h.snippet),
      }
    })
  )
}

// ─── 错误 ───────────────────────────────────────────────────────────────────

/**
 * `cowork_team` 失败。`code` 是服务端的错误码（`not_found`、`forbidden`、
 * `sharing_disabled`、`invalid`、`rate_limited`；codeg-server 没有这条命令时
 * 是 `not_implemented`），`message` 是能直接给人看的原文。
 */
export class CoworkTeamError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "CoworkTeamError"
    this.code = code
  }
}

function errorFields(raw: unknown): { code: string; message: string } | null {
  const r = obj(raw)
  const nested = obj(r.error)
  const code = str(nested.code) || str(r.code)
  const message = str(nested.message) || str(r.message)
  if (!code && !message) return null
  return { code, message }
}

/**
 * 各条通道报错的样子不一样，统一成 `CoworkTeamError`：
 * - 浏览器：非 2xx 的响应体原样抛出，CoTeam 是 `{ error: { code, message } }`，
 *   codeg-server 是 `{ code, message }`；
 * - 桌面版远程窗口：Rust 读不懂 CoTeam 的响应体时，把它原文放进 `detail`；
 * - 其余（网络断了、超时、本机没有这条命令）：一个 Error 或一段字符串。
 */
export function toCoworkTeamError(err: unknown): CoworkTeamError {
  if (err instanceof CoworkTeamError) return err
  const r = obj(err)
  const detail = typeof r.detail === "string" ? r.detail : ""
  if (detail) {
    try {
      const fromDetail = errorFields(JSON.parse(detail))
      if (fromDetail?.code)
        return new CoworkTeamError(fromDetail.code, fromDetail.message)
    } catch {
      // detail 不是 JSON：照常往下读。
    }
  }
  const fields = errorFields(err)
  if (fields)
    return new CoworkTeamError(
      fields.code || "unknown",
      fields.message || detail || fields.code
    )
  if (err instanceof Error) return new CoworkTeamError("unknown", err.message)
  return new CoworkTeamError("unknown", typeof err === "string" ? err : "")
}

/** 别的命令收到 `{ signedOut: true }` 时抛的错误码。 */
export const TEAM_SIGNED_OUT_CODE = "signed_out"

/** `status`、`summary` 由探测和轮询自己看 signedOut，原样返回。 */
const RAW_OPS = new Set(["status", "summary"])

/**
 * 调一次 `cowork_team`；失败一律抛 `CoworkTeamError`。
 * 任何命令回 `{ signedOut: true }`，都马上收起入口（轮询器看到后停掉
 * `summary`，10 分钟后才再探）；除 `status`、`summary` 外再抛
 * `signed_out`，免得调用方把它当成正常结果。
 */
export async function callCoworkTeam(
  op: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  let raw: unknown
  try {
    raw = await getTransport().call<unknown>(COWORK_TEAM_COMMAND, {
      ...args,
      op,
    })
  } catch (err) {
    throw toCoworkTeamError(err)
  }
  if (isSignedOut(raw)) {
    useCoworkTeamStore.getState().markUnavailable()
    if (!RAW_OPS.has(op)) throw new CoworkTeamError(TEAM_SIGNED_OUT_CODE, "")
  }
  return raw
}

// ─── 发请求时的编号 ─────────────────────────────────────────────────────────

/**
 * 组、留言、回复的上一条、进组提示的编号：界面里存成文字，按契约发成 JSON
 * 数字（服务端要 `typeof === "number"`）。只认正的十进制整数、在安全整数
 * 以内；别的一律不发请求，抛 `invalid`。会话号 `id` 照旧发文字，不走这里。
 */
export function teamNumericId(raw: string): number {
  const n = /^[1-9][0-9]*$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(n)) throw new CoworkTeamError("invalid", "")
  return n
}

/** 分享对象里组的 `id` 换成数字，个人对象原样。 */
function wireShareTarget(target: TeamShareTarget): Record<string, unknown> {
  return target.type === "group"
    ? { type: "group", id: teamNumericId(target.id) }
    : target
}

// ─── 各个 op ────────────────────────────────────────────────────────────────

/** `status` 的原始结果（可能是 `{ signedOut: true }`）。 */
export function teamStatusRaw(): Promise<unknown> {
  return callCoworkTeam("status")
}

/** `summary` 的原始结果（可能是 `{ signedOut: true }`）。 */
export function teamSummaryRaw(): Promise<unknown> {
  return callCoworkTeam("summary")
}

export async function teamTargets(): Promise<TeamTargets> {
  return normalizeTeamTargets(await callCoworkTeam("targets"))
}

export async function teamShares(id: string): Promise<TeamShares> {
  return normalizeTeamShares(await callCoworkTeam("shares", { id }))
}

export async function teamShare(
  id: string,
  targets: TeamShareTarget[],
  note?: string
): Promise<TeamShares> {
  const args: Record<string, unknown> = {
    id,
    targets: targets.map(wireShareTarget),
  }
  if (note) args.note = note
  return normalizeTeamShares(await callCoworkTeam("share", args))
}

/** 不给 `target` = 全部取消。 */
export async function teamUnshare(
  id: string,
  target?: TeamShareTarget
): Promise<TeamShares> {
  const args: Record<string, unknown> = { id }
  if (target) args.target = wireShareTarget(target)
  return normalizeTeamShares(await callCoworkTeam("unshare", args))
}

export async function teamShared(): Promise<TeamSharedItem[]> {
  return normalizeTeamShared(await callCoworkTeam("shared"))
}

export async function teamSharedSeen(
  owner: string,
  id: string
): Promise<TeamSeen> {
  return normalizeTeamSeen(await callCoworkTeam("shared_seen", { owner, id }))
}

/** 第一次 `after` 给 -1，之后给上次最后一条的 `seq`。 */
export async function teamEntries(
  owner: string,
  id: string,
  after: number
): Promise<TeamEntriesPage> {
  return normalizeTeamEntries(
    await callCoworkTeam("entries", { owner, id, after })
  )
}

/** 第一次 `after` 给 0。 */
export async function teamComments(
  owner: string,
  id: string,
  after: number
): Promise<TeamCommentsPage> {
  return normalizeTeamComments(
    await callCoworkTeam("comments", { owner, id, after })
  )
}

export async function teamCommentAdd(
  owner: string,
  id: string,
  body: string,
  options: { seq?: number; replyTo?: string } = {}
): Promise<TeamComment> {
  const args: Record<string, unknown> = { owner, id, body }
  if (options.seq !== undefined) args.seq = options.seq
  if (options.replyTo !== undefined)
    args.replyTo = teamNumericId(options.replyTo)
  const comment = normalizeTeamComment(
    await callCoworkTeam("comment_add", args)
  )
  if (!comment) throw new CoworkTeamError("invalid", "")
  return comment
}

export async function teamCommentDelete(
  owner: string,
  id: string,
  commentId: string
): Promise<TeamCommentDeleted> {
  const r = obj(
    await callCoworkTeam("comment_delete", {
      owner,
      id,
      commentId: teamNumericId(commentId),
    })
  )
  return { id: str(r.id) || commentId, replies: count(r.replies) }
}

export async function teamCommentsSeen(
  owner: string,
  id: string
): Promise<TeamCommentsSeen> {
  const r = obj(await callCoworkTeam("comments_seen", { owner, id }))
  return { owner: str(r.owner), id: str(r.id), seenId: strOrNull(r.seenId) }
}

export async function teamCommentForwarded(
  id: string,
  commentId: string
): Promise<void> {
  await callCoworkTeam("comment_forwarded", {
    id,
    commentId: teamNumericId(commentId),
  })
}

/** `since` 不给 = 服务器当地今天零点。 */
export async function teamView(
  groupId: string,
  since?: string
): Promise<TeamView> {
  const args: Record<string, unknown> = { group: teamNumericId(groupId) }
  if (since) args.since = since
  return normalizeTeamView(await callCoworkTeam("team", args))
}

export async function teamSearch(
  q: string,
  scope: { group?: string; shared?: boolean } = {}
): Promise<TeamSearchHit[]> {
  const args: Record<string, unknown> = { q }
  if (scope.group !== undefined) args.group = teamNumericId(scope.group)
  if (scope.shared) args.shared = true
  return normalizeTeamSearch(await callCoworkTeam("search", args))
}

export async function teamGroupNoticeDismiss(noticeId: string): Promise<void> {
  await callCoworkTeam("group_notice_dismiss", {
    noticeId: teamNumericId(noticeId),
  })
}

/** 工作界面会话的数字 id 转成契约里的 `id`（十进制字符串）；草稿等没有数字号的给 null。 */
export function teamSessionId(conversationId: unknown): string | null {
  return typeof conversationId === "number" &&
    Number.isSafeInteger(conversationId) &&
    conversationId > 0
    ? String(conversationId)
    : null
}

// ─── 探测和轮询 ─────────────────────────────────────────────────────────────

/** 探一次 `status`，结果写进 store。返回现在可不可用。永不 reject。 */
export async function probeCoworkTeam(): Promise<boolean> {
  const store = useCoworkTeamStore.getState()
  let raw: unknown
  try {
    raw = await teamStatusRaw()
  } catch {
    store.markUnavailable()
    return false
  }
  if (!isTeamStatusUsable(raw)) {
    store.markUnavailable()
    return false
  }
  store.setStatus(normalizeTeamStatus(raw))
  return true
}

/** `summary` 失败时，这几种说明这台服务器现在不提供团队功能。 */
const UNAVAILABLE_CODES = new Set(["sharing_disabled", "not_implemented"])

/**
 * 调一次 `summary`，结果写进 store。返回还能不能接着轮询：
 * signedOut、总开关关了、命令没了 → false（store 收起入口）；
 * 别的失败（网络、限流）保留旧数据，下次照常再试。永不 reject。
 */
export async function refreshCoworkTeamSummary(): Promise<boolean> {
  const store = useCoworkTeamStore.getState()
  if (!store.available) return false
  let raw: unknown
  try {
    raw = await teamSummaryRaw()
  } catch (err) {
    if (UNAVAILABLE_CODES.has(toCoworkTeamError(err).code)) {
      store.markUnavailable()
      return false
    }
    return true
  }
  if (isSignedOut(raw)) {
    store.markUnavailable()
    return false
  }
  // 请求途中别的命令发现登录过期、收起了入口：也停下。
  if (!useCoworkTeamStore.getState().available) return false
  useCoworkTeamStore.getState().setSummary(normalizeTeamSummary(raw))
  return true
}

function pageVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  )
}

let pollers = 0
let stopPoller: (() => void) | null = null

function runPoller(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // 可用时下一次 `summary` 该在什么时候；页面不可见时到点也不调，等回到前台。
  let summaryDueAt = 0
  // 可用期间也每 10 分钟重新探一次 `status`（组长身份、开关、登录可能变了）。
  let probeDueAt = 0
  let busy = false

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const after = (ms: number, fn: () => void) => {
    clear()
    if (!stopped) timer = setTimeout(fn, ms)
  }

  const probe = async () => {
    timer = undefined
    if (stopped) return
    busy = true
    const ok = await probeCoworkTeam()
    busy = false
    if (stopped) return
    if (ok) {
      probeDueAt = Date.now() + TEAM_PROBE_MS
      summaryDueAt = 0
      void summaryTick()
    } else {
      after(TEAM_PROBE_MS, () => void probe())
    }
  }

  const summaryTick = async () => {
    timer = undefined
    if (stopped) return
    // summary 和重新探测谁先到点就先醒：探测按自己的 10 分钟走，不跟着
    // summary 请求的耗时往后推。
    const wait = Math.min(summaryDueAt, probeDueAt) - Date.now()
    if (wait > 0) return after(wait, () => void summaryTick())
    // 不可见：不调，也不排下一次；回到前台时由 onVisible 接上。
    if (!pageVisible()) return
    // 别处收起了入口（别的命令收到 signedOut）：不拉 summary，10 分钟后再探。
    if (!useCoworkTeamStore.getState().available)
      return after(TEAM_PROBE_MS, () => void probe())
    // 到了重新探测的时候：先探 `status`，可用的话 probe 会接着拉 summary。
    if (Date.now() >= probeDueAt) return void probe()
    busy = true
    const keep = await refreshCoworkTeamSummary()
    busy = false
    if (stopped) return
    if (!keep) return after(TEAM_PROBE_MS, () => void probe())
    summaryDueAt = Date.now() + TEAM_SUMMARY_MS
    const next = Math.min(TEAM_SUMMARY_MS, probeDueAt - Date.now())
    after(Math.max(0, next), () => void summaryTick())
  }

  const onVisible = () => {
    if (stopped || busy || !pageVisible()) return
    if (!useCoworkTeamStore.getState().available) return
    if (timer !== undefined && Math.min(summaryDueAt, probeDueAt) > Date.now())
      return
    // 原来排着的定时器（可能已经到点还没跑）先取消，免得补取之后它再拉一次。
    clear()
    void summaryTick()
  }

  // 别的命令收到 signedOut 会收起入口：立刻取消排着的 summary，10 分钟后
  // 才再探。自己的 probe、summary 在途中时由它们回来后自己排下一次。
  const unsubscribe = useCoworkTeamStore.subscribe((state, prev) => {
    if (stopped || busy || state.available || !prev.available) return
    after(TEAM_PROBE_MS, () => void probe())
  })

  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisible)
  void probe()

  return () => {
    stopped = true
    clear()
    unsubscribe()
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisible)
  }
}

/**
 * 开始探测和轮询；几处同时要只跑一份。返回的函数退订，最后一个退订时停下。
 */
export function startCoworkTeamPolling(): () => void {
  pollers += 1
  if (pollers === 1) stopPoller = runPoller()
  let released = false
  return () => {
    if (released) return
    released = true
    pollers -= 1
    if (pollers === 0) {
      stopPoller?.()
      stopPoller = null
    }
  }
}

/** 组件挂着期间探测并轮询团队功能（`enabled` 为假时什么都不发）。 */
export function useCoworkTeamPolling(enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    return startCoworkTeamPolling()
  }, [enabled])
}

/** 测试用：停掉轮询，清空 store。 */
export function resetCoworkTeamForTests(): void {
  stopPoller?.()
  stopPoller = null
  pollers = 0
  useCoworkTeamStore.getState().reset()
}
