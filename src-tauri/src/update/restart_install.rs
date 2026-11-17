//! 桌面版更新在「重启以更新」时怎么装：哪个平台等重启才装、哪个平台的安装器
//! 自己结束 app、安装返回以后是重开还是报错。都是纯函数，给
//! `commands::app_update` 用；那个模块只在桌面版编译，测试放这里才能在
//! server 模式的 `cargo test` 里跑到。

/// 桌面版的三种平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPlatform {
    MacOs,
    Windows,
    Linux,
}

/// 编译目标的平台。用 `cfg!` 而不是 `#[cfg]`，三种平台的路在哪儿都编译。
pub const CURRENT_PLATFORM: DesktopPlatform = if cfg!(windows) {
    DesktopPlatform::Windows
} else if cfg!(target_os = "macos") {
    DesktopPlatform::MacOs
} else {
    DesktopPlatform::Linux
};

/// 下载完是否先不装、等用户点「重启以更新」时才装。
///
/// - Windows：装就是重启，插件启动安装器后立即结束 app；放在下载结束时装，
///   下载一完 app 就被关掉了。
/// - macOS：装是换掉整个应用包。下载一结束就换的话，旧版在跑、应用包已是
///   新版，这期间新起的 `codeg-server`（本机工作区的子进程，挂了会自动重启）
///   和 `codeg-mcp`（智能体的协作工具）都是从应用包里起的新版，连旧版的服务、
///   在旧版底下迁移数据库。所以也等重启。
/// - Linux：照旧下载完就装（我们不发 Linux 桌面包）。
pub const fn installs_at_restart(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::MacOs | DesktopPlatform::Windows)
}

/// 安装是否由安装器自己结束 app（成功时 `install` 不返回）。
/// 只有 Windows：插件启动安装器后 `std::process::exit`。macOS 上 `install`
/// 换好应用包就返回，重开由我们自己请求。
pub const fn installer_ends_app(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::Windows)
}

/// 重启时安装返回以后怎么办。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RestartInstallOutcome {
    /// 新版已经换上，请求退出、重开成新版。
    Relaunch,
    /// 没装上，带上要报给用户的错误信息。
    Failed(String),
}

/// 按安装的返回值和「安装器是否自己结束 app」决定重开还是报错。
pub fn restart_install_outcome(
    outcome: Result<(), String>,
    ends_app: bool,
) -> RestartInstallOutcome {
    match outcome {
        // 安装器本该结束 app 却返回了：它没接管。
        Ok(()) if ends_app => {
            RestartInstallOutcome::Failed("The installer did not take over".to_string())
        }
        Ok(()) => RestartInstallOutcome::Relaunch,
        Err(message) => RestartInstallOutcome::Failed(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_installs_at_restart_and_relaunches_itself() {
        assert!(installs_at_restart(DesktopPlatform::MacOs));
        assert!(!installer_ends_app(DesktopPlatform::MacOs));
    }

    #[test]
    fn windows_installs_at_restart_and_the_installer_ends_the_app() {
        assert!(installs_at_restart(DesktopPlatform::Windows));
        assert!(installer_ends_app(DesktopPlatform::Windows));
    }

    #[test]
    fn linux_installs_at_the_end_of_the_download() {
        assert!(!installs_at_restart(DesktopPlatform::Linux));
        assert!(!installer_ends_app(DesktopPlatform::Linux));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn current_platform_on_macos() {
        assert_eq!(CURRENT_PLATFORM, DesktopPlatform::MacOs);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn current_platform_on_linux() {
        assert_eq!(CURRENT_PLATFORM, DesktopPlatform::Linux);
    }

    #[test]
    fn installed_without_ending_the_app_relaunches() {
        assert_eq!(
            restart_install_outcome(Ok(()), false),
            RestartInstallOutcome::Relaunch
        );
    }

    #[test]
    fn installer_returning_when_it_should_end_the_app_is_a_failure() {
        assert_eq!(
            restart_install_outcome(Ok(()), true),
            RestartInstallOutcome::Failed("The installer did not take over".to_string())
        );
    }

    #[test]
    fn install_error_keeps_its_message_on_every_platform() {
        for ends_app in [false, true] {
            assert_eq!(
                restart_install_outcome(Err("disk full".to_string()), ends_app),
                RestartInstallOutcome::Failed("disk full".to_string())
            );
        }
    }
}
