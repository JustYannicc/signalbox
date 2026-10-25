//! Compile/link coverage only. The proof never supplies a working HTTP host.
use std::error::Error;
use std::sync::Arc;

fn main() -> Result<(), Box<dyn Error>> {
    let client = reqwest::Client::builder()
        .cookie_provider(Arc::new(reqwest::cookie::Jar::default()))
        .redirect(reqwest::redirect::Policy::none())
        .proxy(reqwest::Proxy::all("http://proxy.invalid")?)
        .use_preconfigured_tls(())
        .build()?;
    let request = client.post("https://example.invalid/")
        .json(&serde_json::json!({"compileOnly": true}))
        .build()?;
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build()?;
    runtime.block_on(async {
        let mut response = client.execute(request).await?;
        let _ = response.status();
        let _ = response.chunk().await?;
        Ok::<_, reqwest::Error>(())
    })?;
    let blocking = reqwest::blocking::Client::builder().build()?;
    let _ = blocking.execute(reqwest::Request::new(reqwest::Method::GET,
        "https://example.invalid/".parse()?))?;
    Ok(())
}
