//! The sites agents may not use in the person's own Chrome, whoever opened
//! the tab (`docs/agent-chrome.md` section 5.5).
//!
//! Every page an agent opens in that Chrome carries the person's sign-ins, so
//! "only the tabs the agent opened" stops nothing on its own: such a tab can
//! open their mail as easily as anything else. This list is what does. It
//! stops agents only — the person browses these sites in Chrome as ever, and
//! nothing here is consulted for the built-in browser, whose tabs have none
//! of the person's sign-ins.
//!
//! Mail, payments, banks, password managers and the account pages that reset
//! all of those. Matched by host, subdomains included. Fixed for now; making
//! it the person's to edit is a later step.

use url::Url;

const SENSITIVE: &[&str] = &[
    // Mail.
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "mail.yahoo.com",
    "mail.proton.me",
    "icloud.com",
    "mail.qq.com",
    "exmail.qq.com",
    "mail.163.com",
    "mail.126.com",
    "mail.yeah.net",
    "mail.sina.com.cn",
    "mail.aliyun.com",
    "qiye.aliyun.com",
    // Payments.
    "paypal.com",
    "alipay.com",
    "pay.weixin.qq.com",
    "tenpay.com",
    "wise.com",
    // Passwords, and the accounts that reset everything else.
    "1password.com",
    "bitwarden.com",
    "lastpass.com",
    "passwords.google.com",
    "myaccount.google.com",
    "account.apple.com",
    "appleid.apple.com",
    "account.microsoft.com",
    // Banks.
    "icbc.com.cn",
    "ccb.com",
    "abchina.com",
    "boc.cn",
    "bankcomm.com",
    "cmbchina.com",
    "psbc.com",
    "citicbank.com",
    "cebbank.com",
    "cib.com.cn",
    "spdb.com.cn",
    "cmbc.com.cn",
    "pingan.com",
    "hxb.com.cn",
    "cgbchina.com.cn",
    "hsbc.com",
    "hsbc.com.hk",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    // Exchanges.
    "binance.com",
    "okx.com",
    "coinbase.com",
];

/// Whether agents are kept off `host` in the person's Chrome.
pub fn is_sensitive_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    SENSITIVE.iter().any(|site| {
        host == *site
            || host
                .strip_suffix(*site)
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// [`is_sensitive_host`] for the host of `url`; an address with no host is
/// none of these sites.
pub fn is_sensitive(url: &Url) -> bool {
    url.host_str().is_some_and(is_sensitive_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_site_and_its_subdomains_are_sensitive() {
        assert!(is_sensitive_host("mail.google.com"));
        assert!(is_sensitive_host("www.icbc.com.cn"));
        assert!(is_sensitive_host("MAIL.QQ.COM."));
        assert!(is_sensitive(&Url::parse("https://www.paypal.com/signin?x=1").unwrap()));
    }

    #[test]
    fn a_site_that_merely_ends_in_the_same_letters_is_not() {
        assert!(!is_sensitive_host("notpaypal.com"));
        assert!(!is_sensitive_host("paypal.com.example"));
        assert!(!is_sensitive_host("docs.google.com"));
        assert!(!is_sensitive_host("qq.com"));
        assert!(!is_sensitive(&Url::parse("data:text/html,hi").unwrap()));
    }
}
