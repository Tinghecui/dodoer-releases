"use client"

import {
  Fragment,
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { listAllConversations, searchConversationMessages } from "@/lib/api"
import type {
  AgentType,
  ConversationMessageHit,
  ConversationSearchResponse,
  ConversationSearchResult,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { requestTurnReveal } from "@/stores/turn-reveal-store"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
import { compareAgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

type SearchTab = "conversations" | "files"
/** Which projects the conversations tab searches. */
type SearchScope = "project" | "all"

/** How a finished search was limited, for the notice under the results. */
type SearchLimits = Pick<
  ConversationSearchResponse,
  "stopped" | "scanned_count" | "candidate_count"
> & { result_count: number }

/** `text` with each case-insensitive occurrence of `query` marked. */
function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase()
  const lowered = text.toLowerCase()
  // Lowercasing that changes the length (rare) would shift every offset:
  // show the text unmarked rather than mark the wrong characters.
  if (!needle || lowered.length !== text.length) return <>{text}</>
  const parts: ReactNode[] = []
  let from = 0
  for (
    let at = lowered.indexOf(needle);
    at !== -1;
    at = lowered.indexOf(needle, from)
  ) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark
        key={at}
        className="rounded-sm bg-yellow-200/70 px-0.5 text-foreground dark:bg-yellow-500/30"
      >
        {text.slice(at, at + needle.length)}
      </mark>
    )
    from = at + needle.length
  }
  if (from < text.length) parts.push(text.slice(from))
  return <>{parts}</>
}

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const folderId = activeFolderId ?? 0
  // Current project by default; "all projects" searches every one. Without an
  // active project there is only "all".
  const [scope, setScope] = useState<SearchScope>("project")
  const searchAll = scope === "all" || folderId <= 0
  const conversations = useMemo(
    () =>
      searchAll
        ? allConversations
        : allConversations.filter((c) => c.folder_id === activeFolderId),
    [allConversations, activeFolderId, searchAll]
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  // The search box owns the keyboard: the dialog opens with the cursor in it,
  // and switching tabs or agent filters leaves it there, so typing always
  // searches.
  const inputRef = useRef<HTMLInputElement>(null)
  const switchTab = useCallback((tab: SearchTab) => {
    setActiveTab(tab)
    inputRef.current?.focus()
  }, [])
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<ConversationSearchResult[]>([])
  const [limits, setLimits] = useState<SearchLimits | null>(null)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Bumped by every new search (and by every keystroke, before the debounce
  // fires): a response that comes back after it is stale and is dropped, so a
  // slow search for an earlier query never replaces a newer one's results.
  const searchSeqRef = useRef(0)

  const folderPath = folder?.path ?? ""

  // File search via shared hook (lazy-loaded when files tab is active)
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: open && activeTab === "files",
    query,
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // The backend ranks the whole workspace before capping the response, so a
  // deeply nested match remains reachable without retaining the full index.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null) => {
      const seq = ++searchSeqRef.current
      const text = q.trim()
      if (!text && !agent) {
        setResults([])
        setLimits(null)
        setSearching(false)
        return
      }
      const folderIds = searchAll ? null : [folderId]
      setSearching(true)
      try {
        if (text) {
          // Titles and message text, matched by the backend: the rows are
          // shown as returned, never filtered again here.
          const data = await searchConversationMessages({
            folder_ids: folderIds,
            agent_type: agent,
            query: text,
          })
          if (seq !== searchSeqRef.current) return
          setResults(data.results)
          setLimits({
            stopped: data.stopped,
            scanned_count: data.scanned_count,
            candidate_count: data.candidate_count,
            result_count: data.results.length,
          })
        } else {
          // An agent filter alone lists that agent's conversations.
          const rows = await listAllConversations({
            folder_ids: folderIds,
            agent_type: agent,
          })
          if (seq !== searchSeqRef.current) return
          setResults(
            rows.map((conversation) => ({
              conversation,
              title_match: false,
              hits: [],
            }))
          )
          setLimits(null)
        }
      } catch {
        if (seq !== searchSeqRef.current) return
        setResults([])
        setLimits(null)
      } finally {
        if (seq === searchSeqRef.current) setSearching(false)
      }
    },
    [folderId, searchAll]
  )

  // Debounced search on query change (conversations tab only). Each change
  // also voids the search in flight, so its results can't land under the new
  // query while the debounce waits.
  useEffect(() => {
    if (activeTab !== "conversations") return
    searchSeqRef.current += 1
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, agentFilter)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, agentFilter, doSearch, activeTab])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setAgentFilter(null)
      setResults([])
      setLimits(null)
      setScope("project")
      searchSeqRef.current += 1
      setActiveTab("conversations")
      // Like the full re-list this replaced, each opening searches files as
      // they are now, not a native snapshot left over from before it opened.
      resetFileTree(true)
    }
  }, [open, resetFileTree])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary, hit?: ConversationMessageHit) => {
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      // A message hit: the transcript jumps to its round once it has loaded.
      if (hit) {
        requestTurnReveal({
          conversationId: conv.id,
          turnId: hit.turn_id,
          turnIndex: hit.turn_index,
        })
      }
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )

  const placeholder =
    activeTab === "conversations" ? t("placeholder") : t("filePlaceholder")

  return (
    <CommandDialog
      title={
        folder
          ? t("dialogTitleWithFolder", { name: folder.name })
          : t("dialogTitle")
      }
      open={open}
      onOpenChange={onOpenChange}
      // Never cmdk's own filter: conversations are matched by the backend
      // (by title AND message text, which cmdk can't see) and files ranked by
      // `rankFileMatches`.
      shouldFilter={false}
      // Not `autoFocus`: an input focused while mounting takes focus before
      // the focus trap starts listening, so the trap never records it and has
      // nothing to pull focus back to when the chat composer behind the dialog
      // refocuses itself at the end of a turn — the rest of the query would be
      // typed into the composer.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
      }}
    >
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5 pe-12">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {searchAll && activeTab === "conversations"
              ? t("dialogTitle")
              : t("dialogTitleWithFolder", { name: folder.name })}
          </span>
          {activeTab === "conversations" && (
            <div
              role="group"
              className="ms-auto flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5"
            >
              {(["project", "all"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={scope === value}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setScope(value)
                    inputRef.current?.focus()
                  }}
                  className={cn(
                    "h-6 rounded px-2 text-xs transition-colors",
                    scope === value
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {value === "project" ? t("scopeProject") : t("scopeAll")}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {activeTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => switchTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {activeTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
      </div>

      <CommandInput
        ref={inputRef}
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />

      {/* Agent filter (conversations tab only). Wraps: one chip per agent type
          present in the folder, each carrying a full name, so a workspace with
          a dozen enabled agents runs past the dialog — which is
          `overflow-hidden`, so the tail chips were clipped away and simply
          could not be clicked. Wrapping keeps every filter reachable and lets
          the block grow by a row instead of hiding options. */}
      {activeTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b">
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {getAgentLabel(at)}
            </button>
          ))}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {limits?.stopped && !searching && (
              <p
                data-testid="search-limit-notice"
                className="px-4 pt-2 text-xs text-muted-foreground"
              >
                {limits.stopped === "results"
                  ? t("resultsLimited", { count: limits.result_count })
                  : t(
                      limits.stopped === "time"
                        ? "scanTimedOut"
                        : "scanLimited",
                      {
                        scanned: limits.scanned_count,
                        total: limits.candidate_count,
                      }
                    )}
              </p>
            )}
            {results.length > 0 && (
              <CommandGroup>
                {results.map(({ conversation: conv, hits }) => {
                  const [firstHit, ...moreHits] = hits
                  return (
                    <Fragment key={conv.id}>
                      <CommandItem
                        value={`conversation-${conv.id}`}
                        onSelect={() =>
                          handleSelectConversation(conv, firstHit)
                        }
                        className="flex-col items-stretch gap-1"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <ConversationStatusDot
                            status={conv.status as ConversationStatus}
                          />
                          <span className="flex-1 truncate">
                            <HighlightedText
                              text={
                                formatConversationTitle(conv.title) ||
                                t("untitledConversation")
                              }
                              query={query}
                            />
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {getAgentLabel(conv.agent_type)}
                          </span>
                          <span className="text-xs text-muted-foreground shrink-0">
                            {formatDistanceToNow(new Date(conv.created_at), {
                              addSuffix: true,
                              locale: dateFnsLocale,
                            })}
                          </span>
                        </div>
                        {firstHit && (
                          <span className="ps-4 text-xs text-muted-foreground line-clamp-2 break-words">
                            <HighlightedText
                              text={firstHit.snippet}
                              query={query}
                            />
                          </span>
                        )}
                      </CommandItem>
                      {moreHits.map((hit) => (
                        <CommandItem
                          key={`${conv.id}-${hit.turn_index}`}
                          value={`conversation-${conv.id}-turn-${hit.turn_index}`}
                          onSelect={() => handleSelectConversation(conv, hit)}
                          className="ps-8"
                        >
                          <span className="text-xs text-muted-foreground line-clamp-2 break-words">
                            <HighlightedText text={hit.snippet} query={query} />
                          </span>
                        </CommandItem>
                      ))}
                    </Fragment>
                  )
                })}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
