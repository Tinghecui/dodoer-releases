"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { useTranslations } from "next-intl"

/**
 * 对话区（`ConversationShell` 的根）交给里面输入框的东西：系统拖放按整个对话区
 * 判断落点，拖动经过时的高亮也画在对话区上，而不是输入框那一小块。
 *
 * 读不到它的输入框（待办任务的那几个、测试里单独挂的）照旧只认自己的外框。
 */
export interface ComposerDropZone {
  /** 对话区的根元素，`useComposerAttachments` 拿它当系统拖放的范围。 */
  zoneRef: RefObject<HTMLElement | null>
  /** 某个输入框报「系统拖动正经过这个对话区」，`source` 区分是哪个输入框。 */
  reportDragOver: (source: string, active: boolean) => void
}

const ComposerDropZoneContext = createContext<ComposerDropZone | null>(null)

export function useComposerDropZone(): ComposerDropZone | null {
  return useContext(ComposerDropZoneContext)
}

/**
 * 给对话区用：返回要放进 context 的值，和现在有没有拖动经过（任一个输入框报了
 * 就算）。`reportDragOver` 的引用不变，输入框的 effect 不会因为它反复跑。
 */
export function useComposerDropZoneProvider(
  zoneRef: RefObject<HTMLElement | null>
): { value: ComposerDropZone; dragOver: boolean } {
  const activeRef = useRef<Set<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const reportDragOver = useCallback((source: string, active: boolean) => {
    const set = activeRef.current
    if (active) set.add(source)
    else set.delete(source)
    setDragOver(set.size > 0)
  }, [])
  const value = useMemo(
    () => ({ zoneRef, reportDragOver }),
    [zoneRef, reportDragOver]
  )
  return { value, dragOver }
}

export function ComposerDropZoneProvider({
  value,
  children,
}: {
  value: ComposerDropZone
  children: ReactNode
}) {
  return (
    <ComposerDropZoneContext.Provider value={value}>
      {children}
    </ComposerDropZoneContext.Provider>
  )
}

/**
 * 对话区上的高亮。必须 `pointer-events-none`：不然 `elementFromPoint` 取到的是
 * 它自己，落点就判不到对话区里的东西了；`z-30` 盖在底部 dock（`z-20`）上面。
 */
export function ComposerDropZoneOverlay() {
  const t = useTranslations("Folder.chat.messageInput")
  return (
    <div
      data-composer-drop-zone-overlay=""
      className="pointer-events-none absolute inset-1 z-30 flex items-center justify-center rounded-md border border-dashed border-primary/50 bg-background/80 text-sm text-muted-foreground"
    >
      {t("dropFilesToAttach")}
    </div>
  )
}
