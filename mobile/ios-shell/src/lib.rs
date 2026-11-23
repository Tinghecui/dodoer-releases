//! coteam 的 iOS 壳。壳几乎不放界面：启动页是 `launcher/` 里的静态页面，
//! 选好服务器以后同一个网页视图直接打开服务器自己的网页界面。
//!
//! 第一版不给任何页面开放 Tauri 命令：不注册自定义命令，也没有任何权限文件（capabilities），
//! 远程页面和启动页都调不了原生能力（见 `config_check`）。

pub mod navigation;

#[cfg(test)]
mod config_check;

use navigation::{Navigation, Navigator, NEW_WINDOW_SCRIPT, SHELL_MARKER_SCRIPT};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

const MAIN_WINDOW: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 只用它的 Rust 接口把别的网站交给系统浏览器；不让它往页面里注入点链接的脚本
        // （页面也没有权限调它的命令）。
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let navigator = Navigator::new(navigation::launcher_url());
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
                .initialization_script(SHELL_MARKER_SCRIPT)
                // iOS 上新窗口请求没人处理：把打开别的网站的新窗口改成普通导航，走下面的导航规则
                .initialization_script(NEW_WINDOW_SCRIPT)
                .on_navigation(move |url| apply(&handle, &navigator, url))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("coteam 启动失败");
}

/// 按导航规则处理一次导航，返回要不要照常进行。
fn apply<R: Runtime>(app: &AppHandle<R>, navigator: &Navigator, url: &Url) -> bool {
    let decision = navigator.handle(url);
    match decision {
        Navigation::ReturnToLauncher => {
            // 导航回调里不直接再导航：排到主线程的下一轮，等这次被拦下以后再去启动页。
            let target = navigator.launcher().clone();
            let app_for_task = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(window) = app_for_task.get_webview_window(MAIN_WINDOW) {
                    let _ = window.navigate(target);
                }
            });
        }
        Navigation::OpenExternal => {
            let _ = app.opener().open_url(url.as_str(), None::<&str>);
        }
        _ => {}
    }
    decision.proceeds()
}
