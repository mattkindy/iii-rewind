//! The page and styles the ADE injects. Both are read from the UI's dist folder
//! on every request, and a rebuild registers them again so open consoles reload
//! without restarting Rewind.

use std::{
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime},
};

use iii_sdk::{IIIClient, ObserverHandle, RegisterFunction, Source, Target};
use serde_json::{Value, json};

use crate::{app::App, error::Error};

const CONTENT: &str = "rewind::ui-content";
/// The ADE serves each asset whose observer of this function gives its kind and path.
const ASSET_SOURCE: &str = "ade::ui::asset";
const WATCH_EVERY: Duration = Duration::from_secs(1);

struct Asset {
    path: &'static str,
    file: &'static str,
    kind: &'static str,
    content_type: &'static str,
    placeholder: &'static str,
}

// Styles first, so the page never renders unstyled.
const ASSETS: [Asset; 2] = [
    Asset {
        path: "rewind/styles.css",
        file: "styles.css",
        kind: "style",
        content_type: "text/css; charset=utf-8",
        placeholder: "/* The Rewind UI has not been built yet. */\n",
    },
    Asset {
        path: "rewind/page.js",
        file: "page.js",
        kind: "script",
        content_type: "text/javascript; charset=utf-8",
        placeholder: PLACEHOLDER_PAGE,
    },
];

const PLACEHOLDER_PAGE: &str = r#"import { createElement as h } from 'react'

export default function setup(host) {
  host.pages.register({
    id: 'rewind',
    title: 'Rewind',
    render: () =>
      h('div', { style: { padding: 24, lineHeight: 1.5 } },
        h('h2', null, 'Rewind'),
        h('p', null, 'The Rewind UI has not been built yet. Build it in workers/rewind/ui, which writes ui/dist/page.js and ui/dist/styles.css.'),
        h('p', null, 'Rewind reads those files on every request, so the page appears here without a restart.'),
      ),
  })
}
"#;

fn read_asset(dist: &Path, asset: &Asset) -> String {
    std::fs::read_to_string(dist.join(asset.file)).unwrap_or_else(|_| asset.placeholder.to_string())
}

pub fn register(app: &Arc<App>) {
    let dist = app.config.ui_dist.clone();
    app.iii.register_function(
        CONTENT,
        RegisterFunction::new_async(move |input: Value| {
            let dist = dist.clone();
            async move {
                let path = input["path"].as_str().unwrap_or_default();
                let asset = ASSETS
                    .iter()
                    .find(|asset| asset.path == path)
                    .ok_or_else(|| Error::UnknownUiAsset(format!("no UI asset at {path}")))?;
                Ok(json!({ "content": read_asset(&dist, asset), "content_type": asset.content_type }))
            }
        })
        .description("Serves Rewind's console page and styles")
        .metadata(json!({ "internal": true })),
    );
}

fn register_asset(iii: &IIIClient, asset: &Asset) -> ObserverHandle {
    iii.observe(
        Source::function(ASSET_SOURCE).args(json!({ "kind": asset.kind, "path": asset.path })),
        Target::function(CONTENT),
    )
}

/// `None` while the file is missing, so building it for the first time counts as a change.
type Signature = Option<(u64, SystemTime)>;

fn signature(dist: &Path, asset: &Asset) -> Signature {
    let metadata = std::fs::metadata(dist.join(asset.file)).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

struct Published {
    seen: Signature,
    observer: ObserverHandle,
}

/// The ADE treats a second observer for a path as a replacement and pushes it to open
/// tabs, so a changed file is observed again and the old observer disposed once the new one is active.
pub fn start(app: &Arc<App>) {
    let app = app.clone();
    app.rt.clone().spawn(async move {
        let dist = app.config.ui_dist.clone();
        let mut published: Vec<Published> = ASSETS
            .iter()
            .map(|asset| Published {
                seen: signature(&dist, asset),
                observer: register_asset(&app.iii, asset),
            })
            .collect();
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            for (asset, current) in ASSETS.iter().zip(published.iter_mut()) {
                let now = signature(&dist, asset);
                if now == current.seen {
                    continue;
                }

                eprintln!("rewind: {} changed, publishing it again", asset.path);
                let replacement = register_asset(&app.iii, asset);
                if let Err(error) = replacement.ready().await {
                    eprintln!("rewind: the ADE did not take {} again: {error}", asset.path);
                }

                let old = std::mem::replace(&mut current.observer, replacement);
                let _ = old.dispose().await;
                current.seen = now;
            }
        }
    });
}
