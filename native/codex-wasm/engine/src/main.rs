mod bridge;
mod input;
mod protocol;
mod startup;

use anyhow::Context;
use input::StdinLines;
use protocol::Bootstrap;

const UPSTREAM_VERSION: &str = env!("CODEX_UPSTREAM_VERSION");

fn main() -> anyhow::Result<()> {
    if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new("--version")) {
        protocol::emit(&serde_json::json!({
            "version": UPSTREAM_VERSION,
            "abiVersion": 1,
            "transport": "app-server-ndjson",
        }))?;
        return Ok(());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    if let Err(error) = &result {
        // stdout remains NDJSON even when startup fails before the handshake.
        let _ = protocol::emit(&protocol::notification(
            "signalbox/error",
            serde_json::json!({ "message": format!("{error:#}") }),
        ));
    }
    result
}

async fn run() -> anyhow::Result<()> {
    let mut input = StdinLines::new().context("configure nonblocking stdin")?;
    let line = input.next_line().await?.context("missing bootstrap line")?;
    let bootstrap = Bootstrap::decode(&line)?;
    let client = Box::pin(startup::start(bootstrap)).await?;
    protocol::emit(&protocol::notification(
        "signalbox/ready",
        serde_json::json!({
            "upstreamVersion": UPSTREAM_VERSION,
            "engineVersion": env!("CARGO_PKG_VERSION"),
        }),
    ))?;
    bridge::run(client, input).await
}
