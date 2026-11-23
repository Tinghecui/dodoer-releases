//! 壳的导航规则：网页视图每次要去一个地址之前，决定照常加载、回启动页、交给系统浏览器还是拦下。
//! 规则是纯函数 [`decide`]，状态（当前打开的是哪个服务器）由 [`Navigator`] 记着。

use std::sync::Mutex;

use tauri::Url;

/// 每个页面加载前注入的壳标记，网页界面据此按「iOS 壳里的网页版」运行
/// （和 `src/lib/transport/detect.ts` 读的标记一致）。
pub const SHELL_MARKER_SCRIPT: &str = r#"window.__CODEG_SHELL__ = "ios";"#;

/// 每个页面加载前注入的第二段脚本：把「在新窗口打开别的网站」改成在当前网页视图里导航过去，
/// 让它经过导航规则、交给系统浏览器。iOS 上 wry 不处理新窗口请求（`target="_blank"`、
/// `window.open`），不这样做，服务器网页里这类外部链接点了没有反应。脚本和测试在 `new_window.js`
/// 和 `new-window.test.ts`。
pub const NEW_WINDOW_SCRIPT: &str = include_str!("new_window.js");

/// 服务器网页里「切换服务器」要去的固定地址。从服务器的 https 页面不能直接跳本地协议，
/// 所以去这个地址，由壳拦下来、换成本地启动页。`.invalid` 是保留顶级域名，永远解析不到，
/// 万一没被拦住也不会真的发出请求。
pub const RETURN_TO_LAUNCHER_URL: &str = "https://coteam-shell.invalid/launcher";

/// 一次导航怎么处理。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Navigation {
    /// 去本地启动页：照常加载，并忘掉当前服务器。
    Launcher,
    /// 从启动页选了一个服务器：照常加载，记住它的来源。
    OpenServer,
    /// 当前服务器同源的地址，或者 about:/blob:/data: 这类页面内部的地址：照常加载。
    Load,
    /// 去「回启动页」地址：拦下，改成导航到本地启动页。
    ReturnToLauncher,
    /// 别的网站的 http/https 链接：拦下，交给系统浏览器。
    OpenExternal,
    /// 别的协议：拦下，什么也不做。
    Block,
}

impl Navigation {
    /// 这次导航要不要在壳的网页视图里照常进行。
    pub fn proceeds(&self) -> bool {
        matches!(self, Self::Launcher | Self::OpenServer | Self::Load)
    }
}

/// 本地启动页的地址：Tauri 在 iOS、macOS、Linux 上用 `tauri://localhost`，
/// 在 Windows、Android 上换成 `http://tauri.localhost`（见 tauri 的 `get_app_url`）。
pub fn launcher_url() -> Url {
    let origin = if cfg!(any(windows, target_os = "android")) {
        "http://tauri.localhost/"
    } else {
        "tauri://localhost/"
    };
    Url::parse(origin).expect("固定的启动页地址")
}

/// 两个地址是不是同源：协议、主机、端口都一样。不用 `Url::origin()`，
/// 因为 `tauri://` 这种自定义协议的来源是不透明的，两次解析永远不相等。
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// 导航规则。`launcher` 是本地启动页的地址，`current_server` 是现在打开着的服务器（在启动页上时是 `None`）。
pub fn decide(target: &Url, launcher: &Url, current_server: Option<&Url>) -> Navigation {
    if is_return_to_launcher(target) {
        return Navigation::ReturnToLauncher;
    }
    // 先认启动页：Windows、Android 上它也是 http 地址
    if same_origin(target, launcher) {
        return Navigation::Launcher;
    }
    match target.scheme() {
        "http" | "https" => match current_server {
            // 在启动页上去 http/https 地址，就是选了这个服务器
            None => Navigation::OpenServer,
            Some(server) if same_origin(target, server) => Navigation::Load,
            Some(_) => Navigation::OpenExternal,
        },
        "about" | "blob" | "data" => Navigation::Load,
        _ => Navigation::Block,
    }
}

fn is_return_to_launcher(target: &Url) -> bool {
    let Ok(fixed) = Url::parse(RETURN_TO_LAUNCHER_URL) else {
        return false;
    };
    same_origin(target, &fixed) && target.path().trim_end_matches('/') == fixed.path()
}

/// 记着当前打开的是哪个服务器，按 [`decide`] 的结果更新。
pub struct Navigator {
    launcher: Url,
    current_server: Mutex<Option<Url>>,
}

impl Navigator {
    pub fn new(launcher: Url) -> Self {
        Self {
            launcher,
            current_server: Mutex::new(None),
        }
    }

    pub fn launcher(&self) -> &Url {
        &self.launcher
    }

    /// 处理一次导航：算出怎么处理，顺带更新当前服务器。
    pub fn handle(&self, target: &Url) -> Navigation {
        let mut current = self
            .current_server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let decision = decide(target, &self.launcher, current.as_ref());
        match decision {
            Navigation::Launcher | Navigation::ReturnToLauncher => *current = None,
            Navigation::OpenServer => *current = Some(target.clone()),
            _ => {}
        }
        decision
    }

    /// 当前打开着的服务器（测试用）。
    pub fn current_server(&self) -> Option<Url> {
        self.current_server
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn launcher() -> Url {
        url("tauri://localhost/")
    }

    #[test]
    fn shell_marker_sets_ios() {
        assert_eq!(SHELL_MARKER_SCRIPT, r#"window.__CODEG_SHELL__ = "ios";"#);
    }

    #[test]
    fn same_origin_as_current_server_loads() {
        let server = url("https://team.example.com/");
        for target in [
            "https://team.example.com/",
            "https://team.example.com/login?next=%2Fworkspace",
            "https://team.example.com:443/workspace#c1",
        ] {
            assert_eq!(
                decide(&url(target), &launcher(), Some(&server)),
                Navigation::Load,
                "{target}"
            );
        }
        // 端口不同、协议不同都不算同源
        let local = url("http://devbox.local:3080/");
        assert_eq!(
            decide(&url("http://devbox.local:3080/ws"), &launcher(), Some(&local)),
            Navigation::Load
        );
        assert_eq!(
            decide(&url("http://devbox.local:8080/"), &launcher(), Some(&local)),
            Navigation::OpenExternal
        );
        assert_eq!(
            decide(&url("http://team.example.com/"), &launcher(), Some(&server)),
            Navigation::OpenExternal
        );
    }

    #[test]
    fn return_to_launcher_url_goes_back_to_launcher() {
        let server = url("https://team.example.com/");
        let target = url(RETURN_TO_LAUNCHER_URL);
        assert_eq!(
            decide(&target, &launcher(), Some(&server)),
            Navigation::ReturnToLauncher
        );
        // 带查询参数、末尾斜杠也认
        assert_eq!(
            decide(
                &url("https://coteam-shell.invalid/launcher/?from=menu"),
                &launcher(),
                Some(&server)
            ),
            Navigation::ReturnToLauncher
        );
        // 已经在启动页上也一样
        assert_eq!(
            decide(&target, &launcher(), None),
            Navigation::ReturnToLauncher
        );
    }

    #[test]
    fn other_sites_open_in_system_browser() {
        let server = url("https://team.example.com/");
        for target in [
            "https://docs.example.org/guide",
            "http://other.example.net/",
            "https://example.com/",
            "https://coteam-shell.invalid/other",
        ] {
            assert_eq!(
                decide(&url(target), &launcher(), Some(&server)),
                Navigation::OpenExternal,
                "{target}"
            );
        }
    }

    #[test]
    fn launcher_page_loads_and_picks_server() {
        assert_eq!(
            decide(&url("tauri://localhost/index.html"), &launcher(), None),
            Navigation::Launcher
        );
        // 在服务器上时回到启动页（例如返回手势）也照常加载
        let server = url("https://team.example.com/");
        assert_eq!(
            decide(&url("tauri://localhost/"), &launcher(), Some(&server)),
            Navigation::Launcher
        );
        // 在启动页上去任何 http/https 地址都是选了一个服务器
        assert_eq!(
            decide(&url("https://team.example.com/"), &launcher(), None),
            Navigation::OpenServer
        );
        assert_eq!(
            decide(&url("http://devbox.local:3080/"), &launcher(), None),
            Navigation::OpenServer
        );
        // Windows、Android 上启动页是 http://tauri.localhost，也要先认成启动页
        let http_launcher = url("http://tauri.localhost/");
        assert_eq!(
            decide(&url("http://tauri.localhost/index.html"), &http_launcher, None),
            Navigation::Launcher
        );
    }

    #[test]
    fn in_page_and_unknown_schemes() {
        let server = url("https://team.example.com/");
        assert_eq!(
            decide(&url("about:blank"), &launcher(), Some(&server)),
            Navigation::Load
        );
        assert_eq!(
            decide(&url("data:text/plain,hi"), &launcher(), Some(&server)),
            Navigation::Load
        );
        assert_eq!(
            decide(&url("ftp://files.example.com/"), &launcher(), Some(&server)),
            Navigation::Block
        );
        assert!(!Navigation::OpenExternal.proceeds());
        assert!(!Navigation::ReturnToLauncher.proceeds());
        assert!(Navigation::Load.proceeds());
    }

    #[test]
    fn navigator_remembers_and_forgets_server() {
        let nav = Navigator::new(launcher());
        assert_eq!(nav.handle(&url("tauri://localhost/")), Navigation::Launcher);
        assert_eq!(
            nav.handle(&url("https://team.example.com/")),
            Navigation::OpenServer
        );
        assert_eq!(
            nav.current_server(),
            Some(url("https://team.example.com/"))
        );
        assert_eq!(
            nav.handle(&url("https://team.example.com/workspace")),
            Navigation::Load
        );
        assert_eq!(
            nav.handle(&url("https://docs.example.org/")),
            Navigation::OpenExternal
        );
        assert_eq!(
            nav.handle(&url(RETURN_TO_LAUNCHER_URL)),
            Navigation::ReturnToLauncher
        );
        assert_eq!(nav.current_server(), None);
        // 回到启动页以后可以换另一个服务器
        assert_eq!(
            nav.handle(&url("https://second.example.net/")),
            Navigation::OpenServer
        );
    }

    #[test]
    fn launcher_url_matches_tauri_app_url() {
        let expected = if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert_eq!(launcher_url().as_str(), expected);
    }
}
