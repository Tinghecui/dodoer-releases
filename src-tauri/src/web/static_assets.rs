//! Cowork 加的：网页文件目录。
//!
//! 启动时把目录定死到真实路径（软链解析掉），这样 Cowork 切了安装目录的软链以后，
//! 这个进程的网页仍然和它的程序是同一版。服务端代码没变的版本（两边的 `SERVER-REV`
//! 一样），Cowork 调 `cowork_reload_web` 把网页换过去，不用重启。换下来的旧目录给
//! `/_next/static/` 兜底（文件名带内容哈希，不会取错版本），没刷新的旧页面再去取它
//! 那一版的脚本不会 404。`/_next/` 下哪里都找不到的回 404，不回 `index.html`
//! （移植自 dodoer #778）。

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use axum::{
    body::Body,
    extract::Request,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tower_service::Service;

/// 网页文件换了以后发给所有实时连接的事件，payload `{"release": …}`。
pub const WEB_ASSETS_CHANGED_EVENT: &str = "web_assets_changed";

/// 兜底的旧目录最多留几个。
pub const MAX_PREVIOUS_DIRS: usize = 3;

/// 只有这个前缀下的文件到旧目录兜底。
const FINGERPRINTED_PREFIX: &str = "/_next/static/";

/// Next.js 的构建产物都在这下面，不是页面路由：找不到就回 404，不回 `index.html`。
/// 跨着升级没刷新的页面会来这里要上一版的脚本，回 HTML 浏览器会把页面当脚本解析，
/// 报一个看不懂的语法错；回 404 它报的是加载失败。
const BUILD_OUTPUT_PREFIX: &str = "/_next/";

/// 服务端代码指纹的文件名（发版时写进安装目录，和程序并排）。
const SERVER_REV_FILE: &str = "SERVER-REV";
/// Cowork 的发布号，安装目录里和 `web/` 并排。
const COWORK_VERSION_FILE: &str = "COWORK-VERSION";

#[derive(Debug)]
enum Resolver {
    /// 桌面版内嵌的服务：目录由 Tauri 给定，重新解析还是它。
    Fixed(PathBuf),
    /// `codeg-server`：按 `find_static_dir_standalone` 的规则，`CODEG_STATIC_DIR`
    /// 的原始值在启动时记下。
    Standalone(Option<String>),
}

#[derive(Debug)]
struct Dirs {
    current: PathBuf,
    /// 换下来的目录，新的在前。
    previous: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct StaticAssets {
    resolver: Resolver,
    own_rev: Option<String>,
    dirs: RwLock<Dirs>,
}

/// 读一个指纹 / 版本文件：去掉首尾空白；读不到、是空的都算没有。
fn read_trimmed(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// 解析成真实路径；失败时用原路径。
fn canonical_or(dir: PathBuf) -> Result<PathBuf, (PathBuf, std::io::Error)> {
    match std::fs::canonicalize(&dir) {
        Ok(real) => Ok(real),
        Err(err) => Err((dir, err)),
    }
}

fn pin(dir: PathBuf) -> PathBuf {
    match canonical_or(dir) {
        Ok(real) => {
            tracing::info!("[WEB] static files pinned to {}", real.display());
            real
        }
        Err((dir, err)) => {
            tracing::warn!(
                "[WEB] could not resolve static dir {}: {err}; serving it as given",
                dir.display()
            );
            dir
        }
    }
}

/// 程序旁边的 `SERVER-REV`。
pub fn read_own_server_rev() -> Option<String> {
    read_trimmed(&crate::update::runtime::self_exe().with_file_name(SERVER_REV_FILE))
}

impl StaticAssets {
    /// 桌面版内嵌的服务：目录不换。
    pub fn fixed(dir: PathBuf) -> Self {
        Self::new(Resolver::Fixed(dir), None)
    }

    /// `codeg-server` 启动时：按规则选目录、定死到真实路径，读程序旁边的指纹。
    pub fn pin_standalone(explicit: Option<String>) -> Self {
        Self::with_server_rev(explicit, read_own_server_rev())
    }

    /// 同 [`Self::pin_standalone`]，指纹由调用方给（测试用）。
    pub fn with_server_rev(explicit: Option<String>, own_rev: Option<String>) -> Self {
        Self::new(Resolver::Standalone(explicit), own_rev)
    }

    fn new(resolver: Resolver, own_rev: Option<String>) -> Self {
        let dir = match &resolver {
            Resolver::Fixed(dir) => dir.clone(),
            Resolver::Standalone(explicit) => {
                super::find_static_dir_standalone(explicit.as_deref())
            }
        };
        let current = pin(dir);
        Self {
            resolver,
            own_rev,
            dirs: RwLock::new(Dirs {
                current,
                previous: Vec::new(),
            }),
        }
    }

    /// 这个进程的服务端代码指纹。
    pub fn server_rev(&self) -> Option<&str> {
        self.own_rev.as_deref()
    }

    /// 现在用的目录。
    pub fn current(&self) -> PathBuf {
        self.read_dirs().current.clone()
    }

    /// 兜底的旧目录，新的在前。
    pub fn previous(&self) -> Vec<PathBuf> {
        self.read_dirs().previous.clone()
    }

    fn read_dirs(&self) -> std::sync::RwLockReadGuard<'_, Dirs> {
        self.dirs.read().unwrap_or_else(|e| e.into_inner())
    }

    /// 重新按启动时的规则解析出的目标目录（真实路径）。`CODEG_STATIC_DIR` 给了时
    /// 就是它本身，不往 `./web` 回退，这样它没有 `index.html` 能报出来。
    fn target_dir(&self) -> PathBuf {
        let dir = match &self.resolver {
            Resolver::Fixed(dir) => dir.clone(),
            Resolver::Standalone(Some(raw)) => PathBuf::from(raw),
            Resolver::Standalone(None) => super::find_static_dir_standalone(None),
        };
        canonical_or(dir).unwrap_or_else(|(dir, _)| dir)
    }

    /// `cowork_reload_web`：服务端代码指纹一样才把网页文件换成目标目录。回答的
    /// JSON 原样给调用方；`changed` 为真时已经换了。
    pub fn reload(&self) -> Value {
        let target = self.target_dir();
        let mut dirs = self.dirs.write().unwrap_or_else(|e| e.into_inner());
        if target == dirs.current {
            return json!({"changed": false, "reason": "same_dir"});
        }
        let install = target.parent().unwrap_or(&target);
        let target_rev = read_trimmed(&install.join(SERVER_REV_FILE));
        match (&self.own_rev, &target_rev) {
            (Some(own), Some(other)) if own == other => {}
            (own, other) => {
                let reason = if own.is_none() || other.is_none() {
                    "server_rev_missing"
                } else {
                    "server_rev_mismatch"
                };
                return json!({
                    "changed": false,
                    "reason": reason,
                    "own": own,
                    "target": other,
                });
            }
        }
        if !target.join("index.html").is_file() {
            return json!({"changed": false, "reason": "no_index"});
        }
        let release = read_trimmed(&install.join(COWORK_VERSION_FILE));
        let old = std::mem::replace(&mut dirs.current, target.clone());
        let mut previous = vec![old];
        previous.append(&mut dirs.previous);
        previous.retain(|dir| dir.is_dir() && *dir != target);
        previous.truncate(MAX_PREVIOUS_DIRS);
        dirs.previous = previous;
        drop(dirs);
        tracing::info!("[WEB] static files switched to {}", target.display());
        json!({"changed": true, "release": release})
    }
}

/// 同一个请求的副本（静态文件只看方法、地址和请求头，不读请求体）。
fn copy_request(parts: &axum::http::request::Parts) -> Request {
    let mut req = Request::new(Body::empty());
    *req.method_mut() = parts.method.clone();
    *req.uri_mut() = parts.uri.clone();
    *req.version_mut() = parts.version;
    *req.headers_mut() = parts.headers.clone();
    req
}

/// 取一个静态文件：先在现在的目录找；`/_next/static/` 下的找不到时依次到旧目录
/// 找。`/_next/` 下都没有的回 404；别的路径是前端路由，和原来一样回 `index.html`。
pub async fn serve(assets: &StaticAssets, req: Request) -> Response {
    let (current, previous) = {
        let dirs = assets.read_dirs();
        (dirs.current.clone(), dirs.previous.clone())
    };
    let path = req.uri().path();
    if !path.starts_with(BUILD_OUTPUT_PREFIX) {
        let index = current.join("index.html");
        let mut svc = ServeDir::new(&current).fallback(ServeFile::new(index));
        return match svc.call(req).await {
            Ok(resp) => resp.into_response(),
            Err(never) => match never {},
        };
    }
    let fallbacks: &[PathBuf] = if path.starts_with(FINGERPRINTED_PREFIX) {
        &previous
    } else {
        &[]
    };
    let (parts, _body) = req.into_parts();
    for dir in std::iter::once(&current).chain(fallbacks.iter()) {
        let mut svc = ServeDir::new(dir);
        let resp = match svc.call(copy_request(&parts)).await {
            Ok(resp) => resp,
            Err(never) => match never {},
        };
        if resp.status() != StatusCode::NOT_FOUND {
            return resp.into_response();
        }
    }
    StatusCode::NOT_FOUND.into_response()
}

// 测试用 Unix 的软链。
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;

    use axum_test::TestServer;

    use crate::app_state::AppState;
    use crate::web::shutdown::ShutdownSignal;

    /// 一个「安装目录」：`web/index.html`、`web/_next/static/<name>.js`、
    /// `web/other-<name>.txt`、`SERVER-REV`、`COWORK-VERSION`。
    fn install(root: &Path, name: &str, rev: Option<&str>, index: bool) -> PathBuf {
        let dir = root.join(name);
        let web = dir.join("web");
        std::fs::create_dir_all(web.join("_next/static")).unwrap();
        if index {
            std::fs::write(web.join("index.html"), format!("index {name}")).unwrap();
        }
        std::fs::write(
            web.join(format!("_next/static/{name}.js")),
            format!("js {name}"),
        )
        .unwrap();
        std::fs::write(web.join(format!("other-{name}.txt")), format!("txt {name}")).unwrap();
        std::fs::write(
            web.join(format!("page-{name}.html")),
            format!("page {name}"),
        )
        .unwrap();
        if let Some(rev) = rev {
            std::fs::write(dir.join(SERVER_REV_FILE), format!("{rev}\n")).unwrap();
        }
        std::fs::write(dir.join(COWORK_VERSION_FILE), format!("release-{name}\n")).unwrap();
        dir
    }

    /// 让 `link` 指向 `target`（已有就换掉）。
    fn point(link: &Path, target: &Path) {
        let _ = std::fs::remove_file(link);
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// 软链 `current` → `a`，`CODEG_STATIC_DIR` 是 `current/web`。
    fn setup(own_rev: Option<&str>) -> (tempfile::TempDir, PathBuf, Arc<StaticAssets>) {
        let root = tempfile::tempdir().unwrap();
        let a = install(root.path(), "a", Some("rev-1"), true);
        let link = root.path().join("current");
        point(&link, &a);
        let raw = link.join("web").to_string_lossy().into_owned();
        let assets = Arc::new(StaticAssets::with_server_rev(
            Some(raw),
            own_rev.map(str::to_string),
        ));
        (root, link, assets)
    }

    async fn test_server(assets: Arc<StaticAssets>) -> (TestServer, tempfile::TempDir) {
        let data_dir = tempfile::tempdir().unwrap();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
        let router = crate::web::router::build_router_with_proxy_auth(
            state,
            "static-assets-token".to_string(),
            None,
            assets,
            Arc::new(ShutdownSignal::new()),
        );
        (TestServer::new(router).unwrap(), data_dir)
    }

    #[tokio::test]
    async fn pinned_at_startup_to_the_real_path() {
        let (root, link, assets) = setup(Some("rev-1"));
        let real_a = std::fs::canonicalize(root.path().join("a/web")).unwrap();
        assert_eq!(assets.current(), real_a);

        let b = install(root.path(), "b", Some("rev-1"), true);
        point(&link, &b);
        let (server, _data) = test_server(Arc::clone(&assets)).await;
        assert_eq!(server.get("/").await.text(), "index a");
        assert_eq!(server.get("/_next/static/a.js").await.text(), "js a");
    }

    #[tokio::test]
    async fn same_rev_switches_and_old_scripts_still_load() {
        let (root, link, assets) = setup(Some("rev-1"));
        let b = install(root.path(), "b", Some("rev-1"), true);
        point(&link, &b);

        let outcome = assets.reload();
        assert_eq!(outcome, json!({"changed": true, "release": "release-b"}));
        let real_b = std::fs::canonicalize(b.join("web")).unwrap();
        assert_eq!(assets.current(), real_b);

        let (server, _data) = test_server(Arc::clone(&assets)).await;
        assert_eq!(server.get("/").await.text(), "index b");
        let old_js = server.get("/_next/static/a.js").await;
        assert_eq!(old_js.status_code(), StatusCode::OK);
        assert_eq!(old_js.text(), "js a");
        assert_eq!(server.get("/_next/static/b.js").await.text(), "js b");
        // 别的路径不从旧目录取：和不存在的路径一样回到 index.html。
        assert_eq!(server.get("/other-a.txt").await.text(), "index b");
        assert_eq!(server.get("/other-b.txt").await.text(), "txt b");
        // `/page-b` → `page-b.html` 也看新目录。
        assert_eq!(server.get("/page-b").await.text(), "page b");
        assert_eq!(server.get("/page-a").await.text(), "index b");
    }

    /// dodoer #778：`/_next/` 下找不到的回 404（不缓存），别的找不到的照旧回
    /// `index.html`；换过目录以后旧目录里也没有的同样 404。
    #[tokio::test]
    async fn missing_build_files_are_404_and_other_paths_get_the_index() {
        let (root, link, assets) = setup(Some("rev-1"));
        let (server, _data) = test_server(Arc::clone(&assets)).await;
        let found = server.get("/_next/static/a.js").await;
        assert_eq!(found.status_code(), StatusCode::OK);
        assert_eq!(found.text(), "js a");

        for path in [
            "/_next/static/chunks/missing.js",
            "/_next/data/missing.json",
            "/_next/missing",
        ] {
            let missing = server.get(path).await;
            assert_eq!(missing.status_code(), StatusCode::NOT_FOUND, "{path}");
            assert!(!missing.text().contains("index"), "{path}");
            assert_eq!(
                missing.header("cache-control").to_str().unwrap(),
                "no-cache",
                "{path}"
            );
        }
        let page = server.get("/missing-page").await;
        assert_eq!(page.status_code(), StatusCode::OK);
        assert_eq!(page.text(), "index a");
        assert_eq!(server.get("/").await.text(), "index a");

        let b = install(root.path(), "b", Some("rev-1"), true);
        point(&link, &b);
        assert_eq!(assets.reload()["changed"], json!(true));
        assert_eq!(server.get("/_next/static/a.js").await.text(), "js a");
        let missing = server.get("/_next/static/missing.js").await;
        assert_eq!(missing.status_code(), StatusCode::NOT_FOUND);
        assert_eq!(server.get("/missing-page").await.text(), "index b");
    }

    #[tokio::test]
    async fn the_route_answers_with_the_outcome() {
        let (root, link, assets) = setup(Some("rev-1"));
        let (server, _data) = test_server(Arc::clone(&assets)).await;
        let same: Value = server
            .post("/api/cowork_reload_web")
            .authorization_bearer("static-assets-token")
            .await
            .json();
        assert_eq!(same, json!({"changed": false, "reason": "same_dir"}));

        let b = install(root.path(), "b", Some("rev-1"), true);
        point(&link, &b);
        let switched: Value = server
            .post("/api/cowork_reload_web")
            .authorization_bearer("static-assets-token")
            .await
            .json();
        assert_eq!(switched, json!({"changed": true, "release": "release-b"}));
        assert_eq!(server.get("/").await.text(), "index b");
    }

    #[tokio::test]
    async fn refuses_and_says_why() {
        // 指纹不一样。
        let (root, link, assets) = setup(Some("rev-1"));
        let b = install(root.path(), "b", Some("rev-2"), true);
        point(&link, &b);
        assert_eq!(
            assets.reload(),
            json!({"changed": false, "reason": "server_rev_mismatch", "own": "rev-1", "target": "rev-2"})
        );
        // 目标没有指纹。
        let c = install(root.path(), "c", None, true);
        point(&link, &c);
        assert_eq!(
            assets.reload(),
            json!({"changed": false, "reason": "server_rev_missing", "own": "rev-1", "target": null})
        );
        // 目标没有 index.html。
        let d = install(root.path(), "d", Some("rev-1"), false);
        point(&link, &d);
        assert_eq!(
            assets.reload(),
            json!({"changed": false, "reason": "no_index"})
        );
        // 目标和现在一样。
        point(&link, &root.path().join("a"));
        assert_eq!(
            assets.reload(),
            json!({"changed": false, "reason": "same_dir"})
        );
        assert_eq!(
            assets.current(),
            std::fs::canonicalize(root.path().join("a/web")).unwrap()
        );

        // 自己没有指纹。
        let (root, link, assets) = setup(None);
        let b = install(root.path(), "b", Some("rev-1"), true);
        point(&link, &b);
        assert_eq!(
            assets.reload(),
            json!({"changed": false, "reason": "server_rev_missing", "own": null, "target": "rev-1"})
        );
        assert!(assets.previous().is_empty());
    }

    #[tokio::test]
    async fn keeps_at_most_three_old_dirs() {
        let (root, link, assets) = setup(Some("rev-1"));
        for name in ["b", "c", "d", "e"] {
            let dir = install(root.path(), name, Some("rev-1"), true);
            point(&link, &dir);
            assert_eq!(assets.reload()["changed"], json!(true));
        }
        let real = |name: &str| std::fs::canonicalize(root.path().join(name).join("web")).unwrap();
        assert_eq!(assets.current(), real("e"));
        assert_eq!(assets.previous(), vec![real("d"), real("c"), real("b")]);
    }

    #[tokio::test]
    async fn health_reports_the_server_rev() {
        let (_root, _link, assets) = setup(Some("rev-1"));
        let (server, _data) = test_server(assets).await;
        let body: Value = server
            .post("/api/health")
            .authorization_bearer("static-assets-token")
            .await
            .json();
        assert_eq!(body["server_rev"], json!("rev-1"));

        let (_root, _link, assets) = setup(None);
        let (server, _data) = test_server(assets).await;
        let body: Value = server
            .post("/api/health")
            .authorization_bearer("static-assets-token")
            .await
            .json();
        assert!(body.get("server_rev").is_none());
    }
}
