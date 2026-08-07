//! Cookie names and hardened `Set-Cookie` values.
//!
//! `SameSite=Lax` is the CSRF control for the state-changing routes: this is a
//! single-origin app that is never embedded, so a cross-site form post never
//! carries the session.

pub const SESSION_COOKIE: &str = "mariastew_session";
pub const FLOW_COOKIE: &str = "mariastew_flow";

pub fn set_cookie(name: &str, value: &str, max_age_secs: i64) -> String {
    format!("{name}={value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age={max_age_secs}")
}

pub fn clear_cookie(name: &str) -> String {
    format!("{name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")
}

pub fn read_cookie<'a>(cookie_header: &'a str, name: &str) -> Option<&'a str> {
    cookie_header.split(';').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k.trim() == name).then(|| v.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_named_cookie_from_a_header_of_several() {
        let h = "other=1; mariastew_session=abc123; another=2";
        assert_eq!(read_cookie(h, SESSION_COOKIE), Some("abc123"));
        assert_eq!(read_cookie(h, "absent"), None);
    }
}
