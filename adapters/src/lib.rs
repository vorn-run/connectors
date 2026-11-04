//! The agent adapters in this folder: each is an extension package of its
//! own (a manifest with an `[agent]` section, its icon and its fixtures),
//! released on its own. This crate only names them for the tests beside it,
//! which replay recorded cases against Vorn's agent crates.

use std::path::PathBuf;

/// An adapter's folder name, and whether Vorn installs it on first launch.
pub const ADAPTERS: &[(&str, bool)] = &[
    ("claude", true),
    ("copilot", true),
    ("codex", true),
    ("opencode", true),
    ("gemini", true),
    ("hermes", false),
    ("cursor", false),
];

/// The package folder of the adapter named `name`.
pub fn folder(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name)
}
