// Upstream features a Cowork build does not offer. One place, so the reasons
// sit next to the switches and upstream's components only read a constant.

import { COWORK_BUILD } from "./brand"

/**
 * The agent settings' system-instructions editor (the agent's global
 * CLAUDE.md / GEMINI.md / …).
 *
 * Off in a Cowork build: that file is the one Cowork writes for the employee,
 * and it is not opened for editing from here. The editor also resolves the
 * path from the server's own environment, not the agent's `env_json`, so
 * behind ccr it would show `~/.claude/CLAUDE.md` rather than the
 * `~/.claudr/CLAUDE.md` the agent reads. The backend half is untouched: it
 * writes only an edited text, and with no editor there is none.
 */
export const SYSTEM_INSTRUCTIONS_EDITOR_OFFERED = !COWORK_BUILD
