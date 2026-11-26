"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Settings2,
  Upload,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import {
  ListDetailSplit,
  SplitPane,
} from "@/components/layout/list-detail-split"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import {
  gitAddFiles,
  gitCommit,
  gitListRemotes,
  gitPush,
  gitRollbackFile,
  gitShowFile,
  gitStatus,
  deleteFileTreeEntry,
  openSettingsWindow,
  readFilePreview,
} from "@/lib/api"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  useGitCredential,
  type GitRemoteHint,
} from "@/contexts/git-credential-context"
import type { GitStatusEntry } from "@/lib/types"
import {
  isRenameStatus,
  rollbackPaths,
  splitGitStatusRename,
} from "@/lib/git-status-path"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { DiffViewer } from "@/components/diff/diff-viewer"
import { ImageDiffView } from "@/components/diff/image-diff-view"
import { loadImageDiffSides, type ImageDiffSides } from "@/lib/image-diff"
import { isBinaryImageFile, languageFromPath } from "@/lib/language-detect"
import {
  toErrorMessage,
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"
import type { CommitScope } from "@/lib/commit-window-paths"
import {
  sameFiles,
  useCommitMessageGeneration,
} from "@/hooks/use-commit-message-generation"
import { CommitMessageGenerateButton } from "@/components/layout/commit-message-generate-button"
import { CommitMessageSettingsDialog } from "@/components/layout/commit-message-settings-dialog"

interface CommitWorkspaceProps {
  folderPath: string
  folderId?: number | null
  /** The project folder whose commit message settings apply — a worktree
   *  folder's repository. Defaults to `folderId`. */
  projectFolderId?: number | null
  /** 从某几个文件（或目录）打开时传入，如「变更」面板右键「提交代码」：
   *  只勾这些路径（目录算它下面的所有改动），预览其中第一个。没给、
   *  或者一个都不在改动里时，照旧勾上全部已跟踪改动。 */
  initialPaths?: readonly string[] | null
  /** 只勾这一组改动（#528）：「未跟踪」分组的根只带它、不带路径时勾全部
   *  未跟踪文件；和 `initialPaths` 一起给时只勾路径下这一组的改动。 */
  initialScope?: CommitScope | null
  onCommitted?: () => void
  onCancel?: () => void
}

interface TreeFileNode {
  kind: "file"
  name: string
  path: string
  entry: GitStatusEntry
}

interface TreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: TreeNode[]
}

type TreeNode = TreeFileNode | TreeDirNode

const UNTRACKED_STATUS = "??"
const DEFAULT_LEFT_PANE_WIDTH = 420
const MIN_LEFT_PANE_WIDTH = 320
const MIN_RIGHT_PANE_WIDTH = 360

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function toPercent(pixels: number, totalPixels: number): number {
  if (totalPixels <= 0) return 0
  return (pixels / totalPixels) * 100
}

function buildFileTree(entries: GitStatusEntry[]): TreeNode[] {
  type BuildDir = {
    name: string
    path: string
    dirs: Map<string, BuildDir>
    files: TreeFileNode[]
  }

  const root: BuildDir = {
    name: "",
    path: "",
    dirs: new Map(),
    files: [],
  }

  for (const entry of entries) {
    const parts = entry.file.split("/").filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    let currentPath = ""

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      const isLeaf = i === parts.length - 1
      currentPath = currentPath ? `${currentPath}/${part}` : part

      if (isLeaf) {
        current.files.push({
          kind: "file",
          name: part,
          path: currentPath,
          entry,
        })
      } else {
        const found = current.dirs.get(part)
        if (found) {
          current = found
        } else {
          const next: BuildDir = {
            name: part,
            path: currentPath,
            dirs: new Map(),
            files: [],
          }
          current.dirs.set(part, next)
          current = next
        }
      }
    }
  }

  function sortNodes(nodes: TreeNode[]) {
    return nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  function toNodes(dir: BuildDir): TreeNode[] {
    const dirs: TreeNode[] = Array.from(dir.dirs.values()).map((child) => ({
      kind: "dir",
      name: child.name,
      path: child.path,
      children: toNodes(child),
    }))

    return sortNodes([...dirs, ...dir.files])
  }

  return toNodes(root)
}

/** Collect all file paths under a tree node (recursive). */
function collectFilePaths(node: TreeNode): string[] {
  if (node.kind === "file") return [node.path]
  return node.children.flatMap(collectFilePaths)
}

/** Depth-first traversal to find the first file node (matches visual order). */
function findFirstFile(nodes: TreeNode[]): string | undefined {
  for (const node of nodes) {
    if (node.kind === "file") return node.path
    const found = findFirstFile(node.children)
    if (found) return found
  }
  return undefined
}

/** 改名的一行（#527）：file 是新名，originalFile 是旧名，预览旧版本时用。 */
type CommitEntry = GitStatusEntry & { originalFile?: string }

/**
 * 把状态里的「旧名 -> 新名」拆开，勾选、提交、对路径都用新名。只拆改名、复制的
 * 行；普通文件名里本来带「 -> 」的原样保留。
 */
function toCommitEntries(result: GitStatusEntry[]): CommitEntry[] {
  return result.map((entry) => {
    if (!isRenameStatus(entry.status)) return entry
    const { file, originalFile } = splitGitStatusRename(entry.file)
    return originalFile ? { ...entry, file, originalFile } : entry
  })
}

/** `paths` 里的文件本身，或者 `paths` 里某个目录下面的文件。 */
function matchesInitialPaths(file: string, paths: readonly string[]) {
  return paths.some((raw) => {
    const path = raw.replace(/^\.\/+/, "").replace(/\/+$/, "")
    if (!path) return false
    return file === path || file.startsWith(`${path}/`)
  })
}

function collectDirPaths(entries: GitStatusEntry[]) {
  const paths = new Set<string>()

  for (const entry of entries) {
    const parts = entry.file.split("/").filter(Boolean)
    if (parts.length < 2) continue

    let currentPath = ""
    for (let i = 0; i < parts.length - 1; i += 1) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]
      paths.add(currentPath)
    }
  }

  return paths
}

interface ConfirmState {
  open: boolean
  title: string
  description: string
  action: (() => void) | null
  variant: "default" | "destructive"
}

const CONFIRM_INITIAL: ConfirmState = {
  open: false,
  title: "",
  description: "",
  action: null,
  variant: "default",
}

export function CommitWorkspace({
  folderPath,
  folderId,
  projectFolderId,
  initialPaths,
  initialScope,
  onCommitted,
  onCancel,
}: CommitWorkspaceProps) {
  const t = useTranslations("Folder.commitDialog")
  const tCommon = useTranslations("Folder.common")
  const tGenerate = useTranslations("CommitMessageGeneration")
  const { withCredentialRetry } = useGitCredential()
  const [entries, setEntries] = useState<CommitEntry[]>([])
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [diffOriginal, setDiffOriginal] = useState("")
  const [diffModified, setDiffModified] = useState("")
  const [diffLanguage, setDiffLanguage] = useState("plaintext")
  const [diffFile, setDiffFile] = useState<string | null>(null)
  // 手机布局下点了文件、正在看详情（#1335）。打开时自动载入的第一个文件的
  // 差异不算：手机上先看列表。宽屏不看它。
  const [detailOpen, setDetailOpen] = useState(false)
  // Carries the file it was loaded for: the several places that drop the diff
  // only reset `diffFile`, and matching on it keeps a previous file's pixels
  // from outliving the selection that produced them.
  const [diffImage, setDiffImage] = useState<{
    file: string
    sides: ImageDiffSides
  } | null>(null)
  const messageRef = useRef("")
  // The box is uncontrolled (typing must not re-render the file tree); a
  // generated message is written into it through this.
  const messageBoxRef = useRef<HTMLTextAreaElement>(null)
  const [hasMessage, setHasMessage] = useState(false)
  const [messageInputKey, setMessageInputKey] = useState(0)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 红框里显示的正是「缺少 Git 身份」的说明时，旁边给「去设置」。
  const identityMissingMessage = t("errors.gitIdentityMissing")
  const [untrackedOpen, setUntrackedOpen] = useState(false)
  const [expandedTrackedDirs, setExpandedTrackedDirs] = useState<Set<string>>(
    new Set()
  )
  const [expandedUntrackedDirs, setExpandedUntrackedDirs] = useState<
    Set<string>
  >(new Set())
  const [confirm, setConfirm] = useState<ConfirmState>(CONFIRM_INITIAL)
  // 带着路径打开、却有路径一个改动都没对上时，列表上方写明哪些没有改动；
  // 路径参数读不出来时是 []（#442）。null = 不用提示。
  const [unmatchedPaths, setUnmatchedPaths] = useState<string[] | null>(null)

  // Use refs to track mutable values without causing callback recreation
  const diffFileRef = useRef(diffFile)
  diffFileRef.current = diffFile
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const entriesRef = useRef(entries)
  entriesRef.current = entries

  const folderName = useMemo(() => {
    const parts = folderPath.replace(/[/\\]+$/, "").split(/[/\\]/)
    return parts[parts.length - 1] || folderPath
  }, [folderPath])

  const trackedEntries = useMemo(
    () => entries.filter((entry) => entry.status !== UNTRACKED_STATUS),
    [entries]
  )
  const untrackedEntries = useMemo(
    () => entries.filter((entry) => entry.status === UNTRACKED_STATUS),
    [entries]
  )
  const trackedTree = useMemo(
    () => buildFileTree(trackedEntries),
    [trackedEntries]
  )
  const untrackedTree = useMemo(
    () => buildFileTree(untrackedEntries),
    [untrackedEntries]
  )
  const filePathSet = useMemo(
    () => new Set(entries.map((entry) => entry.file)),
    [entries]
  )
  const trackedFiles = useMemo(
    () => trackedEntries.map((entry) => entry.file),
    [trackedEntries]
  )
  const untrackedFiles = useMemo(
    () => untrackedEntries.map((entry) => entry.file),
    [untrackedEntries]
  )

  // Only the newest selection may write to the diff pane. Two selections in
  // flight can settle in either order, and an older one landing last would
  // otherwise overwrite the current file's content — or clear its spinner —
  // with something the user is no longer looking at.
  const diffRequestRef = useRef(0)

  // Shared diff loading logic — extracted to avoid duplication
  const loadDiff = useCallback(
    async (file: string, allEntries?: CommitEntry[]) => {
      if (!folderPath) return
      const requestId = ++diffRequestRef.current
      setDiffFile(file)
      setDiffLanguage(languageFromPath(file))
      setLoadingDiff(true)
      setDiffOriginal("")
      setDiffModified("")
      setDiffImage(null)

      try {
        const statusSource = allEntries ?? entriesRef.current
        const statusEntry = statusSource.find((e) => e.file === file)
        const isUntracked = statusEntry?.status === UNTRACKED_STATUS
        // 改名的文件，旧版本要按旧名去取（#527）。
        const originalFile = statusEntry?.originalFile ?? file

        if (isBinaryImageFile(file)) {
          // An untracked file has no blob at HEAD either way, so the ref read
          // resolves to "absent" on its own — no need to special-case it.
          const sides = await loadImageDiffSides(
            folderPath,
            file,
            { kind: "ref", ref: "HEAD", missingRefIsAbsent: true },
            { kind: "worktree" },
            originalFile
          )
          if (diffRequestRef.current !== requestId) return
          setDiffImage({ file, sides })
          return
        }

        const [originalContent, modifiedContent] = await Promise.all([
          isUntracked
            ? Promise.resolve("")
            : gitShowFile(folderPath, originalFile).catch(() => ""),
          readFilePreview(folderPath, file)
            .then((r) => r.content)
            .catch(() => ""),
        ])

        if (diffRequestRef.current !== requestId) return
        setDiffOriginal(originalContent)
        setDiffModified(modifiedContent)
      } catch {
        if (diffRequestRef.current !== requestId) return
        setDiffOriginal("")
        setDiffModified("")
      } finally {
        if (diffRequestRef.current === requestId) setLoadingDiff(false)
      }
    },
    [folderPath]
  )

  const loadStatus = useCallback(async () => {
    if (!folderPath) return
    setLoadingStatus(true)
    setError(null)
    try {
      const result = toCommitEntries(await gitStatus(folderPath, true))
      setEntries(result)
      const tracked = result.filter(
        (entry) => entry.status !== UNTRACKED_STATUS
      )
      const untracked = result.filter(
        (entry) => entry.status === UNTRACKED_STATUS
      )
      // 带了路径（哪怕读不出来、一个都没对上）就只勾对上的；只有完全没带
      // 路径时才勾全部已跟踪改动。对不上时全勾会让人误提交别的文件（#442）。
      // 带了范围（#528）就只在这一组里挑；只带范围不带路径时勾这一组全部。
      const scoped = initialScope
        ? initialScope === "untracked"
          ? untracked
          : tracked
        : result
      const withPaths = initialPaths != null || initialScope != null
      const picked = withPaths
        ? initialPaths != null
          ? scoped.filter((entry) =>
              matchesInitialPaths(entry.file, initialPaths)
            )
          : scoped
        : []
      const pickedFiles = new Set(picked.map((entry) => entry.file))
      setSelected(
        withPaths ? pickedFiles : new Set(tracked.map((entry) => entry.file))
      )
      if (initialPaths != null) {
        const missing = initialPaths.filter(
          (path) =>
            !scoped.some((entry) => matchesInitialPaths(entry.file, [path]))
        )
        setUnmatchedPaths(
          initialPaths.length === 0 || missing.length > 0 ? missing : null
        )
      } else {
        setUnmatchedPaths(null)
      }
      // 勾上的有未跟踪文件时把未跟踪分组展开，不然勾了也看不见。
      if (picked.some((entry) => entry.status === UNTRACKED_STATUS)) {
        setUntrackedOpen(true)
      }
      const trackedDirs = collectDirPaths(tracked)
      trackedDirs.add(folderName)
      setExpandedTrackedDirs(trackedDirs)
      const untrackedDirs = collectDirPaths(untracked)
      untrackedDirs.add(folderName)
      setExpandedUntrackedDirs(untrackedDirs)

      // Auto-select the first file in visual tree order for diff preview —
      // among the picked files when the window was opened for some.
      const previewTracked = withPaths
        ? tracked.filter((entry) => pickedFiles.has(entry.file))
        : tracked
      const previewUntracked = withPaths
        ? untracked.filter((entry) => pickedFiles.has(entry.file))
        : untracked
      const firstFile =
        findFirstFile(buildFileTree(previewTracked)) ??
        findFirstFile(buildFileTree(previewUntracked))
      if (firstFile) {
        await loadDiff(firstFile, result)
      }
    } catch (err) {
      setError(toErrorMessage(err))
      setEntries([])
      setExpandedTrackedDirs(new Set())
      setExpandedUntrackedDirs(new Set())
    } finally {
      setLoadingStatus(false)
    }
  }, [folderPath, folderName, initialPaths, initialScope, loadDiff])

  // Start over from the repository as it is now: no diff, no message, the
  // file list (and its selection) re-read. On a new folder, and after a
  // commit — the host usually closes the window then, but one that stays open
  // (a browser tab that won't close) must not keep offering the files it just
  // committed.
  const resetAndReload = useCallback(() => {
    setDiffOriginal("")
    setDiffModified("")
    setDiffImage(null)
    setDiffLanguage("plaintext")
    setDiffFile(null)
    messageRef.current = ""
    setHasMessage(false)
    setMessageInputKey((key) => key + 1)
    setUntrackedOpen(false)
    setSelected(new Set())
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (!folderPath) return
    resetAndReload()
  }, [folderPath, resetAndReload])

  const handleViewDiff = useCallback(
    (file: string) => {
      // 手机布局下点了文件就进详情，点的是已经载入差异的那个也一样（#1335）
      setDetailOpen(true)
      if (!folderPath || diffFileRef.current === file) return
      void loadDiff(file)
    },
    [folderPath, loadDiff]
  )

  const toggleFile = useCallback((file: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(file)) {
        next.delete(file)
      } else {
        next.add(file)
      }
      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (prev.size === entries.length) {
        return new Set<string>()
      }
      return new Set(entries.map((entry) => entry.file))
    })
  }, [entries])

  const toggleGroup = useCallback((files: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev)
      const allInGroupSelected = files.every((file) => next.has(file))
      if (allInGroupSelected) {
        files.forEach((file) => next.delete(file))
      } else {
        files.forEach((file) => next.add(file))
      }
      return next
    })
  }, [])

  const handleSelectPath = useCallback(
    (path: string) => {
      if (!filePathSet.has(path)) return
      handleViewDiff(path)
    },
    [filePathSet, handleViewDiff]
  )

  const handleCommit = useCallback(
    async (andPush?: boolean) => {
      const commitMessage = messageRef.current.trim()
      if (!commitMessage || selected.size === 0 || !folderPath) return
      setCommitting(true)
      setError(null)
      try {
        const result = await gitCommit(
          folderPath,
          commitMessage,
          Array.from(selected),
          folderId
        )
        toast.success(t("toasts.commitCompleted"), {
          description: t("toasts.committedFiles", {
            count: result.committed_files,
          }),
        })
        // Before the push: the commit stands even if pushing it fails.
        resetAndReload()

        if (andPush) {
          // Cowork fork (#202): with no remote, the push would only fail with
          // git's own "'origin' does not appear to be a git repository" in a
          // passing toast. Say so instead, and keep it in the window (which
          // stays open) so the user knows the commit was not pushed. A failed
          // lookup is not the answer "no remote": the push then tries and
          // reports for itself.
          const remotes = await gitListRemotes(folderPath).catch(() => null)
          if (remotes != null && remotes.length === 0) {
            const message = t("toasts.pushSkippedNoRemote")
            toast.warning(message)
            setError(message)
            return
          }
          try {
            const hint: GitRemoteHint = { folderPath }
            await withCredentialRetry(
              (creds) => gitPush(folderPath, null, creds, folderId),
              hint
            )
          } catch (pushErr) {
            toast.error(t("toasts.pushFailed"), {
              description: toErrorMessage(pushErr),
            })
            return
          }
        }

        onCommitted?.()
      } catch (err) {
        // 没配 Git 姓名和邮箱时后端带 errors.gitIdentityMissing（#1419），
        // 显示中文说明，不再是整段 git 原文。
        setError(
          toLocalizedErrorMessage(err, t as unknown as AppErrorTranslator)
        )
      } finally {
        setCommitting(false)
      }
    },
    [
      folderId,
      folderPath,
      onCommitted,
      resetAndReload,
      selected,
      t,
      withCredentialRetry,
    ]
  )

  // --- Context menu actions ---

  const handleAddToVcs = useCallback(
    async (file: string) => {
      if (!folderPath) return
      try {
        await gitAddFiles(folderPath, [file])
        toast.success(t("toasts.addedToVcs"), { description: file })
        void loadStatus()
      } catch (err) {
        toast.error(t("toasts.addToVcsFailed"), {
          description: toErrorMessage(err),
        })
      }
    },
    [folderPath, loadStatus, t]
  )

  const handleDeleteFile = useCallback(
    (file: string) => {
      setConfirm({
        open: true,
        title: t("confirm.deleteTitle"),
        description: t("confirm.deleteDescription", { file }),
        variant: "destructive",
        action: () => {
          void (async () => {
            if (!folderPath) return
            try {
              await deleteFileTreeEntry(folderPath, file)
              toast.success(t("toasts.fileDeleted"), { description: file })
              // If deleted file was being viewed, clear the diff
              if (diffFileRef.current === file) {
                setDiffFile(null)
                setDiffOriginal("")
                setDiffModified("")
              }
              setSelected((prev) => {
                if (!prev.has(file)) return prev
                const next = new Set(prev)
                next.delete(file)
                return next
              })
              void loadStatus()
            } catch (err) {
              toast.error(t("toasts.deleteFailed"), {
                description: toErrorMessage(err),
              })
            }
          })()
        },
      })
    },
    [folderPath, loadStatus, t]
  )

  const handleRollbackFile = useCallback(
    (file: string) => {
      setConfirm({
        open: true,
        title: t("confirm.rollbackTitle"),
        description: t("confirm.rollbackDescription", { file }),
        variant: "destructive",
        action: () => {
          void (async () => {
            if (!folderPath) return
            try {
              // 改名的新名要连同旧名一起恢复，不然新名被删、旧名留着暂存的删除（#527）
              for (const target of rollbackPaths(file, entriesRef.current)) {
                await gitRollbackFile(folderPath, target)
              }
              toast.success(t("toasts.fileRolledBack"), { description: file })
              if (diffFileRef.current === file) {
                setDiffFile(null)
                setDiffOriginal("")
                setDiffModified("")
              }
              setSelected((prev) => {
                if (!prev.has(file)) return prev
                const next = new Set(prev)
                next.delete(file)
                return next
              })
              void loadStatus()
            } catch (err) {
              toast.error(t("toasts.rollbackFailed"), {
                description: toErrorMessage(err),
              })
            }
          })()
        },
      })
    },
    [folderPath, loadStatus, t]
  )

  const handleRollbackDir = useCallback(
    (dirPath: string, files: string[], displayName?: string) => {
      const label = displayName ?? dirPath
      setConfirm({
        open: true,
        title: t("confirm.rollbackTitle"),
        description: t("confirm.rollbackDirDescription", { dir: label }),
        variant: "destructive",
        action: () => {
          void (async () => {
            if (!folderPath) return
            try {
              // 目录里改名过来的文件，旧名在目录外的也要恢复（#527）
              for (const target of rollbackPaths(dirPath, entriesRef.current)) {
                await gitRollbackFile(folderPath, target)
              }
              toast.success(t("toasts.dirRolledBack"), {
                description: label,
              })
              if (diffFileRef.current && files.includes(diffFileRef.current)) {
                setDiffFile(null)
                setDiffOriginal("")
                setDiffModified("")
              }
              setSelected((prev) => {
                const next = new Set(prev)
                files.forEach((f) => next.delete(f))
                return next
              })
              void loadStatus()
            } catch (err) {
              toast.error(t("toasts.rollbackFailed"), {
                description: toErrorMessage(err),
              })
            }
          })()
        },
      })
    },
    [folderPath, loadStatus, t]
  )

  const handleDeleteDir = useCallback(
    (dirPath: string, files: string[], displayName?: string) => {
      const label = displayName ?? dirPath
      setConfirm({
        open: true,
        title: t("confirm.deleteTitle"),
        description: t("confirm.deleteDirDescription", { dir: label }),
        variant: "destructive",
        action: () => {
          void (async () => {
            if (!folderPath) return
            try {
              await deleteFileTreeEntry(folderPath, dirPath)
              toast.success(t("toasts.dirDeleted"), {
                description: label,
              })
              if (diffFileRef.current && files.includes(diffFileRef.current)) {
                setDiffFile(null)
                setDiffOriginal("")
                setDiffModified("")
              }
              setSelected((prev) => {
                const next = new Set(prev)
                files.forEach((f) => next.delete(f))
                return next
              })
              void loadStatus()
            } catch (err) {
              toast.error(t("toasts.deleteFailed"), {
                description: toErrorMessage(err),
              })
            }
          })()
        },
      })
    },
    [folderPath, loadStatus, t]
  )

  const handleAddDirToVcs = useCallback(
    async (dirPath: string, files: string[], displayName?: string) => {
      if (!folderPath) return
      const label = displayName ?? dirPath
      try {
        await gitAddFiles(folderPath, files)
        toast.success(t("toasts.addedToVcs"), { description: label })
        void loadStatus()
      } catch (err) {
        toast.error(t("toasts.addToVcsFailed"), {
          description: toErrorMessage(err),
        })
      }
    },
    [folderPath, loadStatus, t]
  )

  const closeConfirm = useCallback(() => {
    setConfirm(CONFIRM_INITIAL)
  }, [])

  const confirmActionRef = useRef(confirm.action)
  confirmActionRef.current = confirm.action

  const executeConfirmAction = useCallback(() => {
    confirmActionRef.current?.()
    setConfirm(CONFIRM_INITIAL)
  }, [])

  const allSelected = useMemo(
    () => entries.length > 0 && selected.size === entries.length,
    [entries.length, selected.size]
  )
  const trackedAllSelected = useMemo(
    () =>
      trackedFiles.length > 0 &&
      trackedFiles.every((file) => selected.has(file)),
    [trackedFiles, selected]
  )
  const untrackedAllSelected = useMemo(
    () =>
      untrackedFiles.length > 0 &&
      untrackedFiles.every((file) => selected.has(file)),
    [untrackedFiles, selected]
  )

  const handleMessageChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = e.target.value
      messageRef.current = nextValue
      const nextHasMessage = nextValue.trim().length > 0
      setHasMessage((prev) => (prev === nextHasMessage ? prev : nextHasMessage))
    },
    []
  )

  const generation = useCommitMessageGeneration({
    path: folderPath || null,
    folderId: folderId ?? null,
  })
  const { generating } = generation
  // The checked files are what the commit takes, so they are what the
  // message describes.
  const generateDisabledReason = committing
    ? tGenerate("busyCommitting")
    : selected.size === 0
      ? tGenerate("selectFiles")
      : null
  const handleGenerate = useCallback(async () => {
    const files = Array.from(selected)
    const generated = await generation.generate({
      files,
      draft: messageRef.current,
      // A commit window shows no session; the folder's default agent stands in.
      fallbackAgent: null,
    })
    const box = messageBoxRef.current
    if (generated === null || !box) return
    box.value = generated.message
    messageRef.current = generated.message
    setHasMessage(generated.message.trim().length > 0)
    if (!generated.autoCommit) return
    // Only ever the files the message was written for: a selection changed
    // meanwhile leaves the message in the box for the user to check.
    if (!sameFiles(files, Array.from(selectedRef.current))) {
      toast.info(tGenerate("toasts.autoCommitSkipped"))
      return
    }
    await handleCommit()
  }, [generation, handleCommit, selected, tGenerate])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const updateWidth = (next: number) => {
      setContainerWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next))
    }

    updateWidth(container.clientWidth)
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? container.clientWidth)
    })

    observer.observe(container)
    return () => {
      observer.disconnect()
    }
  }, [])

  const safeContainerWidth =
    containerWidth > 0
      ? containerWidth
      : DEFAULT_LEFT_PANE_WIDTH + MIN_RIGHT_PANE_WIDTH + 240
  const leftMinSize = clamp(
    toPercent(MIN_LEFT_PANE_WIDTH, safeContainerWidth),
    5,
    95
  )
  const rightMinSize = clamp(
    toPercent(MIN_RIGHT_PANE_WIDTH, safeContainerWidth),
    5,
    95
  )
  const leftMaxSize = Math.max(leftMinSize, 100 - rightMinSize)
  const leftDefaultSize = clamp(
    toPercent(DEFAULT_LEFT_PANE_WIDTH, safeContainerWidth),
    leftMinSize,
    leftMaxSize
  )

  // --- Render helpers for file tree nodes ---

  const renderTrackedNode = useCallback(
    function renderNode(node: TreeNode): React.ReactNode {
      if (node.kind === "dir") {
        const dirFiles = collectFilePaths(node)
        const hasNonDeleted = node.children.some(
          (child) =>
            child.kind === "file" &&
            child.entry.status !== " D" &&
            child.entry.status !== "D"
        )
        return (
          <ContextMenu key={`tracked:${node.path}`}>
            <ContextMenuTrigger>
              <FileTreeFolder name={node.name} path={node.path}>
                {node.children.map(renderNode)}
              </FileTreeFolder>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {hasNonDeleted && (
                <ContextMenuItem
                  onClick={() => handleRollbackDir(node.path, dirFiles)}
                >
                  {t("actions.rollback")}
                </ContextMenuItem>
              )}
              <ContextMenuItem
                variant="destructive"
                onClick={() => handleDeleteDir(node.path, dirFiles)}
              >
                {tCommon("delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }

      const isDeleted = node.entry.status === " D" || node.entry.status === "D"

      return (
        <ContextMenu key={`tracked:${node.path}`}>
          <ContextMenuTrigger>
            {/* No padding override: the row keeps the primitive's own px-2 so
                the checkbox lands in the column a sibling folder spends on its
                chevron, and both rows end flush on the right. */}
            <FileTreeFile name={node.name} path={node.path}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFile(node.path)
                }}
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  selected.has(node.path)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input"
                )}
                aria-label={t("aria.selectFile", {
                  action: selected.has(node.path)
                    ? t("actions.unselect")
                    : t("actions.select"),
                  path: node.path,
                })}
              >
                {selected.has(node.path) && <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                className="flex-1 truncate text-left hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  handleViewDiff(node.path)
                }}
                title={node.path}
              >
                {node.name}
              </button>
              <span className="w-6 shrink-0 text-right text-xs font-medium text-muted-foreground">
                {node.entry.status}
              </span>
            </FileTreeFile>
          </ContextMenuTrigger>
          <ContextMenuContent>
            {!isDeleted && (
              <ContextMenuItem onClick={() => handleRollbackFile(node.path)}>
                {t("actions.rollback")}
              </ContextMenuItem>
            )}
            <ContextMenuItem
              variant="destructive"
              onClick={() => handleDeleteFile(node.path)}
            >
              {tCommon("delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [
      selected,
      toggleFile,
      handleViewDiff,
      handleRollbackFile,
      handleRollbackDir,
      handleDeleteFile,
      handleDeleteDir,
      t,
      tCommon,
    ]
  )

  const renderUntrackedNode = useCallback(
    function renderNode(node: TreeNode): React.ReactNode {
      if (node.kind === "dir") {
        const dirFiles = collectFilePaths(node)
        return (
          <ContextMenu key={`untracked:${node.path}`}>
            <ContextMenuTrigger>
              <FileTreeFolder name={node.name} path={node.path}>
                {node.children.map(renderNode)}
              </FileTreeFolder>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onClick={() => {
                  void handleAddDirToVcs(node.path, dirFiles)
                }}
              >
                {t("actions.addToVcs")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onClick={() => handleDeleteDir(node.path, dirFiles)}
              >
                {tCommon("delete")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      }

      return (
        <ContextMenu key={`untracked:${node.path}`}>
          <ContextMenuTrigger>
            {/* No padding override: the row keeps the primitive's own px-2 so
                the checkbox lands in the column a sibling folder spends on its
                chevron, and both rows end flush on the right. */}
            <FileTreeFile name={node.name} path={node.path}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFile(node.path)
                }}
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  selected.has(node.path)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input"
                )}
                aria-label={t("aria.selectFile", {
                  action: selected.has(node.path)
                    ? t("actions.unselect")
                    : t("actions.select"),
                  path: node.path,
                })}
              >
                {selected.has(node.path) && <Check className="h-3 w-3" />}
              </button>
              <button
                type="button"
                className="flex-1 truncate text-left hover:underline"
                onClick={(e) => {
                  e.stopPropagation()
                  handleViewDiff(node.path)
                }}
                title={node.path}
              >
                {node.name}
              </button>
            </FileTreeFile>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onClick={() => handleAddToVcs(node.path)}>
              {t("actions.addToVcs")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              onClick={() => handleDeleteFile(node.path)}
            >
              {tCommon("delete")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [
      selected,
      toggleFile,
      handleViewDiff,
      handleAddToVcs,
      handleAddDirToVcs,
      handleDeleteFile,
      handleDeleteDir,
      t,
      tCommon,
    ]
  )

  const toggleTrackedGroup = useCallback(
    () => toggleGroup(trackedFiles),
    [toggleGroup, trackedFiles]
  )
  const toggleUntrackedGroup = useCallback(
    () => toggleGroup(untrackedFiles),
    [toggleGroup, untrackedFiles]
  )
  const toggleUntrackedOpen = useCallback(
    () => setUntrackedOpen((open) => !open),
    []
  )

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 overflow-hidden rounded-lg border bg-card"
    >
      <ListDetailSplit
        className="h-full min-h-0 min-w-0"
        showDetail={detailOpen && diffFile !== null}
        onBack={() => setDetailOpen(false)}
        detailTitle={diffFile}
      >
        <SplitPane
          defaultSize={leftDefaultSize}
          minSize={leftMinSize}
          maxSize={leftMaxSize}
        >
          <div className="flex h-full min-h-0 flex-col">
            {error && (
              <div className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span className="min-w-0 flex-1 break-words">{error}</span>
                {error === identityMissingMessage && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="shrink-0"
                    onClick={() => {
                      openSettingsWindow("version-control").catch((e) =>
                        toast.error(toErrorMessage(e))
                      )
                    }}
                  >
                    {t("errors.openSettings")}
                  </Button>
                )}
              </div>
            )}

            {unmatchedPaths && !loadingStatus && (
              <div className="border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {unmatchedPaths.length === 0
                  ? t("pathsInvalid")
                  : t("pathsNotChanged", {
                      paths: unmatchedPaths.join(t("pathSeparator")),
                      count: unmatchedPaths.length,
                    })}
              </div>
            )}

            <div className="flex h-9 items-center gap-2 border-b bg-muted/50 px-3">
              <button
                type="button"
                onClick={toggleAll}
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                  allSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input"
                )}
                aria-label={
                  allSelected
                    ? t("aria.unselectAllFiles")
                    : t("aria.selectAllFiles")
                }
              >
                {allSelected && <Check className="h-3 w-3" />}
              </button>
              <span className="text-xs text-muted-foreground">
                {loadingStatus
                  ? t("loading")
                  : t("selectionCount", {
                      selected: selected.size,
                      total: entries.length,
                    })}
              </span>
            </div>

            <div className="min-h-0 flex-1">
              <ScrollArea className="h-full">
                {entries.length === 0 && !loadingStatus ? (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                    {t("emptyFiles")}
                  </div>
                ) : (
                  <div className="space-y-3 p-2">
                    {trackedEntries.length > 0 && (
                      <section className="space-y-1">
                        <div className="flex items-center gap-2 px-1 text-2xs text-muted-foreground">
                          <button
                            type="button"
                            onClick={toggleTrackedGroup}
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors",
                              trackedAllSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input"
                            )}
                            aria-label={
                              trackedAllSelected
                                ? t("aria.unselectTracked")
                                : t("aria.selectTracked")
                            }
                          >
                            {trackedAllSelected && (
                              <Check className="h-2.5 w-2.5" />
                            )}
                          </button>
                          <span>
                            {t("trackedChanges", {
                              count: trackedEntries.length,
                            })}
                          </span>
                        </div>
                        <FileTree
                          className="rounded-none border-0 bg-transparent font-sans text-sm [&>div]:p-1"
                          expanded={expandedTrackedDirs}
                          onExpandedChange={setExpandedTrackedDirs}
                          selectedPath={diffFile ?? undefined}
                          onSelect={handleSelectPath}
                        >
                          <ContextMenu>
                            <ContextMenuTrigger>
                              <FileTreeFolder
                                name={folderName}
                                path={folderName}
                              >
                                {trackedTree.map(renderTrackedNode)}
                              </FileTreeFolder>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem
                                onClick={() =>
                                  handleRollbackDir(
                                    ".",
                                    trackedFiles,
                                    folderName
                                  )
                                }
                              >
                                {t("actions.rollback")}
                              </ContextMenuItem>
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() =>
                                  handleDeleteDir(".", trackedFiles, folderName)
                                }
                              >
                                {tCommon("delete")}
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        </FileTree>
                      </section>
                    )}

                    {untrackedEntries.length > 0 && (
                      <section className="space-y-1">
                        <div className="flex w-full items-center gap-2 px-1 py-0.5 text-2xs text-muted-foreground">
                          <button
                            type="button"
                            onClick={toggleUntrackedGroup}
                            className={cn(
                              "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors",
                              untrackedAllSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-input"
                            )}
                            aria-label={
                              untrackedAllSelected
                                ? t("aria.unselectUntracked")
                                : t("aria.selectUntracked")
                            }
                          >
                            {untrackedAllSelected && (
                              <Check className="h-2.5 w-2.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="flex items-center gap-1 hover:text-foreground"
                            onClick={toggleUntrackedOpen}
                          >
                            {untrackedOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <span>
                              {t("untrackedFiles", {
                                count: untrackedEntries.length,
                              })}
                            </span>
                          </button>
                        </div>
                        {untrackedOpen && (
                          <FileTree
                            className="rounded-none border-0 bg-transparent font-sans text-sm [&>div]:p-1"
                            expanded={expandedUntrackedDirs}
                            onExpandedChange={setExpandedUntrackedDirs}
                            selectedPath={diffFile ?? undefined}
                            onSelect={handleSelectPath}
                          >
                            <ContextMenu>
                              <ContextMenuTrigger>
                                <FileTreeFolder
                                  name={folderName}
                                  path={folderName}
                                >
                                  {untrackedTree.map(renderUntrackedNode)}
                                </FileTreeFolder>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  onClick={() => {
                                    void handleAddDirToVcs(
                                      ".",
                                      untrackedFiles,
                                      folderName
                                    )
                                  }}
                                >
                                  {t("actions.addToVcs")}
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  variant="destructive"
                                  onClick={() =>
                                    handleDeleteDir(
                                      ".",
                                      untrackedFiles,
                                      folderName
                                    )
                                  }
                                >
                                  {tCommon("delete")}
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          </FileTree>
                        )}
                      </section>
                    )}
                  </div>
                )}
              </ScrollArea>
            </div>

            <div className="border-t p-3">
              <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{t("commitMessage")}</span>
                <div className="flex items-center">
                  <CommitMessageGenerateButton
                    generating={generating}
                    elapsedSeconds={generation.elapsedSeconds}
                    disabledReason={generateDisabledReason}
                    onGenerate={() => void handleGenerate()}
                    onStop={generation.stop}
                    className="size-7 text-muted-foreground"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    title={tGenerate("settings")}
                    aria-label={tGenerate("settings")}
                    onClick={() => generation.setSettingsOpen(true)}
                  >
                    <Settings2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <Textarea
                key={messageInputKey}
                ref={messageBoxRef}
                placeholder={
                  generating
                    ? tGenerate("generating", {
                        seconds: generation.elapsedSeconds,
                      })
                    : t("commitMessagePlaceholder")
                }
                defaultValue=""
                readOnly={generating}
                onChange={handleMessageChange}
                className="field-scrollbar min-h-[5.625rem] max-h-[12.5rem] resize-y"
              />
              <CommitMessageSettingsDialog
                open={generation.settingsOpen}
                onOpenChange={generation.setSettingsOpen}
                folderId={projectFolderId ?? folderId ?? null}
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button variant="outline" onClick={onCancel}>
                  {tCommon("cancel")}
                </Button>
                <div className="flex">
                  <Button
                    disabled={
                      committing ||
                      generating ||
                      !hasMessage ||
                      selected.size === 0
                    }
                    onClick={() => handleCommit()}
                    className="rounded-r-none"
                  >
                    {committing && (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    )}
                    {t("commitButton", { count: selected.size })}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        disabled={
                          committing ||
                          generating ||
                          !hasMessage ||
                          selected.size === 0
                        }
                        className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                        aria-label={t("aria.moreCommitActions")}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => handleCommit()}>
                        <Check className="h-4 w-4" />
                        {t("commitButton", { count: selected.size })}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleCommit(true)}>
                        <Upload className="h-4 w-4" />
                        {t("commitAndPushButton", {
                          count: selected.size,
                        })}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        </SplitPane>

        <SplitPane defaultSize={100 - leftDefaultSize} minSize={rightMinSize}>
          <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
            {!diffFile ? (
              <>
                <div className="flex h-9 items-center gap-3 border-b bg-muted/50 px-3 text-xs text-muted-foreground">
                  <span className="font-medium">{t("head")}</span>
                  <span className="text-muted-foreground/60">↔</span>
                  <span className="font-medium">{t("workingTree")}</span>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                  {t("clickFileToDiff")}
                </div>
              </>
            ) : loadingDiff ? (
              <>
                <div className="flex h-9 items-center gap-3 border-b bg-muted/50 px-3 text-xs text-muted-foreground">
                  <span className="font-medium">{t("head")}</span>
                  <span className="text-muted-foreground/60">↔</span>
                  <span className="font-medium">{t("workingTree")}</span>
                </div>
                <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("loadingDiff")}
                </div>
              </>
            ) : diffImage && diffImage.file === diffFile ? (
              <ImageDiffView
                key={diffFile}
                original={diffImage.sides.original}
                modified={diffImage.sides.modified}
                originalLabel={t("head")}
                modifiedLabel={t("workingTree")}
                className="h-full [&>div:first-child]:h-9 [&>div:first-child]:py-0"
              />
            ) : (
              <DiffViewer
                key={diffFile}
                original={diffOriginal}
                modified={diffModified}
                originalLabel={t("head")}
                modifiedLabel={t("workingTree")}
                language={diffLanguage}
                className="h-full [&>div:first-child]:h-9 [&>div:first-child]:py-0"
              />
            )}
          </div>
        </SplitPane>
      </ListDetailSplit>

      <AlertDialog
        open={confirm.open}
        onOpenChange={(open) => {
          if (!open) closeConfirm()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant={
                confirm.variant === "destructive" ? "destructive" : "default"
              }
              onClick={executeConfirmAction}
            >
              {tCommon("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
