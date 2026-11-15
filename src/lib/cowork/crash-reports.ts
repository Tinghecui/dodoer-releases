// Cowork fork: the desktop app's own crash and hang reports
// (`src-tauri/src/crash_report`, docs/telemetry.md §5.11). The switch is the
// app's, so every call goes to the app (the shell transport), never to the
// window's server — the same in a local and in a remote window.

import { getShellTransport } from "@/lib/transport"

/** `CrashReportSettings` in `src-tauri/src/crash_report/mod.rs`. */
export interface CrashReportSettings {
  enabled: boolean
}

export function getCrashReportSettings(): Promise<CrashReportSettings> {
  return getShellTransport().call("get_crash_report_settings")
}

export function updateCrashReportSettings(
  settings: CrashReportSettings
): Promise<CrashReportSettings> {
  return getShellTransport().call("update_crash_report_settings", { settings })
}
