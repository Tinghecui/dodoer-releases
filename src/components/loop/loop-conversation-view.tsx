"use client"

/**
 * jenny fork: a folder's Loop conversation. One conversation holds every Loop
 * the folder has run, oldest first, as a normal conversation reads: Loop, then
 * its stages, then the agent sessions of each stage. A stage opens on demand:
 * a Loop can reach hundreds of stages and a stage hundreds of megabytes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Loader2,
  Network,
  Repeat2,
  Search,
  Send,
  XCircle,
} from "lucide-react"

import { AgentIcon } from "@/components/agent-icon"
import { Button } from "@/components/ui/button"
import { LoopSessionTranscript } from "@/components/loop/loop-session-transcript"
import { steerLoop } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  formatStageMinutes,
  liveLoop,
  liveStage,
  phaseEdge,
  phaseTone,
  RUN_STATE_DOT,
  sessionIsLive,
  splitSessions,
  stageResultKind,
} from "@/lib/jenny-loop"
import type {
  JennyLoopEntry,
  JennyLoopSession,
  JennyLoopStage,
} from "@/lib/types"
import { cn } from "@/lib/utils"
import { useLoopConversationStore } from "@/stores/loop-conversation-store"

/** Jenny's state moves with each stage and each test; a stage's own transcript
 *  refreshes on its own, faster. */
const POLL_MS = 8000
/** Within this distance of the end, new content keeps the view at the end. */
const STICK_TO_END_PX = 120

function stageKey(loopId: string, stageId: string) {
  return `${loopId}/${stageId}`
}

function StageResult({ stage }: { stage: JennyLoopStage }) {
  const t = useTranslations("JennyLoop")
  const kind = stageResultKind(stage)
  switch (kind) {
    case "passed":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[var(--st-ok)]">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {t("resultPassed")}
        </span>
      )
    case "failed":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[var(--st-fail)]">
          <XCircle className="size-3.5" aria-hidden />
          {t("resultFailed")}
        </span>
      )
    case "running":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-[var(--st-run-ink)]">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("resultRunning")}
        </span>
      )
    case "unfinished":
      return (
        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
          <CircleDashed className="size-3.5" aria-hidden />
          {t("resultUnfinished")}
        </span>
      )
    default:
      return (
        <span className="shrink-0 text-muted-foreground">{stage.result}</span>
      )
  }
}

function SessionBlock({
  loop,
  stage,
  session,
  isActive,
  defaultOpen,
}: {
  loop: JennyLoopEntry
  stage: JennyLoopStage
  session: JennyLoopSession
  isActive: boolean
  defaultOpen: boolean
}) {
  const t = useTranslations("JennyLoop")
  const [open, setOpen] = useState(defaultOpen)
  const Icon =
    session.role === "node"
      ? Network
      : session.role === "reflection"
        ? Search
        : Bot
  const roleLabel = {
    stage: t("roleStage"),
    node: t("roleNode"),
    reflection: t("roleReflection"),
    subagent: t("roleSubagent"),
    launcher: t("roleLauncher"),
  }[session.role]
  return (
    <div data-loop-session-block={session.role}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left text-xs text-muted-foreground hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90"
          )}
          aria-hidden
        />
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0 font-medium">{roleLabel}</span>
        <AgentIcon agentType={session.agentType} className="size-3 shrink-0" />
        {session.label ? (
          <span className="min-w-0 truncate">{session.label}</span>
        ) : null}
      </button>
      {open ? (
        <div className="mt-2 pl-1">
          <LoopSessionTranscript
            agentType={session.agentType}
            sessionId={session.sessionId}
            live={sessionIsLive(loop, stage)}
            isActive={isActive}
          />
        </div>
      ) : null}
    </div>
  )
}

function StageSection({
  loop,
  stage,
  open,
  onToggle,
  isActive,
}: {
  loop: JennyLoopEntry
  stage: JennyLoopStage
  open: boolean
  onToggle: () => void
  isActive: boolean
}) {
  const t = useTranslations("JennyLoop")
  const { main, helpers } = splitSessions(stage)
  const [helpersOpen, setHelpersOpen] = useState(false)
  const duration = formatStageMinutes(stage.durationMinutes)
  const phaseName = (
    ["prepare", "impl", "deploy", "test", "reflect", "launcher"] as const
  ).find((p) => p === stage.phase)
  return (
    <section
      id={`loop-stage-${loop.id}-${stage.id}`}
      className={cn("border-l-2 pl-3", phaseEdge(stage.phase))}
      data-loop-stage={stage.id}
      data-loop-stage-phase={stage.phase}
    >
      {/* Sticky, so a long transcript always says which stage it belongs to. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "sticky top-[var(--glass-top-inset,0px)] z-10 flex w-full min-w-0 items-center gap-2 bg-background/95 py-1.5 text-left text-xs backdrop-blur",
          open && "border-b border-border/50"
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          aria-hidden
        />
        <span
          className={cn(
            "shrink-0 rounded-md px-1.5 py-0.5 font-semibold",
            phaseTone(stage.phase)
          )}
        >
          {phaseName ? t(`phase.${phaseName}`) : stage.phase}
          {stage.number !== null ? ` ${stage.number}` : ""}
        </span>
        {stage.cycle !== null ? (
          <span className="shrink-0 text-muted-foreground">
            {t("cycleN", { n: stage.cycle })}
          </span>
        ) : null}
        <StageResult stage={stage} />
        {stage.summary && !open ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {stage.summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {duration ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {duration}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="flex flex-col gap-3 py-3">
          {stage.summary ? (
            <p
              className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-relaxed"
              data-loop-stage-summary=""
            >
              {stage.summary}
            </p>
          ) : null}
          {main.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              {t("noSessions")}
            </p>
          ) : null}
          {main.map((session) => (
            <SessionBlock
              key={session.sessionId}
              loop={loop}
              stage={stage}
              session={session}
              isActive={isActive}
              // The stage's own agent is the stage; nodes open on demand when
              // there are several, and a retry only shows its newest attempt.
              defaultOpen={session === main[main.length - 1]}
            />
          ))}
          {helpers.length > 0 ? (
            <div>
              <button
                type="button"
                onClick={() => setHelpersOpen((v) => !v)}
                aria-expanded={helpersOpen}
                className="flex items-center gap-1.5 rounded-md px-1 py-1 text-xs text-muted-foreground hover:bg-muted/50"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 transition-transform",
                    helpersOpen && "rotate-90"
                  )}
                  aria-hidden
                />
                {t("helpers", { count: helpers.length })}
              </button>
              {helpersOpen ? (
                <div className="mt-1 flex flex-col gap-1 pl-3">
                  {helpers.map((session) => (
                    <SessionBlock
                      key={session.sessionId}
                      loop={loop}
                      stage={stage}
                      session={session}
                      isActive={isActive}
                      defaultOpen={false}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {stage.evidence.length > 0 ? (
            <details className="px-1 text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {t("evidence", { count: stage.evidence.length })}
              </summary>
              <ul className="mt-1 space-y-0.5 break-all font-mono text-[0.6875rem]">
                {stage.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function LoopSection({
  loop,
  open,
  onToggle,
  openStages,
  onToggleStage,
  isActive,
}: {
  loop: JennyLoopEntry
  open: boolean
  onToggle: () => void
  openStages: ReadonlySet<string>
  onToggleStage: (key: string) => void
  isActive: boolean
}) {
  const t = useTranslations("JennyLoop")
  const runLabel = {
    running: t("runRunning"),
    paused: t("runPaused"),
    stopped: t("runStopped"),
    blocked: t("runBlocked"),
    completed: t("runCompleted"),
  }[loop.runState]
  return (
    <div data-loop={loop.id} data-loop-run-state={loop.runState}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5 text-left hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
          aria-hidden
        />
        <Repeat2 className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="shrink-0 text-sm font-semibold">{loop.id}</span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {loop.title === loop.id ? "" : loop.title}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn("size-2 rounded-full", RUN_STATE_DOT[loop.runState])}
          />
          {runLabel}
          <span aria-hidden>·</span>
          {t("stageCount", { count: loop.stages.length })}
        </span>
      </button>
      {open ? (
        <div className="mt-3 flex flex-col gap-2">
          {loop.stages.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              {t("noStages")}
            </p>
          ) : null}
          {loop.stages.map((stage) => {
            const key = stageKey(loop.id, stage.id)
            return (
              <StageSection
                key={key}
                loop={loop}
                stage={stage}
                open={openStages.has(key)}
                onToggle={() => onToggleStage(key)}
                isActive={isActive}
              />
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** What the person says to the stage at work. The message goes through Jenny's
 *  own channel; Jenny answers when the stage has none. */
function LoopComposer({
  folderId,
  loop,
}: {
  folderId: number
  loop: JennyLoopEntry
}) {
  const t = useTranslations("JennyLoop")
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const running = loop.runState === "running"
  const send = useCallback(async () => {
    const message = text.trim()
    if (!message || sending) return
    setSending(true)
    setNotice(null)
    try {
      const answer = await steerLoop(folderId, loop.id, message)
      if (answer.steered) {
        setText("")
        setNotice(t("steerSent"))
      } else {
        setNotice(answer.reason ?? t("steerRefused"))
      }
    } catch (e) {
      setNotice(toErrorMessage(e))
    } finally {
      setSending(false)
    }
  }, [folderId, loop.id, sending, t, text])
  return (
    <div className="mx-auto w-full chat-content-w px-1 pb-[0.875rem]">
      {notice ? (
        <p
          className="mb-1.5 px-3 text-xs text-muted-foreground"
          role="status"
          data-loop-steer-notice=""
        >
          {notice}
        </p>
      ) : null}
      <div className="flex items-end gap-2 rounded-[18px] border border-border bg-background px-3 py-2 shadow-sm">
        <textarea
          value={text}
          rows={1}
          disabled={!running}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={
            running
              ? t("composerPlaceholder", { id: loop.id })
              : t("composerNotRunning")
          }
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          data-loop-composer=""
        />
        <Button
          size="icon"
          className="size-7 shrink-0 rounded-full"
          disabled={!running || sending || !text.trim()}
          aria-label={t("composerSend")}
          onClick={() => void send()}
        >
          {sending ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Send className="size-3.5" aria-hidden />
          )}
        </Button>
      </div>
    </div>
  )
}

export function LoopConversationView({
  folderId,
  isActive,
}: {
  folderId: number
  isActive: boolean
}) {
  const t = useTranslations("JennyLoop")
  const entry = useLoopConversationStore((s) => s.byFolder[folderId])
  const load = useLoopConversationStore((s) => s.load)
  const focus = useLoopConversationStore((s) => s.focus)
  const detail = entry?.detail ?? null
  const live = useMemo(() => liveLoop(detail), [detail])
  const stageNow = useMemo(() => liveStage(live), [live])

  // What the person opened or closed. Everything else follows the live stage,
  // so a Loop moving on opens its new stage by itself.
  const [loopChoice, setLoopChoice] = useState<Record<string, boolean>>({})
  const [stageChoice, setStageChoice] = useState<Record<string, boolean>>({})
  const openStages = useMemo(() => {
    const keys = new Set(
      Object.entries(stageChoice)
        .filter(([, open]) => open)
        .map(([key]) => key)
    )
    if (live && stageNow) {
      const key = stageKey(live.id, stageNow.id)
      if (stageChoice[key] !== false) keys.add(key)
    }
    return keys
  }, [stageChoice, live, stageNow])
  const toggleStage = useCallback(
    (key: string) =>
      setStageChoice((prev) => ({ ...prev, [key]: !openStages.has(key) })),
    [openStages]
  )

  useEffect(() => {
    if (!isActive) return
    void load(folderId)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(folderId)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [folderId, isActive, load])

  const scroller = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const end = el.scrollHeight - el.scrollTop - el.clientHeight
    atEnd.current = end < STICK_TO_END_PX
    setShowJump(!atEnd.current)
  }, [])
  const toEnd = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])
  const hasContent = (detail?.loops.length ?? 0) > 0
  // Reads like a conversation: it opens at the newest and stays there while the
  // transcript grows, unless the person scrolled away.
  useEffect(() => {
    const el = scroller.current
    const body = el?.firstElementChild
    if (!el || !body || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      if (atEnd.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(body)
    return () => observer.disconnect()
  }, [hasContent])

  // A jump from the panel: open that Loop and stage, then bring it on screen.
  const handledFocus = useRef(0)
  useEffect(() => {
    if (!focus || focus.folderId !== folderId) return
    if (handledFocus.current === focus.nonce) return
    handledFocus.current = focus.nonce
    atEnd.current = false
    // Applying a jump the panel asked for, once per nonce.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoopChoice((prev) => ({ ...prev, [focus.loopId]: true }))
    setStageChoice((prev) => ({
      ...prev,
      [stageKey(focus.loopId, focus.stageId)]: true,
    }))
    window.requestAnimationFrame(() => {
      document
        .getElementById(`loop-stage-${focus.loopId}-${focus.stageId}`)
        ?.scrollIntoView({ block: "start" })
    })
  }, [focus, folderId])

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      data-loop-conversation={folderId}
    >
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto pt-[var(--glass-top-inset,0px)]"
      >
        <div className="mx-auto flex w-full chat-content-w flex-col gap-4 px-4 py-4">
          {!detail ? (
            entry?.error ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {entry.error}
              </p>
            ) : (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {t("loading")}
              </div>
            )
          ) : detail.loops.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("empty")}
            </p>
          ) : (
            detail.loops.map((loop) => (
              <LoopSection
                key={loop.id}
                loop={loop}
                open={loopChoice[loop.id] ?? loop.id === live?.id}
                onToggle={() =>
                  setLoopChoice((prev) => ({
                    ...prev,
                    [loop.id]: !(prev[loop.id] ?? loop.id === live?.id),
                  }))
                }
                openStages={openStages}
                onToggleStage={toggleStage}
                isActive={isActive}
              />
            ))
          )}
        </div>
      </div>
      {showJump ? (
        <Button
          size="icon"
          variant="outline"
          className="absolute bottom-20 left-1/2 z-20 size-8 -translate-x-1/2 rounded-full"
          aria-label={t("jumpToEnd")}
          onClick={toEnd}
        >
          <ArrowDown className="size-4" aria-hidden />
        </Button>
      ) : null}
      {live ? <LoopComposer folderId={folderId} loop={live} /> : null}
    </div>
  )
}
