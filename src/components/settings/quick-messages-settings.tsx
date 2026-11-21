"use client"

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import { GripVertical, Loader2, Plus, Save, Trash2 } from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  quickMessagesCreate,
  quickMessagesDelete,
  quickMessagesList,
  quickMessagesReorder,
  quickMessagesUpdate,
} from "@/lib/api"
import type { QuickMessage } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { SettingsLoadError } from "./settings-load-error"

const LEFT_MIN_WIDTH = 280
const RIGHT_MIN_WIDTH = 420

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

interface QuickMessageReorderItemProps {
  message: QuickMessage
  selected: boolean
  reordering: boolean
  onSelect: (id: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  children: (
    startDrag: (event: PointerEvent<HTMLButtonElement>) => void
  ) => ReactNode
}

function QuickMessageReorderItem({
  message,
  selected,
  reordering,
  onSelect,
  onDragStart,
  onDragEnd,
  children,
}: QuickMessageReorderItemProps) {
  const dragControls = useDragControls()

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="section"
      value={message}
      data-quick-message-id={message.id}
      drag={reordering ? false : "y"}
      dragListener={false}
      dragControls={dragControls}
      dragMomentum={false}
      layout="position"
      className={cn(
        "rounded-lg border bg-card p-2.5 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        selected && "border-primary/60 bg-primary/5"
      )}
      tabIndex={0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(message.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onSelect(message.id)
      }}
    >
      {children(startDrag)}
    </Reorder.Item>
  )
}

export function QuickMessagesSettings() {
  const t = useTranslations("QuickMessagesSettings")

  const [messages, setMessages] = useState<QuickMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState("")

  const [draftTitle, setDraftTitle] = useState("")
  const [draftContent, setDraftContent] = useState("")
  const [saving, setSaving] = useState(false)
  // 点过保存且标题或内容是空白时，才在字段下面显示必填提示（#979）
  const [showRequired, setShowRequired] = useState(false)
  // 点「新建」只在页面上开一份空白草稿，点保存且通过校验才建记录，
  // 免得没填或填了空格就留下一条空条目（#979）
  const [newDraft, setNewDraft] = useState(false)
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [reordering, setReordering] = useState(false)
  const pendingOrderRef = useRef<number[] | null>(null)

  const panelContainerRef = useRef<HTMLDivElement | null>(null)
  const [panelContainerWidth, setPanelContainerWidth] = useState(0)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const list = await quickMessagesList()
      setMessages(list)
    } catch (err) {
      const message = toErrorMessage(err)
      setLoadError(message)
      setMessages([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh().catch((err) => {
      console.error("[QuickMessagesSettings] initial refresh failed:", err)
    })
  }, [refresh])

  useEffect(() => {
    const container = panelContainerRef.current
    if (!container) return
    const updateWidth = (next: number) => {
      setPanelContainerWidth((prev) =>
        Math.abs(prev - next) < 1 ? prev : next
      )
    }
    updateWidth(container.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      updateWidth(
        entries[0]?.contentRect.width ?? container.getBoundingClientRect().width
      )
    })
    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId]
  )

  // 只在换了正在编辑的对象（换了条目、进出新建草稿）时才重置表单。拖动排序
  // 会给每条生成新对象（sort_order 变了），保存返回会换掉条目的标题、内容，
  // 这两种都不能重置，否则用户还没保存的字会被清掉。标题、内容从 ref 里读
  const selectedMessageId = selectedMessage?.id ?? null
  const selectedMessageRef = useRef<QuickMessage | null>(null)
  useEffect(() => {
    selectedMessageRef.current = selectedMessage
  }, [selectedMessage])
  // 新草稿创建成功、用户在请求返回前又接着打了字时设成 true，
  // 下一次换到新条目时保留表单里的字，不用存进去的值覆盖
  const keepDraftOnSwitchRef = useRef(false)
  // 表单上次按条目重置以后，用户在输入框里改过没有。光比内容不够：
  // 用户可能打了字又删回原样，那也是用户的输入，保存返回时不能覆盖
  const editedSinceResetRef = useRef(false)

  useEffect(() => {
    if (keepDraftOnSwitchRef.current) {
      keepDraftOnSwitchRef.current = false
      // 留下的是用户在等待时打的字，算改过
      editedSinceResetRef.current = true
      return
    }
    editedSinceResetRef.current = false
    const current = selectedMessageRef.current
    if (newDraft) {
      setDraftTitle("")
      setDraftContent("")
    } else if (selectedMessageId !== null && current) {
      setDraftTitle(current.title)
      setDraftContent(current.content)
    } else {
      setDraftTitle("")
      setDraftContent("")
    }
    setShowRequired(false)
  }, [selectedMessageId, newDraft])

  // 保存返回时拿来对比：用户点了保存以后又打过字没有
  const latestDraftRef = useRef({ title: "", content: "" })
  useEffect(() => {
    latestDraftRef.current = { title: draftTitle, content: draftContent }
  }, [draftTitle, draftContent])

  // 保存返回时拿来判断：现在表单上编辑的是不是刚存的那一条
  const editingIdRef = useRef<number | null>(null)
  useEffect(() => {
    editingIdRef.current = newDraft ? null : selectedMessageId
  }, [newDraft, selectedMessageId])

  useEffect(() => {
    if (selectedId === null && messages.length > 0) {
      setSelectedId(messages[0].id)
    }
  }, [selectedId, messages])

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return messages
    return messages.filter(
      (m) =>
        m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
    )
  }, [messages, searchQuery])

  const isDirty = useMemo(() => {
    // 新建的草稿还没存过，保存按钮一直可点，点了才看得到必填提示
    if (newDraft) return true
    if (!selectedMessage) return false
    return (
      draftTitle !== selectedMessage.title ||
      draftContent !== selectedMessage.content
    )
  }, [newDraft, selectedMessage, draftTitle, draftContent])

  const persistReorder = useCallback(
    async (ids: number[]) => {
      if (ids.length === 0) return
      setReordering(true)
      try {
        await quickMessagesReorder(ids)
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("toasts.saveOrderFailed"), { description: message })
        await refresh()
      } finally {
        setReordering(false)
      }
    },
    [refresh, t]
  )

  const handleReorder = useCallback((next: QuickMessage[]) => {
    const reordered = next.map((m, index) => ({ ...m, sort_order: index }))
    setMessages(reordered)
    pendingOrderRef.current = reordered.map((m) => m.id)
  }, [])

  // 每次换了正在编辑的对象（点新建、点列表里的条目）就加一。保存是异步的，
  // 返回时编号变了说明用户已经切走，不能再动表单和选中项，免得覆盖新的输入
  const editSessionRef = useRef(0)

  const handleCreate = useCallback(() => {
    editSessionRef.current += 1
    setNewDraft(true)
    requestAnimationFrame(() => {
      titleInputRef.current?.focus()
    })
  }, [])

  const handleSelect = useCallback((id: number) => {
    editSessionRef.current += 1
    setNewDraft(false)
    setSelectedId(id)
  }, [])

  const titleMissing = draftTitle.trim() === ""
  const contentMissing = draftContent.trim() === ""

  const handleSave = useCallback(async () => {
    if (!newDraft && !selectedMessage) return
    // 全是空格的标题、内容不保存，免得列表里多出看不见文字的条目（#979）
    const title = draftTitle.trim()
    const content = draftContent.trim()
    if (!title || !content) {
      setShowRequired(true)
      return
    }
    setSaving(true)
    const session = editSessionRef.current
    // 点保存时表单里的原样内容；返回时表单变了，说明用户在等待时又打了字
    const submittedTitle = draftTitle
    const submittedContent = draftContent
    const typedSinceSubmit = () =>
      latestDraftRef.current.title !== submittedTitle ||
      latestDraftRef.current.content !== submittedContent
    // 保存中切走又切回同一条、切回后一个字没改时，表单显示的是保存前的旧值。
    // 没切走过，或者切回后改过（哪怕删回了原样），都不算
    const beforeSave = selectedMessage
    const showsRowBeforeSave = () =>
      beforeSave !== null &&
      editSessionRef.current !== session &&
      editingIdRef.current === beforeSave.id &&
      !editedSinceResetRef.current &&
      latestDraftRef.current.title === beforeSave.title &&
      latestDraftRef.current.content === beforeSave.content
    if (newDraft || !selectedMessage) {
      try {
        const created = await quickMessagesCreate({ title, content })
        setMessages((prev) => [...prev, created])
        if (editSessionRef.current === session) {
          editSessionRef.current += 1
          keepDraftOnSwitchRef.current = typedSinceSubmit()
          setSelectedId(created.id)
          setNewDraft(false)
        }
        toast.success(t("toasts.created"))
      } catch (err) {
        // 没建成就留在草稿里，填的字不丢，可以再点保存
        const message = toErrorMessage(err)
        toast.error(t("toasts.createFailed"), { description: message })
      } finally {
        setSaving(false)
      }
      return
    }
    try {
      const updated = await quickMessagesUpdate({
        id: selectedMessage.id,
        title,
        content,
      })
      setMessages((prev) =>
        prev.map((m) => (m.id === updated.id ? updated : m))
      )
      // 存进去的是去掉首尾空格的值，上面的重置不会因为保存触发，这里自己同步。
      // 用户已经切到别的条目、或者等待时又打了字，就不动表单，免得覆盖新的输入。
      // 切走又切回这一条、表单还是保存前的旧值时也要同步，不然再点保存会把新值改回去
      if (
        (editSessionRef.current === session && !typedSinceSubmit()) ||
        showsRowBeforeSave()
      ) {
        setDraftTitle(updated.title)
        setDraftContent(updated.content)
      }
      toast.success(t("toasts.saved"))
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.saveFailed"), { description: message })
    } finally {
      setSaving(false)
    }
  }, [newDraft, selectedMessage, draftTitle, draftContent, t])

  const handleDelete = useCallback(async () => {
    if (deleteTargetId === null) return
    const target = deleteTargetId
    setDeleting(true)
    try {
      await quickMessagesDelete(target)
      setMessages((prev) => {
        const next = prev.filter((m) => m.id !== target)
        if (selectedId === target) {
          editSessionRef.current += 1
          setSelectedId(next[0]?.id ?? null)
        }
        return next
      })
      toast.success(t("toasts.deleted"))
      setDeleteTargetId(null)
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("toasts.deleteFailed"), { description: message })
    } finally {
      setDeleting(false)
    }
  }, [deleteTargetId, selectedId, t])

  const safeContainerWidth =
    panelContainerWidth > 0 ? panelContainerWidth : 1200
  const leftMinSize = clamp(
    toPercent(LEFT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const rightMinSize = clamp(
    toPercent(RIGHT_MIN_WIDTH, safeContainerWidth),
    5,
    95
  )
  const leftMaxSize = Math.max(leftMinSize, 100 - rightMinSize)

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  const header = (
    <div className="flex items-center justify-between gap-3 pb-4">
      <div>
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t("description")}</p>
      </div>
    </div>
  )

  if (loadError != null) {
    // 没读出来就只说失败和重试，不说「暂无快捷消息」（#438）
    return (
      <div className="h-full flex flex-col p-3 md:p-4">
        {header}
        <div className="rounded-lg border bg-card">
          <SettingsLoadError
            message={loadError}
            onRetry={() => void refresh()}
          />
        </div>
      </div>
    )
  }

  const deleteTargetMessage =
    deleteTargetId !== null
      ? (messages.find((m) => m.id === deleteTargetId) ?? null)
      : null

  return (
    <div className="h-full flex flex-col p-3 md:p-4">
      {header}

      <div ref={panelContainerRef} className="flex-1 min-h-0 min-w-0">
        <ResizablePanelGroup
          direction="horizontal"
          className="h-full min-h-0 min-w-0"
        >
          <ResizablePanel
            defaultSize={34}
            minSize={leftMinSize}
            maxSize={leftMaxSize}
          >
            <div className="min-h-0 h-full min-w-0 rounded-lg border bg-card flex flex-col overflow-hidden lg:rounded-r-none">
              <div className="border-b p-3 space-y-2.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("searchPlaceholder")}
                  />
                  <Button size="sm" onClick={handleCreate} disabled={saving}>
                    <Plus className="h-3.5 w-3.5" />
                    {t("actions.new")}
                  </Button>
                </div>
              </div>

              {filteredMessages.length === 0 ? (
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-4 text-center">
                  {messages.length === 0
                    ? t("emptyList")
                    : t("searchPlaceholder")}
                </div>
              ) : (
                <Reorder.Group
                  as="div"
                  axis="y"
                  values={messages}
                  onReorder={handleReorder}
                  className="flex-1 min-h-0 overflow-y-auto space-y-2 p-2"
                >
                  {filteredMessages.map((m) => (
                    <QuickMessageReorderItem
                      key={m.id}
                      message={m}
                      selected={!newDraft && selectedId === m.id}
                      reordering={reordering}
                      onSelect={handleSelect}
                      onDragStart={() => {
                        /* no-op: list re-render handles dragging state */
                      }}
                      onDragEnd={() => {
                        const order = pendingOrderRef.current
                        pendingOrderRef.current = null
                        if (order && !reordering) {
                          persistReorder(order).catch((err) => {
                            console.error(
                              "[QuickMessagesSettings] reorder failed:",
                              err
                            )
                          })
                        }
                      }}
                    >
                      {(startDrag) => (
                        <div className="flex items-center gap-2 overflow-hidden">
                          <button
                            type="button"
                            className="text-muted-foreground cursor-grab active:cursor-grabbing rounded p-0.5 hover:bg-muted"
                            title={t("actions.dragSort")}
                            aria-label={t("actions.dragSortMessage", {
                              name: m.title.trim() || t("untitled"),
                            })}
                            onPointerDown={startDrag}
                            onClick={(event) => event.stopPropagation()}
                            disabled={reordering}
                          >
                            <GripVertical className="h-3.5 w-3.5" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">
                              {m.title.trim() || (
                                <span className="italic text-muted-foreground">
                                  {t("untitled")}
                                </span>
                              )}
                            </div>
                            {m.content.trim() && (
                              <div className="text-2xs text-muted-foreground truncate mt-0.5">
                                {m.content}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </QuickMessageReorderItem>
                  ))}
                </Reorder.Group>
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={66} minSize={rightMinSize}>
            <div className="h-full flex-1 min-h-0 min-w-0 rounded-lg border bg-card overflow-hidden lg:rounded-l-none lg:border-l-0">
              {newDraft || selectedMessage ? (
                <div className="h-full flex flex-col">
                  <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="quick-message-title" className="text-xs">
                        {t("fields.title")}
                      </Label>
                      <Input
                        id="quick-message-title"
                        ref={titleInputRef}
                        value={draftTitle}
                        onChange={(event) => {
                          editedSinceResetRef.current = true
                          setDraftTitle(event.target.value)
                        }}
                        placeholder={t("fields.titlePlaceholder")}
                        aria-invalid={showRequired && titleMissing}
                        aria-describedby={
                          showRequired && titleMissing
                            ? "quick-message-title-error"
                            : undefined
                        }
                      />
                      {showRequired && titleMissing && (
                        <p
                          id="quick-message-title-error"
                          className="text-xs text-destructive"
                        >
                          {t("fields.titleRequired")}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <Label
                        htmlFor="quick-message-content"
                        className="text-xs"
                      >
                        {t("fields.content")}
                      </Label>
                      <Textarea
                        id="quick-message-content"
                        value={draftContent}
                        onChange={(event) => {
                          editedSinceResetRef.current = true
                          setDraftContent(event.target.value)
                        }}
                        placeholder={t("fields.contentPlaceholder")}
                        className="min-h-[16.25rem]"
                        aria-invalid={showRequired && contentMissing}
                        aria-describedby={
                          showRequired && contentMissing
                            ? "quick-message-content-error"
                            : undefined
                        }
                      />
                      {showRequired && contentMissing && (
                        <p
                          id="quick-message-content-error"
                          className="text-xs text-destructive"
                        >
                          {t("fields.contentRequired")}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="border-t px-4 py-3 flex items-center justify-between gap-2">
                    {newDraft || !selectedMessage ? (
                      // 草稿还没存，没有可删的记录
                      <span />
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeleteTargetId(selectedMessage.id)}
                        className="text-red-500 hover:text-red-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t("actions.delete")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => {
                        handleSave().catch((err) => {
                          console.error(
                            "[QuickMessagesSettings] save failed:",
                            err
                          )
                        })
                      }}
                      disabled={saving || !isDirty}
                    >
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {t("actions.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  {t("emptySelection")}
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmDelete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmDelete.message", {
                name: deleteTargetMessage?.title.trim() || t("untitled"),
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {t("confirmDelete.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                handleDelete().catch((err) => {
                  console.error("[QuickMessagesSettings] delete failed:", err)
                })
              }}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {t("confirmDelete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
