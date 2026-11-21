/**
 * End-to-end test builds only: the frontend half of `tauri-plugin-wdio`
 * (vendored `@wdio/tauri-plugin`), which `@wdio/tauri-service` needs for
 * window states, `browser.tauri.execute` and mocks.
 *
 * `process.env.CODEG_E2E` is set in next.config.ts at build time ("1" only
 * when built with NEXT_PUBLIC_CODEG_E2E=1, "" otherwise) and inlined by the
 * bundler, so a normal build sees `if ("" === "1")`, drops the branch and
 * never emits the plugin's chunk. scripts/check-no-e2e-bits.sh checks that on
 * every desktop release. The backend half is the Rust `e2e` feature
 * (src-tauri/src/e2e.rs).
 */
export function loadWdioTauriPlugin(): Promise<unknown> | null {
  if (process.env.CODEG_E2E === "1") {
    return import("./vendor/wdio-tauri-plugin.js")
  }
  return null
}
