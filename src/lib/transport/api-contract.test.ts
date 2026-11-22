// @vitest-environment node
// The API contract (`src-tauri/src/web/api-contract.json`) against the
// sources: every route the server mounts, who calls each, and that every
// command and URL the frontend sends over HTTP has a route. The frontend and
// the server are often changed by different PRs; a name that no longer
// matches would otherwise show only on a real machine (a 501 in the browser,
// a remote window or an older desktop app). How the list is made and kept up
// to date: the head of `scripts/api-contract.mjs`. The Rust half
// (`web/router.rs`'s tests) asks the router it really builds for each route.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import {
  CONTRACT_FILE,
  FRONT_PROXY_COMMANDS,
  ROOT,
  UNKNOWN_CALLER,
  WEB,
  apiVersion,
  buildContract,
  describeChange,
  formatContract,
  frontendCalls,
  pathMatches,
  readContract,
  serverRoutes,
  stripRustComments,
} from "../../../scripts/api-contract.mjs"

const RUN = "node scripts/api-contract.mjs"

describe("api-contract.json against the sources", () => {
  const contract = readContract()
  const routes: string[] = serverRoutes()
  const built = buildContract(ROOT, contract)
  const listed = Object.keys(contract.routes)
  const web = (map: Record<string, string>) =>
    Object.entries(map)
      .filter(([, caller]) => caller === WEB)
      .map(([route]) => route)

  it("reads both sides", () => {
    expect(routes.length).toBeGreaterThan(500)
    // From router.rs, from what it merges in (cowork.rs, cli_run/http.rs),
    // and paths given as a constant.
    for (const route of [
      "POST /api/health",
      "POST /api/cowork_info",
      "POST /api/cli_run_start",
      "POST /api/telemetry_envelope",
      "GET /api/workspace_download/{ticket}",
      "GET /ws/events",
      "GET /ws/host-tunnel",
    ])
      expect(routes, route).toContain(route)
    const front = frontendCalls()
    // A literal, a constant, a function that builds `/api/${name}` itself.
    for (const command of [
      "acp_prompt",
      "telemetry_envelope",
      "workspace_download_ticket",
    ])
      expect(front.commands.has(command), command).toBe(true)
    expect([...front.paths.keys()]).toContain("/ws/events")
  })

  it("lists every route the server mounts, and nothing else", () => {
    expect(
      listed.filter((route) => !routes.includes(route)),
      `listed but no longer mounted (renamed or removed?): run ${RUN}`
    ).toEqual([])
    expect(
      routes.filter((route) => !listed.includes(route)),
      `mounted but not listed: run ${RUN}, then name who calls it`
    ).toEqual([])
  })

  it("marks as web exactly the routes the frontend calls", () => {
    const calls = web(built.contract.routes as Record<string, string>)
    const marked = web(contract.routes)
    expect(
      marked.filter((route) => !calls.includes(route)),
      `marked web, but the frontend no longer calls it: run ${RUN}`
    ).toEqual([])
    expect(
      calls.filter((route) => !marked.includes(route)),
      `the frontend calls it, not marked web: run ${RUN}`
    ).toEqual([])
  })

  it("has a route for every command and URL the frontend sends", () => {
    expect(built.problems).toEqual([])
  })

  it("lets through only the commands a proxy in front of the server answers", () => {
    // cowork_team 由 CoTeam 的 nginx 回答，server 上没有它也不算对不上。
    expect(Object.keys(FRONT_PROXY_COMMANDS)).toEqual(["cowork_team"])
    expect(frontendCalls().commands.has("cowork_team")).toBe(true)
    for (const caller of Object.values(FRONT_PROXY_COMMANDS))
      expect(caller).toBeTruthy()
  })

  it("names who calls each route the frontend does not", () => {
    expect(
      Object.entries(contract.routes)
        .filter(([, caller]) => !caller || caller === UNKNOWN_CALLER)
        .map(([route]) => route),
      `write the caller in ${CONTRACT_FILE}`
    ).toEqual([])
  })

  it("carries compat.rs's API_VERSION", () => {
    expect(contract.apiVersion, `run ${RUN}`).toBe(apiVersion())
  })

  it("is exactly what the script writes", () => {
    expect(readFileSync(join(ROOT, CONTRACT_FILE), "utf8")).toBe(
      formatContract(built.contract)
    )
  })
})

describe("error codes", () => {
  // The Rust half (`web/handlers/error.rs`) holds every AppErrorCode and its
  // HTTP status to the same list.
  it("types.ts AppErrorCode lists exactly the contract's codes", () => {
    const types = readFileSync(join(ROOT, "src/lib/types.ts"), "utf8")
    const union = /export type AppErrorCode =([\s\S]*?)\n\n/.exec(types)
    expect(union, "AppErrorCode in types.ts").not.toBeNull()
    const codes = [...union![1].matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1])
    expect(codes.sort()).toEqual(Object.keys(readContract().errorCodes).sort())
  })
})

// The extractor on a small tree of its own, so what it reads (and skips) is
// pinned apart from how the real sources happen to be written today.
describe("scripts/api-contract.mjs", () => {
  const root = mkdtempSync(join(tmpdir(), "api-contract-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }

  put(
    "src-tauri/src/web/router.rs",
    `use axum::routing::{get, post};
pub fn build_router(state: Arc<AppState>) -> Router {
    build_router_with_proxy_auth(state)
}
pub fn build_router_with_proxy_auth(state: Arc<AppState>) -> Router {
    let cors = if portal { CorsLayer::new() } else { CorsLayer::new().allow_origin(Any) };
    let banner = r#"a "raw // string" here"#;
    let api = Router::new()
        .route("/health", post(health))
        // .route("/commented_out", post(nothing))
        /* .route("/block_commented", post(nothing)) */
        .merge(crate::cowork::api_routes())
        .route(
            "/ticket/{id}",
            get(handlers::download).post(handlers::upload),
        )
        .fallback(api_not_found)
        .layer(middleware::from_fn(move |req, next| {
            let dotted = req.uri().path().contains('.');
            auth(req, next, dotted)
        }));
    let public_api = Router::new().route("/public", post(public));
    let api = public_api.merge(api).layer(trace);
    let ws = Router::new().route(super::socket::PATH, get(ws_handler));
    Router::new()
        .nest("/api", api)
        .merge(ws)
        .fallback_service(static_files)
        .layer(cors)
}
`
  )
  put(
    "src-tauri/src/cowork.rs",
    `pub fn api_routes() -> Router {
    Router::new()
        .route("/cowork_info", post(info))
        .route(crate::telemetry::ENVELOPE_PATH, post(forward))
}
const NOT_A_ROUTE: &str = r#".route("/raw", post(x))"#;
`
  )
  put(
    "src-tauri/src/telemetry/mod.rs",
    `pub const ENVELOPE_PATH: &str = "/envelope";\n`
  )
  put("src-tauri/src/web/socket.rs", `pub const PATH: &str = "/ws/socket";\n`)
  put(
    "src-tauri/src/lib.rs",
    `fn run() {
    builder.invoke_handler(tauri::generate_handler![
        commands::health,
        // commands::commented,
        #[cfg(target_os = "macos")]
        commands::only_in_the_app,
    ]);
}
`
  )
  put("src-tauri/src/compat.rs", `pub const API_VERSION: u32 = 7;\n`)
  put(
    "src/lib/api.ts",
    `import { listen } from "@tauri-apps/api/event"
import { getTransport } from "./transport"
const SOME_COMMAND = "cowork_info"
// getTransport().call("in_a_comment")
export const a = () => getTransport().call("health")
export const b = () =>
  getTransport().call<Record<string, number>>(
    "only_in_the_app",
    { x: 1 }
  )
export const c = () => getTransport().call(SOME_COMMAND)
async function fetchApi(endpoint: string) {
  return fetch(\`\${origin}/api/\${endpoint}\`)
}
export const d = () => fetchApi("missing_everywhere")
export const e = (port: number) => \`\${base}/api/ticket/\${port}?x=1\`
export const f = (name: string) => getTransport().call(name)
export const g = () => Object.prototype.hasOwnProperty.call(SOME, "x")
export const h = base + "/ws/socket"
export const i = "https://forge.example/api/v4/user"
export { listen }
`
  )
  put("src/lib/api.test.ts", `getTransport().call("only_in_a_test")\n`)

  it("strips Rust comments but not strings or chars", () => {
    const src = `let a = "// not a comment"; // gone\nlet c = '"'; /* gone */ let d = 1;`
    const out = stripRustComments(src)
    expect(out).toHaveLength(src.length)
    expect(out).toContain(`"// not a comment"`)
    expect(out).toContain(`'"'`)
    expect(out).not.toContain("gone")
    expect(out).toContain("let d = 1;")
  })

  it("follows merges, nests, constants and method chains", () => {
    expect(serverRoutes(root)).toEqual([
      "POST /api/cowork_info",
      "POST /api/envelope",
      "POST /api/health",
      "POST /api/public",
      "GET /api/ticket/{id}",
      "POST /api/ticket/{id}",
      "GET /ws/socket",
    ])
  })

  it("reads literals, constants and wrappers; skips comments and tests", () => {
    const front = frontendCalls(root)
    expect([...front.commands.keys()].sort()).toEqual([
      "cowork_info",
      "health",
      "missing_everywhere",
      "only_in_the_app",
    ])
    expect(front.commands.get("only_in_the_app")).toEqual(["src/lib/api.ts:7"])
    expect([...front.paths.keys()].sort()).toEqual([
      "/api/ticket/${port}",
      "/ws/socket",
    ])
    expect(front.dynamic).toEqual([
      "src/lib/api.ts:17 getTransport().call(name)",
    ])
  })

  it("builds the contract and says what does not fit", () => {
    const previous = {
      _readme: ["kept"],
      errorCodes: { not_found: 404 },
      routes: {
        "POST /api/public": "codeg-cli",
        "POST /api/health": WEB,
        "POST /api/gone": WEB,
      },
    }
    const { contract, problems } = buildContract(root, previous)
    expect(contract).toEqual({
      _readme: ["kept"],
      apiVersion: 7,
      errorCodes: { not_found: 404 },
      routes: {
        "POST /api/cowork_info": WEB,
        "POST /api/envelope": UNKNOWN_CALLER,
        "POST /api/health": WEB,
        "POST /api/public": "codeg-cli",
        "GET /api/ticket/{id}": WEB,
        "POST /api/ticket/{id}": WEB,
        "GET /ws/socket": WEB,
      },
    })
    // `only_in_the_app` is the app's own command: no route needed.
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain("missing_everywhere")
    expect(problems[1]).toContain("getTransport().call(name)")
    const notes = describeChange(previous, contract).join("\n")
    expect(notes).toContain("POST /api/gone")
    expect(notes).toContain("MIN_DESKTOP_VERSION")
    expect(notes).toContain("API_VERSION")
  })

  it("matches frontend URLs to route paths", () => {
    expect(pathMatches("/api/ticket/{id}", "/api/ticket/${t}")).toBe(true)
    expect(pathMatches("/api/ticket/{id}", "/api/ticket/")).toBe(true)
    expect(pathMatches("/api/ticket/{id}", "/api/ticket")).toBe(false)
    expect(pathMatches("/api/p/{port}/{*rest}", "/api/p/${port}/a/b")).toBe(
      true
    )
    expect(pathMatches("/api/health", "/api/healthz")).toBe(false)
  })
})
