//! The one cookie this service sets, and how it is read back.
//!
//! It carries a Redis key for the in-flight login and nothing else — no
//! identity, no session. The session that makes signing in to a second service
//! seamless is Hydra's, held at the authorization server where every relying
//! party can benefit from it.
//!
//! `SameSite=Lax` rather than `Strict` because the cookie has to survive the
//! browser being sent back here by GitHub, which is a cross-site navigation.

pub const FLOW_COOKIE: &str = "auth_flow";

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
        let h = "other=1; auth_flow=abc123; another=2";
        assert_eq!(read_cookie(h, FLOW_COOKIE), Some("abc123"));
        assert_eq!(read_cookie(h, "absent"), None);
    }

    #[test]
    fn the_flow_cookie_is_hardened() {
        let c = set_cookie(FLOW_COOKIE, "v", 600);
        assert!(c.contains("HttpOnly"));
        assert!(c.contains("Secure"));
        assert!(c.contains("SameSite=Lax"));
    }
}
