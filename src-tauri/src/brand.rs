//! 产品的显示名：用户和智能体看得见的文字里，产品名统一从这里取。
//!
//! 只是「说法」：bundle id、命令名、目录、环境变量这些标识符照旧叫
//! codeg / dodoer，不从这里取，也不要改成这个名字。

/// 界面、聊天软件的消息、智能体读到的说明里显示的产品名。
pub const DISPLAY_NAME: &str = "CoTeam";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_name_is_coteam() {
        assert_eq!(DISPLAY_NAME, "CoTeam");
    }
}
