//! The macOS permissions a lent shell borrows from the app
//! (`docs/host-ssh.md` 5.6).
//!
//! The service is started by the app, so macOS charges whatever a lent shell
//! does to the app: a server's agent can take a screenshot over `ssh desktop`
//! exactly when the app itself holds Screen Recording. The app is signed
//! without a Developer ID, so the system knows it by the hash of its code,
//! and every update is a stranger to it: the switch in System Settings stays
//! on while the grant behind it no longer matches anything (seen on a Mac on
//! 2026-11-15: `Failed to match existing code requirement for subject
//! app.codeg`). This answers whether the grant is in force, and repairs one
//! that is not by clearing it (`tccutil reset`, no administrator needed) and
//! asking again, which puts up the system's own dialog.
//!
//! Asking in the app's own name is a deliberate exception to computer use,
//! which leaves every request to its helper (`computer::tcc`): there the app
//! holding a permission is a leak, here it is the point of lending. Only a
//! person's click in the lending panel ever asks.

use serde::{Deserialize, Serialize};

/// A permission a lent shell may need.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Permission {
    ScreenRecording,
    Accessibility,
}

impl Permission {
    pub const ALL: [Permission; 2] = [Permission::ScreenRecording, Permission::Accessibility];

    /// The service name `tccutil` knows it by.
    pub fn tcc_service(self) -> &'static str {
        match self {
            Permission::ScreenRecording => "ScreenCapture",
            Permission::Accessibility => "Accessibility",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub permission: Permission,
    /// In force for this run of the app. macOS keeps a process's first "not
    /// granted" for its whole life, so a grant made since shows after the
    /// app is reopened.
    pub granted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    /// Whether the system has such permissions at all (macOS only).
    pub applicable: bool,
    /// Whether the app is its own responsible process. When it is not (it
    /// was started from a terminal), the answers are that terminal's, and
    /// nothing done to the app's grant would change them.
    pub self_responsible: bool,
    pub items: Vec<PermissionStatus>,
}

/// Where each permission stands for this run of the app. Raises nothing.
pub fn status() -> Permissions {
    let applicable = cfg!(target_os = "macos");
    Permissions {
        applicable,
        self_responsible: applicable && platform::self_responsible(),
        items: if applicable {
            Permission::ALL
                .iter()
                .map(|&permission| PermissionStatus {
                    permission,
                    granted: platform::granted(permission),
                })
                .collect()
        } else {
            Vec::new()
        },
    }
}

/// Clear the app's grant of `permission` and ask for it again: the system
/// puts up its dialog, and the person allows it in System Settings.
/// `bundle_id` is the app's own identifier.
pub fn repair(permission: Permission, bundle_id: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("only macOS has these permissions".to_string());
    }
    if !valid_bundle_id(bundle_id) {
        return Err(format!("not an application identifier: {bundle_id:?}"));
    }
    if !platform::self_responsible() {
        return Err(
            "the app was started by another program (a terminal?), whose permissions it uses; \
             open it from Applications to repair its own"
                .to_string(),
        );
    }
    platform::reset_and_ask(permission, &reset_args(permission, bundle_id))
}

/// `tccutil`'s arguments for clearing the app's grant of `permission`.
fn reset_args(permission: Permission, bundle_id: &str) -> [&str; 3] {
    ["reset", permission.tcc_service(), bundle_id]
}

/// A reverse-DNS application identifier, and nothing `tccutil` could take
/// for an option.
fn valid_bundle_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 255
        && !id.starts_with(['-', '.'])
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Permission;
    use crate::computer::tcc;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    use core_foundation_sys::dictionary::CFDictionaryRef;
    use core_foundation_sys::string::CFStringRef;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
    }

    const TCCUTIL: &str = "/usr/bin/tccutil";

    pub fn granted(permission: Permission) -> bool {
        match permission {
            Permission::ScreenRecording => tcc::screen_recording_granted(),
            Permission::Accessibility => tcc::accessibility_granted(),
        }
    }

    pub fn self_responsible() -> bool {
        let me = std::process::id();
        tcc::responsible_pid(me) == Some(me)
    }

    pub fn reset_and_ask(permission: Permission, args: &[&str; 3]) -> Result<(), String> {
        let out = std::process::Command::new(TCCUTIL)
            .args(args)
            .output()
            .map_err(|e| format!("{TCCUTIL}: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("tccutil failed: {}", stderr.trim()));
        }
        ask(permission);
        Ok(())
    }

    /// The system's own request, as the computer-use helper makes it.
    fn ask(permission: Permission) {
        match permission {
            Permission::Accessibility => {
                // SAFETY: the option key is a CFString constant for the life
                // of the process; the dictionary outlives the call.
                unsafe {
                    let options = CFDictionary::from_CFType_pairs(&[(
                        CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt),
                        CFBoolean::true_value(),
                    )]);
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef());
                }
            }
            Permission::ScreenRecording => {
                // macOS 10.15+, so looked up rather than linked.
                type Request = unsafe extern "C" fn() -> u8;
                static NAME: &[u8] = b"CGRequestScreenCaptureAccess\0";
                // SAFETY: RTLD_DEFAULT lookup of a NUL-terminated name; the
                // symbol has exactly this signature.
                unsafe {
                    let sym = libc::dlsym(libc::RTLD_DEFAULT, NAME.as_ptr().cast());
                    if !sym.is_null() {
                        let request: Request =
                            std::mem::transmute::<*mut libc::c_void, Request>(sym);
                        request();
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::Permission;

    pub fn granted(_permission: Permission) -> bool {
        false
    }

    pub fn self_responsible() -> bool {
        false
    }

    pub fn reset_and_ask(_permission: Permission, _args: &[&str; 3]) -> Result<(), String> {
        Err("only macOS has these permissions".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_permission_has_its_tccutil_service() {
        assert_eq!(Permission::ScreenRecording.tcc_service(), "ScreenCapture");
        assert_eq!(Permission::Accessibility.tcc_service(), "Accessibility");
    }

    #[test]
    fn permissions_cross_to_the_windows_by_their_camel_case_names() {
        assert_eq!(
            serde_json::to_string(&Permission::ScreenRecording).unwrap(),
            "\"screenRecording\""
        );
        assert_eq!(
            serde_json::from_str::<Permission>("\"accessibility\"").unwrap(),
            Permission::Accessibility
        );
        let shape = serde_json::to_value(Permissions {
            applicable: true,
            self_responsible: true,
            items: vec![PermissionStatus {
                permission: Permission::ScreenRecording,
                granted: false,
            }],
        })
        .unwrap();
        assert_eq!(
            shape,
            serde_json::json!({
                "applicable": true,
                "selfResponsible": true,
                "items": [{ "permission": "screenRecording", "granted": false }],
            })
        );
    }

    #[test]
    fn reset_clears_the_one_service_for_the_app() {
        assert_eq!(
            reset_args(Permission::ScreenRecording, "app.codeg"),
            ["reset", "ScreenCapture", "app.codeg"]
        );
        assert_eq!(
            reset_args(Permission::Accessibility, "app.codeg"),
            ["reset", "Accessibility", "app.codeg"]
        );
    }

    #[test]
    fn only_application_identifiers_reach_tccutil() {
        assert!(valid_bundle_id("app.codeg"));
        assert!(valid_bundle_id("com.example.my-app2"));
        assert!(!valid_bundle_id(""));
        assert!(!valid_bundle_id("-h"));
        assert!(!valid_bundle_id(".hidden"));
        assert!(!valid_bundle_id("app codeg"));
        assert!(!valid_bundle_id("app/codeg"));
        assert!(!valid_bundle_id(&"a".repeat(256)));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn elsewhere_there_is_nothing_to_check_or_repair() {
        let status = status();
        assert!(!status.applicable);
        assert!(!status.self_responsible);
        assert!(status.items.is_empty());
        assert!(repair(Permission::ScreenRecording, "app.codeg").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn on_macos_both_permissions_are_answered_without_asking() {
        let status = status();
        assert!(status.applicable);
        let asked: Vec<_> = status.items.iter().map(|item| item.permission).collect();
        assert_eq!(asked, Permission::ALL);
    }

    #[test]
    fn a_bad_identifier_is_refused_before_anything_runs() {
        let refused = repair(Permission::Accessibility, "-reset all");
        assert!(refused.is_err());
    }
}
