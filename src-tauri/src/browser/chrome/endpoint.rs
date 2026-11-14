//! Where a running Chrome says it can be reached.
//!
//! With the switch at `chrome://inspect/#remote-debugging` on, Chrome writes
//! `DevToolsActivePort` into its data directory: the port on the first line,
//! the path of the browser's own endpoint on the second. That path carries an
//! id Chrome makes up each time it starts, so it cannot be guessed — it is
//! read from the file, or pasted by the person when the file is out of reach.
//!
//! The file is only ever read. A tool that deleted it while waiting for the
//! person's answer has left Chrome unable to be reached until its next start.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The port the switch listens on. Only assumed when a pasted endpoint names
/// none; the file always does.
const SWITCH_PORT: u16 = 9222;

const BROWSER_PATH: &str = "/devtools/browser/";

/// The browser endpoint of a Chrome on this computer. Always dialed on
/// `127.0.0.1`, whatever a pasted address said its host was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub port: u16,
    pub path: String,
}

impl Endpoint {
    pub fn ws_url(&self) -> String {
        format!("ws://127.0.0.1:{}{}", self.port, self.path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EndpointError {
    /// No file: the switch is off, Chrome is older than the switch, or this
    /// is not where this computer's Chrome keeps its data.
    Missing,
    /// The system refused the read. On macOS that is the privacy setting that
    /// keeps one app out of another's data, and it says nothing about the
    /// switch — which is why it is not folded into [`Self::Missing`].
    Denied,
    /// Read, and not what Chrome writes (or pasted, and not an endpoint).
    Malformed,
    Unreadable(String),
}

/// Where the Chrome a person installs for themselves (the stable channel,
/// default data directory) writes the file on this platform.
pub fn port_file() -> Option<PathBuf> {
    let data_dir = if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join("Library/Application Support/Google/Chrome"))
    } else if cfg!(target_os = "windows") {
        dirs::data_local_dir().map(|dir| dir.join("Google").join("Chrome").join("User Data"))
    } else {
        dirs::config_dir().map(|dir| dir.join("google-chrome"))
    };
    data_dir.map(|dir| dir.join("DevToolsActivePort"))
}

pub fn read_port_file(path: &Path) -> Result<Endpoint, EndpointError> {
    match std::fs::read_to_string(path) {
        Ok(text) => parse_port_file(&text),
        Err(err) => Err(read_failure(err.kind(), &err.to_string())),
    }
}

fn read_failure(kind: ErrorKind, message: &str) -> EndpointError {
    match kind {
        ErrorKind::NotFound => EndpointError::Missing,
        ErrorKind::PermissionDenied => EndpointError::Denied,
        _ => EndpointError::Unreadable(message.to_string()),
    }
}

pub fn parse_port_file(text: &str) -> Result<Endpoint, EndpointError> {
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    let port = lines.next().and_then(port_of);
    let path = lines.next().filter(|line| is_browser_path(line));
    match (port, path) {
        (Some(port), Some(path)) => Ok(Endpoint {
            port,
            path: path.to_string(),
        }),
        _ => Err(EndpointError::Malformed),
    }
}

/// What a person copied out of the file as Chrome shows it: the second line
/// alone, both lines, or a whole `ws://127.0.0.1:…` address.
pub fn parse_pasted(text: &str) -> Result<Endpoint, EndpointError> {
    let mut port = None;
    let mut path = None;
    for token in text.split_whitespace() {
        if let Some(number) = port_of(token) {
            port = Some(number);
        } else if is_browser_path(token) {
            path = Some(token.to_string());
        } else if let Some(endpoint) = run_together(token).or_else(|| loopback_address(token)) {
            port = Some(endpoint.port);
            path = Some(endpoint.path);
        }
    }
    path.map(|path| Endpoint {
        port: port.unwrap_or(SWITCH_PORT),
        path,
    })
    .ok_or(EndpointError::Malformed)
}

/// Both lines with nothing between them: what a one-line text field makes
/// of the file's two when they are pasted into it.
fn run_together(text: &str) -> Option<Endpoint> {
    let (port, path) = text.split_at(text.find(BROWSER_PATH)?);
    let port = port_of(port)?;
    is_browser_path(path).then(|| Endpoint {
        port,
        path: path.to_string(),
    })
}

fn port_of(text: &str) -> Option<u16> {
    text.parse::<u16>().ok().filter(|port| *port != 0)
}

fn is_browser_path(path: &str) -> bool {
    path.strip_prefix(BROWSER_PATH).is_some_and(|id| {
        !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    })
}

/// An address is taken only when it names this computer: the connection is
/// for the person's own Chrome, and nothing pasted may point it elsewhere.
fn loopback_address(text: &str) -> Option<Endpoint> {
    let url = url::Url::parse(text).ok()?;
    if url.scheme() != "ws" {
        return None;
    }
    let loopback = match url.host()? {
        url::Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    if !loopback || !is_browser_path(url.path()) {
        return None;
    }
    Some(Endpoint {
        port: url.port_or_known_default()?,
        path: url.path().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PATH: &str = "/devtools/browser/e691fc11-52e5-4580-ad56-b6091bcae06e";

    fn endpoint(port: u16) -> Endpoint {
        Endpoint {
            port,
            path: PATH.to_string(),
        }
    }

    #[test]
    fn the_file_is_a_port_then_a_path() {
        assert_eq!(parse_port_file(&format!("9222\n{PATH}\n")), Ok(endpoint(9222)));
        assert_eq!(parse_port_file(&format!("51234\r\n{PATH}")), Ok(endpoint(51234)));
        assert_eq!(endpoint(9222).ws_url(), format!("ws://127.0.0.1:9222{PATH}"));
    }

    #[test]
    fn a_file_that_is_not_chromes_is_malformed() {
        for text in [
            "",
            "9222",
            "9222\n/json/version",
            "0\n/devtools/browser/abc",
            "port\n/devtools/browser/abc",
            "9222\n/devtools/browser/",
            "9222\n/devtools/browser/abc/../../json",
            "9222\n/devtools/browser/abc?x=1",
        ] {
            assert_eq!(parse_port_file(text), Err(EndpointError::Malformed), "{text:?}");
        }
    }

    #[test]
    fn a_missing_file_and_a_refused_read_are_told_apart() {
        assert_eq!(read_failure(ErrorKind::NotFound, ""), EndpointError::Missing);
        assert_eq!(read_failure(ErrorKind::PermissionDenied, ""), EndpointError::Denied);
        assert_eq!(
            read_failure(ErrorKind::InvalidData, "not text"),
            EndpointError::Unreadable("not text".to_string())
        );

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("DevToolsActivePort");
        assert_eq!(read_port_file(&file), Err(EndpointError::Missing));
        std::fs::write(&file, format!("9222\n{PATH}\n")).unwrap();
        assert_eq!(read_port_file(&file), Ok(endpoint(9222)));
    }

    #[test]
    fn a_pasted_endpoint_may_be_the_line_the_file_or_an_address() {
        assert_eq!(parse_pasted(PATH), Ok(endpoint(9222)));
        assert_eq!(parse_pasted(&format!("  {PATH}\n")), Ok(endpoint(9222)));
        assert_eq!(parse_pasted(&format!("9333\n{PATH}")), Ok(endpoint(9333)));
        assert_eq!(parse_pasted(&format!("9333 {PATH}")), Ok(endpoint(9333)));
        assert_eq!(parse_pasted(&format!("9333{PATH}")), Ok(endpoint(9333)));
        assert_eq!(
            parse_pasted(&format!("ws://127.0.0.1:9444{PATH}")),
            Ok(endpoint(9444))
        );
        assert_eq!(
            parse_pasted(&format!("ws://localhost:9444{PATH}")),
            Ok(endpoint(9444))
        );
        assert_eq!(parse_pasted(&format!("ws://[::1]:9444{PATH}")), Ok(endpoint(9444)));
    }

    #[test]
    fn nothing_pasted_points_the_connection_at_another_computer() {
        for text in [
            "",
            "9222",
            "hello",
            "/json/version",
            "ws://example.com:9222/devtools/browser/abc",
            "ws://192.168.1.5:9222/devtools/browser/abc",
            "wss://127.0.0.1:9222/devtools/browser/abc",
            "http://127.0.0.1:9222/devtools/browser/abc",
            "ws://127.0.0.1:9222/devtools/page/abc",
            "example.com:9222/devtools/browser/abc",
            "0/devtools/browser/abc",
        ] {
            assert_eq!(parse_pasted(text), Err(EndpointError::Malformed), "{text:?}");
        }
    }

    #[test]
    fn the_file_sits_in_chromes_own_data_directory() {
        let file = port_file().expect("a home directory");
        assert_eq!(file.file_name().unwrap(), "DevToolsActivePort");
    }
}
