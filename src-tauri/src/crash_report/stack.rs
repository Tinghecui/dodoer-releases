//! Where the main thread was while it did not answer: its call stack, taken
//! once per hang with macOS's own `/usr/bin/sample` and reduced to function
//! and library names. The sample itself (it carries the app's path and every
//! other thread) is read here and removed; nothing else of it is kept.
//!
//! Only macOS samples ([`sample_main_thread`]); elsewhere only the tests use
//! the parser.
#![cfg_attr(
    not(all(target_os = "macos", feature = "tauri-runtime")),
    allow(dead_code)
)]

use serde::{Deserialize, Serialize};

/// One frame of the stack: the function, and the library or binary it is in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Frame {
    pub function: String,
    pub image: String,
}

/// At most this many frames are kept, the innermost ones.
pub const MAX_FRAMES: usize = 48;
/// The longest function name kept.
const MAX_FUNCTION_CHARS: usize = 160;
/// The longest library name kept.
const MAX_IMAGE_CHARS: usize = 64;

/// What `sample` draws its call tree with, before each line's count.
const TREE: [char; 5] = [' ', '+', '!', ':', '|'];

/// The main thread's stack in a `sample` report, outermost frame first: the
/// first thread under `Call graph:`, followed down its first branch (a thread
/// that hung has only one).
pub fn main_thread_frames(sample: &str) -> Vec<Frame> {
    let mut frames = Vec::new();
    let mut in_main = false;
    let mut depth = 0;
    let lines = sample
        .lines()
        .skip_while(|line| line.trim() != "Call graph:")
        .skip(1);
    for line in lines {
        let body = line.trim_start_matches(TREE);
        let Some((count, rest)) = body.split_once(' ') else {
            break;
        };
        if count.is_empty() || !count.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        if rest.starts_with("Thread_") {
            if in_main {
                break;
            }
            in_main = true;
            continue;
        }
        let indent = line.len() - body.len();
        if !in_main || indent <= depth {
            continue;
        }
        if let Some(frame) = frame(rest) {
            frames.push(frame);
            depth = indent;
        }
    }
    if frames.len() > MAX_FRAMES {
        frames.drain(..frames.len() - MAX_FRAMES);
    }
    frames
}

/// `symbol  (in image) + 12  [0x…]`. A frame `sample` found no name for
/// (`???  (in image)  load address 0x… + 0x5d2f  [0x…]`) keeps its offset in
/// the image, which names the function to whoever has that build.
fn frame(text: &str) -> Option<Frame> {
    let (function, rest) = text.split_once("  (in ")?;
    let (image, rest) = rest.split_once(')')?;
    let function = function.trim();
    let function = match rest.split_once(" + ") {
        Some((_, offset)) if function == "???" => {
            let offset = offset.split_whitespace().next().unwrap_or_default();
            format!("??? + {offset}")
        }
        _ => function.to_string(),
    };
    // A library is named, never its path.
    let image = image.rsplit('/').next().unwrap_or(image);
    Some(Frame {
        function: function.chars().take(MAX_FUNCTION_CHARS).collect(),
        image: image.chars().take(MAX_IMAGE_CHARS).collect(),
    })
}

/// How long `sample` watches the app.
#[cfg(all(target_os = "macos", feature = "tauri-runtime"))]
const SAMPLE_SECS: &str = "1";
/// `sample` is ended when it has not finished by then (it looks up names
/// after watching).
#[cfg(all(target_os = "macos", feature = "tauri-runtime"))]
const SAMPLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Sample this process for a second and return its main thread's stack.
/// Empty when it could not be sampled. Takes a few seconds: not for the
/// watchdog's own thread.
#[cfg(all(target_os = "macos", feature = "tauri-runtime"))]
pub fn sample_main_thread(dir: &std::path::Path) -> Vec<Frame> {
    use std::process::{Command, Stdio};

    if std::fs::create_dir_all(dir).is_err() {
        return Vec::new();
    }
    let pid = std::process::id();
    let file = dir.join(format!("sample-{pid}.txt"));
    let spawned = Command::new("/usr/bin/sample")
        .arg(pid.to_string())
        .arg(SAMPLE_SECS)
        .arg("-file")
        .arg(&file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = spawned else {
        return Vec::new();
    };
    let started = std::time::Instant::now();
    let finished = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if started.elapsed() < SAMPLE_TIMEOUT => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let text = if finished {
        std::fs::read_to_string(&file).unwrap_or_default()
    } else {
        String::new()
    };
    let _ = std::fs::remove_file(&file);
    main_thread_frames(&text)
}

#[cfg(all(not(target_os = "macos"), feature = "tauri-runtime"))]
pub fn sample_main_thread(_dir: &std::path::Path) -> Vec<Frame> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
Analysis of sampling codeg (pid 4242) every 1 millisecond
Process:         codeg [4242]
Path:            /Users/someone/Applications/dodoer.app/Contents/MacOS/codeg
Load Address:    0x104b5c000

Call graph:
    812 Thread_8317   DispatchQueue_1: com.apple.main-thread  (serial)
    + 812 start  (in dyld) + 1909  [0x7ff8087d541d]
    +   812 main  (in codeg) + 9  [0x10f6e0b79]
    +     812 ???  (in codeg)  load address 0x104b5c000 + 0x5d2f3c  [0x10512ef3c]
    +       800 -[NSApplication run]  (in AppKit) + 603  [0x7ff80b8c6a2b]
    +       ! 800 mach_msg2_trap  (in libsystem_kernel.dylib) + 10  [0x7ff808ae75b2]
    +       12 objc_msgSend  (in libobjc.A.dylib) + 26  [0x7ff80877f01a]
    812 Thread_8330
    + 812 start_wqthread  (in libsystem_pthread.dylib) + 15  [0x7ff808b21bcb]
    +   812 __workq_kernreturn  (in libsystem_kernel.dylib) + 10  [0x7ff808ae8a12]

Total number in stack (recursive counted multiple, when >=5):
        5       _pthread_start  (in libsystem_pthread.dylib) + 0  [0x7ff808b25fa9]

Binary Images:
       0x104b5c000 -        0x10a1f3fff +codeg (1.6.70) /Users/someone/Applications/dodoer.app/Contents/MacOS/codeg
";

    fn names(frames: &[Frame]) -> Vec<(&str, &str)> {
        frames
            .iter()
            .map(|f| (f.function.as_str(), f.image.as_str()))
            .collect()
    }

    #[test]
    fn the_main_thread_is_followed_down_its_first_branch() {
        let frames = main_thread_frames(SAMPLE);
        assert_eq!(
            names(&frames),
            [
                ("start", "dyld"),
                ("main", "codeg"),
                ("??? + 0x5d2f3c", "codeg"),
                ("-[NSApplication run]", "AppKit"),
                ("mach_msg2_trap", "libsystem_kernel.dylib"),
            ]
        );
    }

    #[test]
    fn nothing_but_names_is_kept() {
        let kept = serde_json::to_string(&main_thread_frames(SAMPLE)).unwrap();
        assert!(!kept.contains("someone"), "{kept}");
        assert!(!kept.contains('/'), "{kept}");
        assert!(!kept.contains("start_wqthread"), "{kept}");
        assert!(!kept.contains("0x7ff"), "{kept}");

        let pathed = frame("f  (in /Users/someone/lib/libx.dylib) + 1  [0x1]").unwrap();
        assert_eq!(pathed.image, "libx.dylib");
    }

    #[test]
    fn a_report_without_a_call_graph_gives_nothing() {
        assert!(main_thread_frames("").is_empty());
        assert!(main_thread_frames("sample cannot examine process 4242").is_empty());
        assert!(main_thread_frames("Call graph:\n").is_empty());
    }

    #[test]
    fn a_deep_stack_keeps_its_innermost_frames() {
        let mut sample = String::from("Call graph:\n    9 Thread_1   DispatchQueue_1\n");
        for i in 0..MAX_FRAMES + 5 {
            let indent = " ".repeat(2 * i);
            sample.push_str(&format!("    +{indent} 9 f{i}  (in codeg) + 1  [0x1]\n"));
        }
        let frames = main_thread_frames(&sample);
        assert_eq!(frames.len(), MAX_FRAMES);
        assert_eq!(frames[0].function, "f5");
        assert_eq!(
            frames[MAX_FRAMES - 1].function,
            format!("f{}", MAX_FRAMES + 4)
        );
    }
}
