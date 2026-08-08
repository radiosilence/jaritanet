//! Shared application state, cloned into every handler.

use std::sync::Arc;

use crate::config::Config;
use crate::hydra::HydraAdmin;
use crate::store::Store;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub http: reqwest::Client,
    pub hydra: HydraAdmin,
}
