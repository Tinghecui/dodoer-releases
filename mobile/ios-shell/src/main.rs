// 主机平台上的入口（开发时 `cargo run` 用）；iOS 走 lib.rs 里的移动端入口宏。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    coteam_ios_shell_lib::run()
}
