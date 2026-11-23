"use client"

import { Children, isValidElement, type ReactNode } from "react"
import { ChevronLeft } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { useMobileBackOverride } from "@/components/layout/mobile-back-button"
import { useIsMobile } from "@/hooks/use-mobile"
import { isDesktop } from "@/lib/transport"
import { cn } from "@/lib/utils"

interface SplitPaneProps {
  defaultSize?: number
  minSize?: number
  maxSize?: number
  children?: ReactNode
}

/**
 * {@link ListDetailSplit} 的一栏。宽屏时就是一个 `ResizablePanel`（尺寸参数原样
 * 传过去）；手机布局下只取里面的内容。
 */
export function SplitPane({ children }: SplitPaneProps) {
  return <>{children}</>
}

interface ListDetailSplitProps {
  /** 手机布局下现在显示详情（用户点了列表里的一项）。宽屏时不看。 */
  showDetail: boolean
  /** 手机布局下从详情回到列表。 */
  onBack: () => void
  /** 手机布局下详情顶部返回按钮旁边的标题（文件名这类）。 */
  detailTitle?: ReactNode
  className?: string
  /** 两个 {@link SplitPane}：第一个是列表，第二个是详情。 */
  children: ReactNode
}

/**
 * 提交、推送、stash 这几页的「列表 + 详情」（#1335）。宽屏是原来的左右分栏；
 * 手机布局（不是桌面版）下改成上下一屏一屏：先看列表，点一项进详情，详情顶部
 * 有返回回到列表。标题栏上的返回按钮这时也先回到列表，在列表里再按才离开这页。
 *
 * 手机上两栏都挂着、只把不看的那栏藏起来：提交说明的输入框是非受控的，卸掉
 * 再挂回来，打了一半的说明就没了；文件树展开到哪、滚到哪也都留着。
 */
export function ListDetailSplit({
  showDetail,
  onBack,
  detailTitle,
  className,
  children,
}: ListDetailSplitProps) {
  const t = useTranslations("Folder.windowControls")
  const isMobile = useIsMobile()
  const stacked = isMobile && !isDesktop()
  const detailActive = stacked && showDetail
  useMobileBackOverride(detailActive ? onBack : null)

  const [list, detail] = Children.toArray(children).filter(
    (child): child is React.ReactElement<SplitPaneProps> =>
      isValidElement<SplitPaneProps>(child)
  )
  const listProps: SplitPaneProps = list?.props ?? {}
  const detailProps: SplitPaneProps = detail?.props ?? {}

  // 宽屏和手机布局渲染的是同一棵树（同一个分栏、同样的两栏），手机上只是把
  // 拖动条和不看的那栏藏起来。窗口宽度跨过手机布局的临界值时，两栏里的东西
  // 不会被卸掉重挂：换成两棵不同的树的话，打了一半的提交说明会从输入框里消失，
  // 可提交按钮还认着旧说明。
  return (
    <ResizablePanelGroup direction="horizontal" className={className}>
      <ResizablePanel
        data-list-detail-pane="list"
        className={cn(detailActive && "hidden")}
        defaultSize={listProps.defaultSize}
        minSize={listProps.minSize}
        maxSize={listProps.maxSize}
      >
        {listProps.children}
      </ResizablePanel>
      <ResizableHandle className={cn(stacked && "hidden")} />
      <ResizablePanel
        data-list-detail-pane="detail"
        className={cn(
          stacked && "flex-col",
          stacked && !detailActive && "hidden",
          detailActive && "flex"
        )}
        defaultSize={detailProps.defaultSize}
        minSize={detailProps.minSize}
        maxSize={detailProps.maxSize}
      >
        {stacked ? (
          <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label={t("back")}
              title={t("back")}
              onClick={onBack}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {detailTitle ? (
              <div className="min-w-0 flex-1 truncate text-xs font-medium">
                {detailTitle}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className={stacked ? "min-h-0 flex-1" : "h-full"}>
          {detailProps.children}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
