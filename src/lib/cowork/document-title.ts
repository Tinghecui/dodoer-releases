"use client"

// Cowork fork: a page title that survives Next's own. On a client-side
// navigation Next puts the route's metadata title (the root layout's: just
// the product name) back, and on most settings pages it lands after the
// layout's effect has run, so setting `document.title` once loses the race
// (AI QA run 42476829791: only Shortcuts and Skills kept "Settings - Cowork").

import { useEffect } from "react"

/**
 * Keep `document.title` at `title` while the caller is mounted, putting it
 * back whenever something else rewrites the `<title>`. Only one mounted
 * caller should own the title at a time, or the two would trade it.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const apply = () => {
      if (document.title !== title) document.title = title
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => observer.disconnect()
  }, [title])
}
