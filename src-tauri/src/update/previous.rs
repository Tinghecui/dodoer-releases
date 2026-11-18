//! Cowork fork: macOS 桌面版换上新版本之前留一份旧的应用包，新版本连着起不来
//! 时自动换回去（issue #413 第 3 行）。
//!
//! 更新插件换上成功以后会把旧包删掉，新版本起不来时也没法联网去下旧版，
//! 所以换上之前（点「重启以更新」、空闲时自动重启、启动时换上；回退到上一版
//! 不算）先把正在运行的应用包复制到 `<数据目录>/update/previous/<版本>.app`
//! （`/bin/cp -Rc`，APFS 上是克隆，不占空间）。新版本连着
//! [`super::journal::ROLL_BACK_AFTER_BOOTS`] 次启动都没确认，下一次启动时
//! 把它换回应用包的位置，没起来的那一版挪到 `<数据目录>/update/failed/`。
//!
//! 「要不要退回」是不碰文件系统的 [`auto_rollback`]，单元测试覆盖；复制、
//! 换回的是 [`keep_previous`]、[`swap_back`]。接线在 `commands::app_update`
//! （只在桌面编译）。

use std::io;
use std::path::{Path, PathBuf};

use super::restart_install::DesktopPlatform;

/// `<数据目录>/update/` 下放旧应用包的目录。
pub const DIR_NAME: &str = "previous";
/// `<数据目录>/update/` 下放没起来的那一版的目录。
pub const FAILED_DIR_NAME: &str = "failed";
/// 复制应用包用的 `cp`。
pub const CP: &str = "/bin/cp";

/// 哪个平台留旧包、自动退回：只有 macOS（Windows、Linux 不做）。
pub const fn keeps_previous(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::MacOs)
}

/// `<数据目录>/update/previous`。
pub fn root(data_dir: &Path) -> PathBuf {
    data_dir.join(super::journal::DIR_NAME).join(DIR_NAME)
}

/// `<数据目录>/update/failed`。
pub fn failed_root(data_dir: &Path) -> PathBuf {
    data_dir
        .join(super::journal::DIR_NAME)
        .join(FAILED_DIR_NAME)
}

/// `<版本>.app`；版本号得是一个 semver（不会带 `/`、`..`）。
pub fn bundle_name(version: &str) -> Option<String> {
    semver::Version::parse(version)
        .is_ok()
        .then(|| format!("{version}.app"))
}

fn not_a_version(version: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("not a version: {version}"),
    )
}

/// 「要不要自动退回」要看的几样（issue #413 完成标准 15）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RollbackCheck<'a> {
    pub platform: DesktopPlatform,
    /// 正在运行的版本。
    pub running: &'a str,
    /// 日志里正在换上、还没确认的那一版（`attempt.to`），没有是 `None`。
    pub applying_to: Option<&'a str>,
    /// 这次启动之前数的 `boots`：前几次启动都没确认、也不是正常退出。
    pub boots: u32,
    /// 换上之前留下了旧包（`attempt.previous_kept`）。
    pub previous_kept: bool,
    /// `previous/<from>.app` 在。
    pub previous_present: bool,
    /// 应用包和它所在的目录当前用户都可写。
    pub bundle_writable: bool,
    /// 拿到了运行锁，不是第二个实例。
    pub sole_instance: bool,
}

/// 启动时退不退。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoRollback {
    RollBack,
    /// 不退，带上原因，进日志。
    Skip(&'static str),
}

/// 要不要在这次启动时自动退回：条件全满足才退。
pub fn auto_rollback(check: RollbackCheck<'_>) -> AutoRollback {
    if !keeps_previous(check.platform) {
        return AutoRollback::Skip("platform");
    }
    let Some(to) = check.applying_to else {
        return AutoRollback::Skip("nothing_applying");
    };
    if to != check.running {
        return AutoRollback::Skip("not_the_new_version");
    }
    // 正好是第 3 次：再往后是 #412 的 `boot_unconfirmed`，规矩不变。
    if check.boots != super::journal::ROLL_BACK_AFTER_BOOTS {
        return AutoRollback::Skip("boots");
    }
    if !check.previous_kept || !check.previous_present {
        return AutoRollback::Skip("no_previous");
    }
    if !check.bundle_writable {
        // 事件循环还没开始，不能让系统弹框要密码。
        return AutoRollback::Skip("not_writable");
    }
    if !check.sole_instance {
        return AutoRollback::Skip("not_sole_instance");
    }
    AutoRollback::RollBack
}

fn run_cp(cp: &Path, flags: &str, from: &Path, to: &Path) -> io::Result<()> {
    let status = std::process::Command::new(cp)
        .arg(flags)
        .arg(from)
        .arg(to)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} {flags} failed ({status})",
            cp.display()
        )))
    }
}

/// 删掉 `path`（目录、文件、软链接都行）；本来就没有不算错。
fn remove_any(path: &Path) -> io::Result<()> {
    let result = match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) => Err(e),
    };
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// 把应用包 `from` 复制成 `to`（`to` 不能已经在）：先 `cp -Rc`（APFS 上是
/// 克隆）；不行（不支持克隆的卷上 macOS 的 `cp -c` 直接报错，不自己退回普通
/// 复制）就删掉复制了一半的，再用 `cp -R` 试一次。
pub fn copy_bundle(cp: &Path, from: &Path, to: &Path) -> io::Result<()> {
    if run_cp(cp, "-Rc", from, to).is_ok() {
        return Ok(());
    }
    remove_any(to)?;
    let plain = run_cp(cp, "-R", from, to);
    if plain.is_err() {
        let _ = remove_any(to);
    }
    plain
}

/// 把 `from` 挪到 `to`：先改名，不行（不在一个卷上）就复制再删掉原来的。
fn move_bundle(cp: &Path, from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_bundle(cp, from, to)?;
    remove_any(from)
}

/// 换上之前：把正在运行的应用包 `bundle` 复制到 `<root>/<version>.app`，
/// `root` 下别的都删掉。回复制出来的路径。
pub fn keep_previous(cp: &Path, bundle: &Path, root: &Path, version: &str) -> io::Result<PathBuf> {
    let name = bundle_name(version).ok_or_else(|| not_a_version(version))?;
    // 同名的也删：上次留了一半的、或者是旧的那一份。
    super::staged::prune_except(root, None)?;
    std::fs::create_dir_all(root)?;
    let kept = root.join(name);
    copy_bundle(cp, bundle, &kept)?;
    Ok(kept)
}

/// 自动退回：把 `previous`（`previous/<from>.app`）换回应用包 `bundle` 的
/// 位置，现在的应用包挪到 `<failed_root>/<failed>.app`（`failed_root` 下只留
/// 这一个）。同一个卷上是两次改名；改名不行就复制。换的时候出错，尽量把
/// 现在的放回原处再回错。
pub fn swap_back(
    cp: &Path,
    bundle: &Path,
    previous: &Path,
    failed_root: &Path,
    failed: &str,
) -> io::Result<()> {
    let name = bundle_name(failed).ok_or_else(|| not_a_version(failed))?;
    if !previous.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is not there", previous.display()),
        ));
    }
    super::staged::prune_except(failed_root, None)?;
    std::fs::create_dir_all(failed_root)?;
    let failed = failed_root.join(name);
    move_bundle(cp, bundle, &failed)?;
    if let Err(e) = move_bundle(cp, previous, bundle) {
        // 旧的没放上去：把现在的放回原处，照常启动。
        let _ = remove_any(bundle);
        if let Err(back) = move_bundle(cp, &failed, bundle) {
            return Err(io::Error::other(format!(
                "{e}; and the current bundle could not be put back: {back}"
            )));
        }
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 第 3 次启动 1.6.41，前两次都没确认，旧包留着，一切正常。
    fn due() -> RollbackCheck<'static> {
        RollbackCheck {
            platform: DesktopPlatform::MacOs,
            running: "1.6.41",
            applying_to: Some("1.6.41"),
            boots: 2,
            previous_kept: true,
            previous_present: true,
            bundle_writable: true,
            sole_instance: true,
        }
    }

    #[test]
    fn two_unconfirmed_boots_with_the_previous_bundle_roll_back() {
        assert_eq!(auto_rollback(due()), AutoRollback::RollBack);
    }

    #[test]
    fn anything_missing_means_no_rollback() {
        for boots in [0, 1] {
            assert_eq!(
                auto_rollback(RollbackCheck { boots, ..due() }),
                AutoRollback::Skip("boots"),
                "{boots}"
            );
        }
        let cases = [
            (
                RollbackCheck {
                    platform: DesktopPlatform::Windows,
                    ..due()
                },
                "platform",
            ),
            (
                RollbackCheck {
                    platform: DesktopPlatform::Linux,
                    ..due()
                },
                "platform",
            ),
            (
                RollbackCheck {
                    applying_to: None,
                    ..due()
                },
                "nothing_applying",
            ),
            // 正在运行的不是换上的那一版（还是旧的、或者手动装了别的）。
            (
                RollbackCheck {
                    running: "1.6.40",
                    ..due()
                },
                "not_the_new_version",
            ),
            (
                RollbackCheck {
                    previous_kept: false,
                    ..due()
                },
                "no_previous",
            ),
            (
                RollbackCheck {
                    previous_present: false,
                    ..due()
                },
                "no_previous",
            ),
            (
                RollbackCheck {
                    bundle_writable: false,
                    ..due()
                },
                "not_writable",
            ),
            (
                RollbackCheck {
                    sole_instance: false,
                    ..due()
                },
                "not_sole_instance",
            ),
        ];
        for (check, why) in cases {
            assert_eq!(auto_rollback(check), AutoRollback::Skip(why), "{check:?}");
        }
    }

    #[test]
    fn only_macos_keeps_the_previous_bundle() {
        assert!(keeps_previous(DesktopPlatform::MacOs));
        assert!(!keeps_previous(DesktopPlatform::Windows));
        assert!(!keeps_previous(DesktopPlatform::Linux));
    }

    #[test]
    fn bundles_are_named_after_a_version() {
        assert_eq!(bundle_name("1.6.40").as_deref(), Some("1.6.40.app"));
        assert_eq!(bundle_name("../x"), None);
        assert_eq!(bundle_name(""), None);
        let data = Path::new("/data");
        assert_eq!(root(data), Path::new("/data/update/previous"));
        assert_eq!(failed_root(data), Path::new("/data/update/failed"));
    }

    /// 一个假的应用包：`Contents/Info.plist` 写着 `marker`，带一个指向包里的
    /// 软链接（Frameworks 里就有）。
    fn fake_bundle(path: &Path, marker: &str) {
        std::fs::create_dir_all(path.join("Contents/MacOS")).unwrap();
        std::fs::write(path.join("Contents/Info.plist"), marker).unwrap();
        std::fs::write(path.join("Contents/MacOS/codeg"), b"#!bin").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("MacOS/codeg", path.join("Contents/Current")).unwrap();
    }

    fn marker(path: &Path) -> String {
        std::fs::read_to_string(path.join("Contents/Info.plist")).unwrap()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    #[test]
    fn the_running_bundle_is_copied_and_nothing_else_is_kept() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("Applications/dodoer.app");
        fake_bundle(&bundle, "1.6.40");
        let root = tmp.path().join("data/update/previous");
        fake_bundle(&root.join("1.6.39.app"), "1.6.39");
        std::fs::write(root.join("stray.txt"), b"x").unwrap();

        let kept = keep_previous(Path::new(CP), &bundle, &root, "1.6.40").unwrap();
        assert_eq!(kept, root.join("1.6.40.app"));
        assert_eq!(names(&root), ["1.6.40.app"]);
        assert_eq!(marker(&kept), "1.6.40");
        assert_eq!(
            std::fs::read_link(kept.join("Contents/Current")).unwrap(),
            Path::new("MacOS/codeg")
        );
        // 应用包本身没动。
        assert_eq!(marker(&bundle), "1.6.40");

        // 再来一次（同一版留过了）：换成新复制的。
        std::fs::write(bundle.join("Contents/Info.plist"), "1.6.40 again").unwrap();
        keep_previous(Path::new(CP), &bundle, &root, "1.6.40").unwrap();
        assert_eq!(marker(&root.join("1.6.40.app")), "1.6.40 again");

        let err = keep_previous(Path::new(CP), &bundle, &root, "../1.6.40").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    /// 一个不支持 `-c`（克隆）的 `cp`：带 `-Rc` 时留下复制了一半的目录再失败。
    #[cfg(unix)]
    fn cp_without_clone(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let cp = dir.join("cp");
        std::fs::write(
            &cp,
            "#!/bin/sh\nif [ \"$1\" = \"-Rc\" ]; then mkdir -p \"$3/half\"; exit 1; fi\nexec /bin/cp \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&cp, std::fs::Permissions::from_mode(0o755)).unwrap();
        cp
    }

    #[cfg(unix)]
    #[test]
    fn a_volume_without_clones_falls_back_to_a_plain_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let cp = cp_without_clone(tmp.path());
        let bundle = tmp.path().join("dodoer.app");
        fake_bundle(&bundle, "1.6.40");
        let to = tmp.path().join("copy.app");
        copy_bundle(&cp, &bundle, &to).unwrap();
        assert_eq!(marker(&to), "1.6.40");
        // 第一次留下的半截删掉了，没有混进去。
        assert!(!to.join("half").exists());
        assert!(!to.join("copy.app").exists());

        // 两次都不行：回错，不留东西。
        let missing = tmp.path().join("missing.app");
        let to = tmp.path().join("copy2.app");
        assert!(copy_bundle(&cp, &missing, &to).is_err());
        assert!(!to.exists());
    }

    #[cfg(unix)]
    #[test]
    fn rolling_back_puts_the_previous_bundle_in_place_and_keeps_only_the_failed_one() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("Applications/dodoer.app");
        fake_bundle(&bundle, "1.6.41");
        let data = tmp.path().join("data");
        let previous = root(&data).join("1.6.40.app");
        fake_bundle(&previous, "1.6.40");
        let failed = failed_root(&data);
        fake_bundle(&failed.join("1.6.39.app"), "1.6.39");

        swap_back(Path::new(CP), &bundle, &previous, &failed, "1.6.41").unwrap();
        assert_eq!(marker(&bundle), "1.6.40");
        assert_eq!(names(&failed), ["1.6.41.app"]);
        assert_eq!(marker(&failed.join("1.6.41.app")), "1.6.41");
        assert!(!previous.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_rollback_without_the_previous_bundle_leaves_the_app_where_it_was() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("Applications/dodoer.app");
        fake_bundle(&bundle, "1.6.41");
        let data = tmp.path().join("data");
        let previous = root(&data).join("1.6.40.app");
        let failed = failed_root(&data);

        assert!(swap_back(Path::new(CP), &bundle, &previous, &failed, "1.6.41").is_err());
        // 现在的应用包放回了原处。
        assert_eq!(marker(&bundle), "1.6.41");
        assert!(!failed.join("1.6.41.app").exists());

        let err = swap_back(Path::new(CP), &bundle, &previous, &failed, "../x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert_eq!(marker(&bundle), "1.6.41");
    }
}
