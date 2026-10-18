use std::sync::Arc;

use anyhow::Context;
use codex_app_server_client::DEFAULT_IN_PROCESS_CHANNEL_CAPACITY;
use codex_app_server_client::EmbeddedNetworkPolicy;
use codex_app_server_client::EnvironmentManager;
use codex_app_server_client::ExecServerRuntimeOptions;
use codex_app_server_client::InProcessAppServerClient;
use codex_app_server_client::InProcessClientStartArgs;
use codex_app_server_protocol::ConfigWarningNotification;
use codex_arg0::Arg0DispatchPaths;
use codex_config::CloudConfigBundleLoader;
use codex_config::LoaderOverrides;
use codex_core::config::ConfigBuilder;
use codex_core::config::ConfigOverrides;
use codex_feedback::CodexFeedback;
use codex_protocol::protocol::SessionSource;

use crate::UPSTREAM_VERSION;
use crate::protocol::Bootstrap;

pub async fn start(bootstrap: Bootstrap) -> anyhow::Result<InProcessAppServerClient> {
    std::env::set_current_dir(&bootstrap.cwd).context("set engine working directory")?;
    std::fs::create_dir_all(&bootstrap.codex_home).context("create engine Codex home")?;

    // Core requires an absolute self path even for listing models. The engine
    // never runs arg0 dispatch; platform helper execution belongs to the host port.
    let self_exe = std::env::current_exe().context("resolve engine executable")?;
    let arg0_paths = Arg0DispatchPaths {
        codex_self_exe: Some(self_exe.clone()),
        ..Default::default()
    };
    let cli_overrides: Vec<_> = bootstrap.overrides.into_iter().collect();
    let loader_overrides = LoaderOverrides::default();
    let cloud_config_bundle = CloudConfigBundleLoader::default();
    let embedded_network_policy = EmbeddedNetworkPolicy::load(&loader_overrides).await;
    let mut config = ConfigBuilder::default()
        .codex_home(bootstrap.codex_home)
        .cli_overrides(cli_overrides.clone())
        .harness_overrides(ConfigOverrides {
            cwd: Some(bootstrap.cwd),
            codex_self_exe: Some(self_exe),
            ..Default::default()
        })
        .loader_overrides(loader_overrides.clone())
        .cloud_config_bundle(cloud_config_bundle.clone())
        .build()
        .await
        .context("load inherited Codex configuration")?;
    embedded_network_policy.activate(&mut config);

    // Do not fall back to a stateless runtime when SQLite is unsupported.
    let state_db = codex_rollout::state_db::try_init(&config)
        .await
        .context("Codex state backend unavailable; the WASI port must support SQLite")?;
    let runtime_paths = ExecServerRuntimeOptions::from_optional_paths(
        arg0_paths.codex_self_exe.clone(),
        arg0_paths.codex_linux_sandbox_exe.clone(),
    )?;
    #[cfg(target_os = "macos")]
    let runtime_paths = runtime_paths.with_allowed_symlinked_codex_home(
        codex_config::allowed_symlinked_codex_home(&config.config_layer_stack, &config.codex_home),
    );
    let environment_manager = EnvironmentManager::from_codex_home(
        &config.codex_home,
        Some(runtime_paths),
        embedded_network_policy.bind(config.http_client_factory()),
    )
    .await
    .context("load configured execution environments")?;
    let config_warnings = config
        .startup_warnings
        .iter()
        .map(|warning| ConfigWarningNotification {
            summary: warning.clone(),
            details: None,
            path: None,
            range: None,
        })
        .collect();

    InProcessAppServerClient::start(InProcessClientStartArgs {
        arg0_paths,
        config: Arc::new(config),
        cli_overrides,
        loader_overrides,
        strict_config: false,
        cloud_config_bundle,
        embedded_network_policy,
        feedback: CodexFeedback::new(),
        log_db: None,
        state_db: Some(state_db),
        environment_manager: Arc::new(environment_manager),
        config_warnings,
        session_source: SessionSource::Exec,
        enable_codex_api_key_env: true,
        client_name: "signalbox-codex-engine".to_owned(),
        client_version: UPSTREAM_VERSION.to_owned(),
        experimental_api: true,
        mcp_server_openai_form_elicitation: false,
        opt_out_notification_methods: Vec::new(),
        channel_capacity: DEFAULT_IN_PROCESS_CHANNEL_CAPACITY,
    })
    .await
    .context("start in-process Codex app-server and initialize")
}
