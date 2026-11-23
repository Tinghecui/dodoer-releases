//! 配置检查：应用编号、显示名、移动端要的库类型，以及不给任何页面开放 Tauri 命令。

use std::path::Path;

fn manifest_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

fn tauri_conf() -> serde_json::Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json 是合法 JSON")
}

#[test]
fn identifier_and_name() {
    let conf = tauri_conf();
    assert_eq!(conf["identifier"], "ai.coteam.app");
    assert_eq!(conf["productName"], "coteam");
    // 构建号要比旧原生应用最后一次上传的 2611221830 大
    let build: u64 = conf["bundle"]["iOS"]["bundleVersion"]
        .as_str()
        .expect("bundle.iOS.bundleVersion")
        .parse()
        .expect("构建号是数字");
    assert!(build > 2_611_221_830, "构建号 {build} 不比旧应用的大");
}

#[test]
fn crate_types_for_mobile() {
    let manifest = include_str!("../Cargo.toml");
    assert!(
        manifest.contains(r#"crate-type = ["staticlib", "cdylib", "rlib"]"#),
        "Tauri 移动端要 staticlib 和 cdylib"
    );
    let lib = include_str!("lib.rs");
    assert!(lib.contains("#[cfg_attr(mobile, tauri::mobile_entry_point)]"));
}

#[test]
fn does_not_depend_on_desktop_crate() {
    // 只看不是注释的行：依赖里不能有本地路径（src-tauri 那个 crate）或 codeg 的包
    let manifest: Vec<&str> = include_str!("../Cargo.toml")
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect();
    for line in &manifest {
        assert!(!line.contains("path ="), "{line}");
        assert!(!line.contains("codeg"), "{line}");
    }
    for source in [include_str!("lib.rs"), include_str!("navigation.rs")] {
        assert!(!source.contains("codeg_lib"));
    }
}

#[test]
fn no_capabilities_for_any_page() {
    let conf = tauri_conf();
    let security = &conf["app"]["security"];
    assert!(
        security.get("capabilities").is_none(),
        "配置里不能内联任何权限条目"
    );
    assert_eq!(conf["app"]["withGlobalTauri"], false);
    // 没有权限文件，远程页面（和启动页）就调不了任何命令
    assert!(
        !manifest_dir().join("capabilities").exists(),
        "不能有 capabilities 目录"
    );
    assert!(!include_str!("../tauri.conf.json").contains("remote"));
}

#[test]
fn registers_no_custom_commands() {
    for source in [
        include_str!("lib.rs"),
        include_str!("main.rs"),
        include_str!("navigation.rs"),
    ] {
        assert!(!source.contains("invoke_handler"));
        assert!(!source.contains("generate_handler"));
        assert!(!source.contains("tauri::command"));
    }
}

#[test]
fn ios_allows_plain_http_servers() {
    // iOS 的传输安全策略默认拦下明文 HTTP；本地或内网的 http 服务器要在 Info.ios.plist 里放开网页视图
    let path = manifest_dir().join("Info.ios.plist");
    assert!(path.exists(), "要有 Info.ios.plist（Tauri 生成 Xcode 工程时合并进去）");
    let plist = std::fs::read_to_string(path).unwrap();
    let compact: String = plist.split_whitespace().collect();
    assert!(compact.contains("<key>NSAppTransportSecurity</key><dict>"));
    assert!(compact.contains("<key>NSAllowsArbitraryLoadsInWebContent</key><true/>"));
    assert!(compact.contains("<key>NSAllowsLocalNetworking</key><true/>"));
    // 连局域网地址时 iOS 会弹本地网络授权，没有说明文字就不让连
    assert!(compact.contains("<key>NSLocalNetworkUsageDescription</key><string>"));
    // 只放开网页视图，不整个关掉
    assert!(!compact.contains("<key>NSAllowsArbitraryLoads</key>"));
}

#[test]
fn main_window_injects_both_scripts() {
    let lib = include_str!("lib.rs");
    assert!(lib.contains(".initialization_script(SHELL_MARKER_SCRIPT)"));
    assert!(lib.contains(".initialization_script(NEW_WINDOW_SCRIPT)"));
    assert!(
        !crate::navigation::NEW_WINDOW_SCRIPT.trim().is_empty(),
        "新窗口脚本不能是空的"
    );
}
