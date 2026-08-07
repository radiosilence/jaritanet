//! An OAuth client of the estate's Hydra, and nothing more.
//!
//! Hydra is already public at the MCP gateway's auth hostname with a GitHub
//! allowlist in front of it, so who may sign in is decided there. Anyone
//! holding a token from that issuer has already passed it, which is why there
//! is no second allowlist here — a copy would be a second thing to keep in
//! step, and the one that drifted would be this one.
//!
//! Sessions live in memory and do not survive a restart. That is the one
//! deliberate difference from mcp-gateway, which keeps them in Postgres: this
//! has no database, and logging in again is a smaller cost than a datastore.
//! Written down because "why am I logged out after every deploy" is otherwise a
//! mystery rather than a decision.

pub mod cookie;
pub mod extract;
pub mod oidc;
pub mod routes;
pub mod session;
