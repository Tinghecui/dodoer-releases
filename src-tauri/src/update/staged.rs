//! Cowork fork: macOS 桌面版下好的更新包存到磁盘（issue #412 第 3 行）。
//!
//! 下载并验签通过以后，除了留在内存里（`commands::app_update` 的
//! `STAGED_INSTALL`），再存一份到 `<数据目录>/update/staged/<版本>/`：
//! `package.bin` 是包本身，`manifest.json` 是插件的 `Update.raw_json` 原样。
//! 下次启动、下次 `perform_app_update` 开始时，用插件的
//! `Updater::restore_update` 还原出 `Update`、`Update::verify` 验签，都过了
//! 就直接用，不重新下载。
//!
//! 「存着的包能不能用、要不要删」是不碰文件系统的 [`verdict`]，单元测试
//! 覆盖；读写文件的是 [`save`]、[`read`]、[`clear`]。接线在
//! `commands::app_update`（只在桌面编译）。

use std::io;
use std::path::{Path, PathBuf};

use super::restart_install::DesktopPlatform;

/// `<数据目录>/update/` 下放存着的包的目录。
pub const DIR_NAME: &str = "staged";
/// 包本身。
pub const PACKAGE_FILE: &str = "package.bin";
/// 插件的 `Update.raw_json`。
pub const MANIFEST_FILE: &str = "manifest.json";

/// 哪个平台把下好的包存到磁盘：只有 macOS。Windows 的安装器流程不变，
/// Linux 下载完就装了，都不存。
pub const fn stores_package(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::MacOs)
}

/// 这一次下载的包要不要存盘：存盘的平台上，回退下的不存。回退下的包是给
/// 更旧的版本用的，回退以后跑的那一版可能还没有清理存包的代码（比如回到
/// 这个功能之前发的版本），存了就一直留在磁盘上。
pub const fn stores_download(platform: DesktopPlatform, rollback: bool) -> bool {
    stores_package(platform) && !rollback
}

/// `<数据目录>/update/staged`。
pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join(super::journal::DIR_NAME).join(DIR_NAME)
}

/// 版本号能不能当目录名：得是一个 semver（不会带 `/`、`..`）。
fn valid_version(version: &str) -> bool {
    semver::Version::parse(version).is_ok()
}

/// 磁盘上存着的那一份。读不出来的那一半是 `None`。
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    /// 目录名。
    pub version: String,
    pub manifest: Option<serde_json::Value>,
    pub package: Option<Vec<u8>>,
}

/// 插件的 `restore_update` 给了什么。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restored<'a> {
    /// 比正在运行的版本新，还原出来的是这一版。
    Newer(&'a str),
    /// 回了 `None`：已经不比正在运行的新了。
    NotNewer,
    /// 报错了（manifest 不是插件认的格式、没有这个平台的包……），或者
    /// manifest 根本没读出来、没法还原。
    Failed,
}

/// 判断要用到的几样。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Check<'a> {
    /// 存着的版本（目录名）。
    pub stored: &'a str,
    /// 正在运行的版本。
    pub running: &'a str,
    /// `manifest.json` 读出来了、是 JSON。
    pub manifest_read: bool,
    /// `package.bin` 读出来了。
    pub package_read: bool,
    pub restored: Restored<'a>,
    /// `Update::verify` 过了。没走到验签的填 false。
    pub verified: bool,
}

/// 存着的包怎么办。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 直接用，不联网、不下载。
    Use,
    /// 删掉，照原来的流程走。带上原因，进日志。
    Discard(&'static str),
}

/// 存着的包能不能用。
pub fn verdict(check: Check<'_>) -> Verdict {
    if !valid_version(check.stored) {
        return Verdict::Discard("bad_name");
    }
    if !check.manifest_read || !check.package_read {
        return Verdict::Discard("missing");
    }
    // 版本比较以插件为准（和 `check()` 同一套规则）；目录名看着已经不新的，
    // 也不用插件还原出来的。
    let newer = match (
        semver::Version::parse(check.stored),
        semver::Version::parse(check.running),
    ) {
        (Ok(stored), Ok(running)) => stored > running,
        _ => true,
    };
    match check.restored {
        Restored::NotNewer => return Verdict::Discard("not_newer"),
        Restored::Failed => return Verdict::Discard("unrestorable"),
        Restored::Newer(_) if !newer => return Verdict::Discard("not_newer"),
        Restored::Newer(version) if version != check.stored => return Verdict::Discard("mismatch"),
        Restored::Newer(_) => {}
    }
    if !check.verified {
        return Verdict::Discard("signature");
    }
    Verdict::Use
}

/// 哪个平台在启动时把存着的包换上：只有 macOS（Windows、Linux 不做）。
pub const fn applies_at_launch(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::MacOs)
}

/// 「要不要在启动时换上」要看的几样（issue #412 完成标准 18）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LaunchCheck<'a> {
    pub platform: DesktopPlatform,
    /// 自动更新不是「关闭」。
    pub mode_allows: bool,
    /// 磁盘上存着、`restore_update` 和 `verify` 都过了的那一版；没有是 `None`。
    pub stored: Option<&'a str>,
    /// 日志里的 `launch_apply_tried`：哪一版已经在启动时试过了。
    pub tried: Option<&'a str>,
    /// 应用包和它所在的目录当前用户都可写。
    pub bundle_writable: bool,
    /// 拿到了运行锁，不是第二个实例。
    pub sole_instance: bool,
    /// 这次启动时，上一次换上刚结束（没换上、启动几次都没确认）、结果还
    /// 等着上报：这时换上就直接退出了，那条记录发不出去，这次先不换。
    pub earlier_outcome: bool,
}

/// 启动时换不换。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchApply {
    Apply,
    /// 不换，带上原因，进日志。
    Skip(&'static str),
}

/// 要不要在启动时把存着的包换上：条件全满足才换。
pub fn launch_apply(check: LaunchCheck<'_>) -> LaunchApply {
    if !applies_at_launch(check.platform) {
        return LaunchApply::Skip("platform");
    }
    if !check.mode_allows {
        return LaunchApply::Skip("mode_off");
    }
    let Some(stored) = check.stored else {
        return LaunchApply::Skip("no_package");
    };
    if check.tried == Some(stored) {
        return LaunchApply::Skip("tried");
    }
    if !check.bundle_writable {
        // 不可写时插件要在主线程弹管理员密码框，事件循环还没开始，会卡死。
        return LaunchApply::Skip("not_writable");
    }
    if !check.sole_instance {
        return LaunchApply::Skip("not_sole_instance");
    }
    if check.earlier_outcome {
        return LaunchApply::Skip("earlier_outcome");
    }
    LaunchApply::Apply
}

/// 当前用户能不能写 `path`（`access(W_OK)`）。不存在的是不可写。
#[cfg(unix)]
pub fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: 以 NUL 结尾的路径，`access` 只读它。
    unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
}

#[cfg(not(unix))]
pub fn writable(_path: &Path) -> bool {
    false
}

/// 应用包和它所在的目录都可写：插件不用弹管理员密码框就能换。
pub fn bundle_writable(bundle: &Path) -> bool {
    writable(bundle) && bundle.parent().is_some_and(writable)
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    // 已经有的目录（上次建的、umask 放宽了的）也收紧。
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// 先写临时文件（0600）再改名，读的人不会看到写了一半的。
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    let tmp = path.with_file_name(name);
    let _ = std::fs::remove_file(&tmp);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let written = options.open(&tmp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    if let Err(e) = written.and_then(|()| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// 删掉 `root` 下不是 `keep` 的目录（和别的东西）。
pub fn prune_except(root: &Path, keep: Option<&str>) -> io::Result<()> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        if keep.is_some_and(|keep| entry.file_name() == keep) {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// 把 `version` 的包存进 `root`：`<root>/<version>/package.bin` 和
/// `manifest.json`，目录 0700、文件 0600。别的版本的目录先删掉。
pub fn save(
    root: &Path,
    version: &str,
    manifest: &serde_json::Value,
    package: &[u8],
) -> io::Result<()> {
    if !valid_version(version) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a version: {version}"),
        ));
    }
    prune_except(root, Some(version))?;
    let dir = root.join(version);
    create_private_dir(root)?;
    create_private_dir(&dir)?;
    let manifest = serde_json::to_vec(manifest).map_err(io::Error::other)?;
    // 包先、manifest 后：只有 manifest 没有包的那种半截，读的时候当缺了。
    write_private(&dir.join(PACKAGE_FILE), package)?;
    write_private(&dir.join(MANIFEST_FILE), &manifest)
}

/// 读存着的那一份：`root` 下第一个名字是版本号的目录。没有就是 `None`。
pub fn read(root: &Path) -> Option<Stored> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_type().ok()?.is_dir().then_some(())?;
            entry.file_name().into_string().ok()
        })
        .collect();
    names.sort();
    // 正常只有一个；名字不是版本号的也交给 `verdict` 删。
    let version = names.into_iter().next()?;
    let dir = root.join(&version);
    let manifest = std::fs::read(dir.join(MANIFEST_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    let package = std::fs::read(dir.join(PACKAGE_FILE)).ok();
    Some(Stored {
        version,
        manifest,
        package,
    })
}

/// 删掉存着的所有东西。
pub fn clear(root: &Path) -> io::Result<()> {
    match std::fs::remove_dir_all(root) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 存着 1.6.41，正在跑 1.6.40，一切正常。
    fn good() -> Check<'static> {
        Check {
            stored: "1.6.41",
            running: "1.6.40",
            manifest_read: true,
            package_read: true,
            restored: Restored::Newer("1.6.41"),
            verified: true,
        }
    }

    #[test]
    fn only_macos_stores_the_package() {
        assert!(stores_package(DesktopPlatform::MacOs));
        assert!(!stores_package(DesktopPlatform::Windows));
        assert!(!stores_package(DesktopPlatform::Linux));
    }

    #[test]
    fn a_rollback_download_is_not_stored() {
        assert!(stores_download(DesktopPlatform::MacOs, false));
        assert!(!stores_download(DesktopPlatform::MacOs, true));
        assert!(!stores_download(DesktopPlatform::Windows, false));
        assert!(!stores_download(DesktopPlatform::Linux, false));
    }

    #[test]
    fn a_newer_verified_package_is_used() {
        assert_eq!(verdict(good()), Verdict::Use);
    }

    #[test]
    fn a_missing_manifest_or_package_is_discarded() {
        let check = Check {
            manifest_read: false,
            restored: Restored::Failed,
            verified: false,
            ..good()
        };
        assert!(matches!(verdict(check), Verdict::Discard(_)));
        let check = Check {
            package_read: false,
            verified: false,
            ..good()
        };
        assert!(matches!(verdict(check), Verdict::Discard(_)));
    }

    #[test]
    fn a_package_no_newer_than_the_running_version_is_discarded() {
        // 已经换上了：存着的就是正在运行的版本。
        let check = Check {
            running: "1.6.41",
            restored: Restored::NotNewer,
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("not_newer"));
        // 比正在运行的还旧（比如中间手动装了更新的版本）。
        let check = Check {
            running: "1.6.42",
            restored: Restored::NotNewer,
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("not_newer"));
        // 插件说不新，就算目录名看着新也不用。
        let check = Check {
            restored: Restored::NotNewer,
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("not_newer"));
    }

    #[test]
    fn a_manifest_the_plugin_cannot_restore_is_discarded() {
        let check = Check {
            restored: Restored::Failed,
            verified: false,
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("unrestorable"));
    }

    #[test]
    fn a_manifest_for_another_version_than_its_directory_is_discarded() {
        let check = Check {
            restored: Restored::Newer("1.6.42"),
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("mismatch"));
    }

    #[test]
    fn a_package_that_fails_the_signature_is_discarded() {
        let check = Check {
            verified: false,
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("signature"));
    }

    #[test]
    fn a_directory_name_that_is_not_a_version_is_discarded() {
        let check = Check {
            stored: "../x",
            ..good()
        };
        assert_eq!(verdict(check), Verdict::Discard("bad_name"));
    }

    #[test]
    fn a_saved_package_reads_back_and_other_versions_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        let root = root(dir.path());
        assert!(root.ends_with("update/staged"));
        assert_eq!(read(&root), None);

        let manifest = serde_json::json!({"version": "1.6.41", "platforms": {}});
        save(&root, "1.6.40", &manifest, b"old").unwrap();
        save(&root, "1.6.41", &manifest, b"package bytes").unwrap();
        // 不是这个版本的目录（还有零碎文件）都删掉。
        std::fs::write(root.join("stray"), b"x").unwrap();
        save(&root, "1.6.41", &manifest, b"package bytes").unwrap();
        let names: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, vec!["1.6.41".to_string()]);
        // 临时文件改过名了，不留。
        let files: Vec<_> = std::fs::read_dir(root.join("1.6.41"))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(files.len(), 2, "{files:?}");

        assert_eq!(
            read(&root),
            Some(Stored {
                version: "1.6.41".into(),
                manifest: Some(manifest),
                package: Some(b"package bytes".to_vec()),
            })
        );
    }

    #[test]
    fn a_half_stored_package_reads_back_with_the_missing_half_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let root = root(dir.path());
        let manifest = serde_json::json!({"version": "1.6.41"});
        save(&root, "1.6.41", &manifest, b"bytes").unwrap();
        std::fs::remove_file(root.join("1.6.41").join(PACKAGE_FILE)).unwrap();
        std::fs::write(root.join("1.6.41").join(MANIFEST_FILE), b"{broken").unwrap();
        assert_eq!(
            read(&root),
            Some(Stored {
                version: "1.6.41".into(),
                manifest: None,
                package: None,
            })
        );
    }

    #[test]
    fn clear_removes_everything_and_tolerates_nothing_there() {
        let dir = tempfile::tempdir().unwrap();
        let root = root(dir.path());
        clear(&root).unwrap();
        save(&root, "1.6.41", &serde_json::json!({}), b"bytes").unwrap();
        clear(&root).unwrap();
        assert!(!root.exists());
        assert_eq!(read(&root), None);
    }

    /// 启动时换上的条件全满足：macOS、模式允许、存着 1.6.41、没试过、可写、
    /// 唯一的实例、没有等着上报的结果。
    fn launch_ok() -> LaunchCheck<'static> {
        LaunchCheck {
            platform: DesktopPlatform::MacOs,
            mode_allows: true,
            stored: Some("1.6.41"),
            tried: None,
            bundle_writable: true,
            sole_instance: true,
            earlier_outcome: false,
        }
    }

    #[test]
    fn only_macos_applies_at_launch() {
        assert!(applies_at_launch(DesktopPlatform::MacOs));
        assert!(!applies_at_launch(DesktopPlatform::Windows));
        assert!(!applies_at_launch(DesktopPlatform::Linux));
    }

    #[test]
    fn a_launch_with_every_condition_met_applies() {
        assert_eq!(launch_apply(launch_ok()), LaunchApply::Apply);
        // 试过的是别的版本（上一个存着的包），这一版照样换。
        let check = LaunchCheck {
            tried: Some("1.6.40"),
            ..launch_ok()
        };
        assert_eq!(launch_apply(check), LaunchApply::Apply);
    }

    #[test]
    fn a_launch_missing_any_condition_does_not_apply() {
        let cases = [
            LaunchCheck {
                platform: DesktopPlatform::Windows,
                ..launch_ok()
            },
            LaunchCheck {
                platform: DesktopPlatform::Linux,
                ..launch_ok()
            },
            LaunchCheck {
                mode_allows: false,
                ..launch_ok()
            },
            LaunchCheck {
                stored: None,
                ..launch_ok()
            },
            LaunchCheck {
                tried: Some("1.6.41"),
                ..launch_ok()
            },
            LaunchCheck {
                bundle_writable: false,
                ..launch_ok()
            },
            LaunchCheck {
                sole_instance: false,
                ..launch_ok()
            },
            LaunchCheck {
                earlier_outcome: true,
                ..launch_ok()
            },
        ];
        for check in cases {
            assert!(
                matches!(launch_apply(check), LaunchApply::Skip(_)),
                "{check:?}"
            );
        }
        // 原因各不相同，日志里看得出是哪一条挡住的。
        let tried = LaunchCheck {
            tried: Some("1.6.41"),
            ..launch_ok()
        };
        assert_eq!(launch_apply(tried), LaunchApply::Skip("tried"));
        let locked = LaunchCheck {
            bundle_writable: false,
            ..launch_ok()
        };
        assert_eq!(launch_apply(locked), LaunchApply::Skip("not_writable"));
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_is_writable_only_when_it_and_its_folder_are() {
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("Some App.app");
        // 还没有：不可写。
        assert!(!bundle_writable(&bundle));
        std::fs::create_dir(&bundle).unwrap();
        assert!(writable(dir.path()));
        assert!(bundle_writable(&bundle));
        // root 不看权限位，只在普通用户下查只读的情形。
        if unsafe { libc::geteuid() } != 0 {
            use std::os::unix::fs::PermissionsExt;
            let set = |p: &Path, mode| {
                std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).unwrap()
            };
            // 所在目录只读（比如 /Applications 归 root）。
            set(dir.path(), 0o555);
            assert!(!bundle_writable(&bundle));
            set(dir.path(), 0o755);
            // 包自己只读。
            set(&bundle, 0o555);
            assert!(!bundle_writable(&bundle));
            set(&bundle, 0o755);
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_stored_package_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let root = root(dir.path());
        save(&root, "1.6.41", &serde_json::json!({}), b"bytes").unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&root), 0o700);
        assert_eq!(mode(&root.join("1.6.41")), 0o700);
        assert_eq!(mode(&root.join("1.6.41").join(PACKAGE_FILE)), 0o600);
        assert_eq!(mode(&root.join("1.6.41").join(MANIFEST_FILE)), 0o600);
    }
}
