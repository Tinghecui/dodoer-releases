//! Codex's memory citation block, taken off the end of an agent reply.
//!
//! When a reply draws on a stored memory, codex's system prompt asks the model
//! to end it with a block for the client to parse:
//!
//! ```text
//! <oai-mem-citation>
//! <citation_entries>
//! rollout_summaries/example.md:8-10|note=[used prior context]
//! </citation_entries>
//! <rollout_ids>
//! 019c6e27-e55b-73d1-87d8-4e01f1f75043
//! </rollout_ids>
//! </oai-mem-citation>
//! ```
//!
//! Codex keeps it out of the text it shows: the `item_completed` twin of the
//! reply carries the prose without it and the entries in `memory_citation`.
//! The `response_item` record keeps the model's raw output, and codex 0.165+
//! writes no `event_msg.agent_message`, so a reloaded transcript showed the
//! block as prose. [`strip_memory_citation`] removes it.
//!
//! Narrower than codex on purpose: only a block that is the last thing in the
//! reply (codex app directives such as `::inbox-item{…}` may still follow),
//! sits on its own lines outside a fenced code block, has a closing tag and a
//! `<citation_entries>` section. Prose that talks about the tag keeps it.

use std::borrow::Cow;

const OPEN_TAG: &str = "<oai-mem-citation>";
const CLOSE_TAG: &str = "</oai-mem-citation>";
const ENTRIES_OPEN: &str = "<citation_entries>";
const ENTRIES_CLOSE: &str = "</citation_entries>";

/// `text` without its trailing memory citation block, the prose before it
/// kept as written up to its trailing whitespace. Borrowed back unchanged when
/// the reply ends in no such block, which is nearly always.
pub(crate) fn strip_memory_citation(text: &str) -> Cow<'_, str> {
    if !text.contains(OPEN_TAG) {
        return Cow::Borrowed(text);
    }
    let Some(start) = last_open_line_outside_fences(text) else {
        return Cow::Borrowed(text);
    };
    let block = &text[start..];
    let Some(close_rel) = find_line(block, CLOSE_TAG) else {
        return Cow::Borrowed(text);
    };
    let inner = &block[OPEN_TAG.len()..close_rel];
    if find_line(inner, ENTRIES_OPEN).is_none() || find_line(inner, ENTRIES_CLOSE).is_none() {
        return Cow::Borrowed(text);
    }
    let tail = &block[close_rel + CLOSE_TAG.len()..];
    if !tail.lines().all(is_blank_or_directive) {
        return Cow::Borrowed(text);
    }
    let prose = text[..start].trim_end();
    let tail = tail.trim();
    Cow::Owned(match (prose.is_empty(), tail.is_empty()) {
        (_, true) => prose.to_string(),
        (true, false) => tail.to_string(),
        (false, false) => format!("{prose}\n\n{tail}"),
    })
}

/// Byte offset of the last line that is exactly the opening tag (trailing
/// whitespace aside) and not inside a fenced code block.
fn last_open_line_outside_fences(text: &str) -> Option<usize> {
    let mut fence: Option<(u8, usize)> = None;
    let mut found = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let content = line.trim_end();
        match fence {
            Some((ch, len)) => {
                if fence_run(content)
                    .is_some_and(|(c, l, rest)| c == ch && l >= len && rest.is_empty())
                {
                    fence = None;
                }
            }
            None => {
                if let Some((ch, len, _)) = fence_run(content) {
                    fence = Some((ch, len));
                } else if content == OPEN_TAG {
                    found = Some(offset);
                }
            }
        }
        offset += line.len();
    }
    found
}

/// A CommonMark fence opener or closer: up to three spaces, then three or more
/// backticks or tildes. Returns the fence character, its run length and what
/// follows the run.
fn fence_run(line: &str) -> Option<(u8, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let ch = *rest.as_bytes().first()?;
    if ch != b'`' && ch != b'~' {
        return None;
    }
    let len = rest.bytes().take_while(|&b| b == ch).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim();
    // A backtick fence's info string may not hold a backtick.
    if ch == b'`' && info.contains('`') {
        return None;
    }
    Some((ch, len, info))
}

/// Start of the first line of `text` that is exactly `tag`, trailing
/// whitespace aside.
fn find_line(text: &str, tag: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        if line.trim_end() == tag {
            return Some(offset);
        }
        offset += line.len();
    }
    None
}

/// Blank, or a codex app directive line such as
/// `::inbox-item{title="…" summary="…"}`, which codex leaves after the block.
fn is_blank_or_directive(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return true;
    }
    let Some(rest) = line.strip_prefix("::") else {
        return false;
    };
    let name_len = rest
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
        .count();
    name_len > 0 && rest[name_len..].starts_with('{') && rest.ends_with('}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ContentBlock, ConversationDetail, TurnRole};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// The block as codex 0.166 wrote it at the end of a real reply.
    const BLOCK: &str = "<oai-mem-citation>\n<citation_entries>\nrollout_summaries/2026-11-06T11-29-40-2zLk-playwright_extension_race_token_repair.md:7-7|note=[用于定位扩展连接启动器]\n</citation_entries>\n<rollout_ids>\n019c6e27-e55b-73d1-87d8-4e01f1f75043\n</rollout_ids>\n</oai-mem-citation>";

    #[test]
    fn a_trailing_block_is_removed_without_a_trailing_blank_line() {
        let prose = "**结论**：已核对。\n\n| 项目 | 结果 |\n| --- | --- |\n| 欠款 | US$8.33 |";
        assert_eq!(strip_memory_citation(&format!("{prose}\n\n{BLOCK}")), prose);
        assert_eq!(
            strip_memory_citation(&format!("{prose}\n\n{BLOCK}\n")),
            prose
        );
        assert_eq!(
            strip_memory_citation(&format!(
                "{prose}\r\n\r\n{}\r\n",
                BLOCK.replace('\n', "\r\n")
            )),
            prose
        );
    }

    /// Codex 0.166 left an app directive after the block in a real reply.
    #[test]
    fn an_app_directive_after_the_block_stays() {
        let directive = "::inbox-item{title=\"两个项目夜间分类整理完成\" summary=\"核对通过\"}";
        assert_eq!(
            strip_memory_citation(&format!("无失败。\n\n{BLOCK}\n{directive}")),
            format!("无失败。\n\n{directive}")
        );
    }

    #[test]
    fn a_block_in_code_or_mid_prose_stays() {
        let fenced = format!("示例：\n\n```text\n{BLOCK}\n```");
        assert_eq!(strip_memory_citation(&fenced), fenced);
        let tilde = format!("示例：\n\n~~~~\n{BLOCK}");
        assert_eq!(strip_memory_citation(&tilde), tilde);
        let inline = "末尾写 `<oai-mem-citation><citation_entries></citation_entries></oai-mem-citation>` 即可";
        assert_eq!(strip_memory_citation(inline), inline);
        let mention = "Codex 会在回复末尾加 <oai-mem-citation> 标记，客户端负责去掉。";
        assert_eq!(strip_memory_citation(mention), mention);
        let followed = format!("前文\n\n{BLOCK}\n\n后面还有正文。");
        assert_eq!(strip_memory_citation(&followed), followed);
    }

    #[test]
    fn an_unfinished_or_malformed_block_stays() {
        let unclosed = "正文\n\n<oai-mem-citation>\n<citation_entries>\na.md:1-2|note=[x]\n";
        assert_eq!(strip_memory_citation(unclosed), unclosed);
        let no_entries = "正文\n\n<oai-mem-citation>\nsomething\n</oai-mem-citation>";
        assert_eq!(strip_memory_citation(no_entries), no_entries);
    }

    #[test]
    fn a_block_after_a_closed_fence_is_removed() {
        let prose = "```rust\nlet x = 1;\n```\n\n完成。";
        assert_eq!(strip_memory_citation(&format!("{prose}\n\n{BLOCK}")), prose);
    }

    fn record(ts: &str, kind: &str, payload: serde_json::Value) -> String {
        format!(
            "{}\n",
            serde_json::json!({"timestamp": ts, "type": kind, "payload": payload})
        )
    }

    fn parse(content: &str, id: &str) -> ConversationDetail {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("codeg-codex-memcite-{id}-{nanos}.jsonl"));
        std::fs::write(&path, content).expect("write test jsonl");
        let detail = super::super::codex::CodexParser::new()
            .parse_conversation_detail(&path, id)
            .expect("parse detail ok");
        let _ = std::fs::remove_file(path);
        detail
    }

    /// The shape codex 0.166 writes (no `event_msg.agent_message`): the
    /// `response_item` reply carries the block, its `item_completed` twin
    /// carries the prose and `memory_citation`. The user's text, a tool call's
    /// input and the reasoning summary that hold the same block keep it.
    #[test]
    fn a_reloaded_codex_reply_loses_only_its_trailing_block() {
        let prose = "已核对，结论如下。\n\n| 项目 | 结果 |\n| --- | --- |\n| 欠款 | US$8.33 |";
        let reply = format!("{prose}\n\n{BLOCK}");
        let args = serde_json::json!({"cmd": format!("printf '{BLOCK}'")}).to_string();
        let content = [
            record("2026-11-14T10:00:00Z", "session_meta", serde_json::json!({"id": "memcite-1", "cwd": "/w/proj", "cli_version": "0.166.0"})),
            record("2026-11-14T10:00:00.1Z", "event_msg", serde_json::json!({"type": "task_started", "turn_id": "t1"})),
            record("2026-11-14T10:00:00.2Z", "turn_context", serde_json::json!({"turn_id": "t1", "cwd": "/w/proj", "model": "gpt-5.5"})),
            record("2026-11-14T10:00:01Z", "response_item", serde_json::json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": format!("引用块长这样：\n{BLOCK}")}]})),
            record("2026-11-14T10:00:02Z", "response_item", serde_json::json!({"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": format!("**Checking**\n\n{BLOCK}")}]})),
            record("2026-11-14T10:00:03Z", "response_item", serde_json::json!({"type": "function_call", "name": "exec_command", "arguments": args, "call_id": "call_1"})),
            record("2026-11-14T10:00:04Z", "response_item", serde_json::json!({"type": "function_call_output", "call_id": "call_1", "output": BLOCK})),
            record("2026-11-14T10:00:05Z", "event_msg", serde_json::json!({"type": "item_completed", "turn_id": "t1", "item": {"type": "AgentMessage", "id": "msg_1", "content": [{"type": "Text", "text": prose}], "phase": "final_answer", "memory_citation": {"entries": [{"path": "a.md", "lineStart": 7, "lineEnd": 7, "note": "x"}], "rolloutIds": []}}})),
            record("2026-11-14T10:00:05.1Z", "response_item", serde_json::json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": reply}], "phase": "final_answer"})),
            record("2026-11-14T10:00:06Z", "event_msg", serde_json::json!({"type": "task_complete", "turn_id": "t1", "last_agent_message": prose})),
        ]
        .concat();
        let detail = parse(&content, "memcite-1");

        let mut assistant_texts = Vec::new();
        let mut user_texts = Vec::new();
        let mut kept_elsewhere = 0;
        for turn in &detail.turns {
            for block in &turn.blocks {
                match (block, &turn.role) {
                    (ContentBlock::Text { text }, TurnRole::User) => user_texts.push(text.clone()),
                    (ContentBlock::Text { text }, TurnRole::Assistant) => {
                        assistant_texts.push(text.clone())
                    }
                    (other, _) => {
                        let json = serde_json::to_string(other).expect("serialize block");
                        if json.contains("<oai-mem-citation>")
                            && json.contains("</oai-mem-citation>")
                        {
                            kept_elsewhere += 1;
                        }
                    }
                }
            }
        }
        assert_eq!(assistant_texts, vec![prose.to_string()]);
        assert_eq!(user_texts, vec![format!("引用块长这样：\n{BLOCK}")]);
        // Reasoning, the tool call's input and its output.
        assert_eq!(kept_elsewhere, 3, "{:#?}", detail.turns);
    }
}
