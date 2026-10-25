use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;

use anyhow::Context;
use codex_app_server_protocol::ClientInfo;
use codex_app_server_protocol::InitializeCapabilities;
use codex_app_server_protocol::InitializeParams;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::RequestId;
use codex_protocol::mcp::OPENAI_STANDARD_FORM_INPUT_EXTENSION_ID;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bootstrap {
    #[serde(rename = "type")]
    _kind: BootstrapKind,
    pub codex_home: PathBuf,
    pub cwd: PathBuf,
    #[serde(default)]
    pub overrides: BTreeMap<String, toml::Value>,
    #[serde(default, deserialize_with = "decode_host_capabilities")]
    pub host_capabilities: HostCapabilities,
}

fn decode_host_capabilities<'de, D>(deserializer: D) -> Result<HostCapabilities, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let fields = serde_json::Map::<String, Value>::deserialize(deserializer)?;
    serde_json::from_value(Value::Object(fields)).map_err(serde::de::Error::custom)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct HostCapabilities {
    #[serde(default)]
    pub standard_form_input: bool,
}

impl HostCapabilities {
    pub fn initialize_params(self, upstream_version: &str) -> InitializeParams {
        InitializeParams {
            client_info: ClientInfo {
                name: "signalbox-codex-engine".to_owned(),
                title: None,
                version: upstream_version.to_owned(),
            },
            capabilities: Some(InitializeCapabilities {
                explicit_gateway_oauth: false,
                experimental_api: true,
                request_attestation: false,
                mcp_server_openai_form_elicitation: false,
                opt_out_notification_methods: None,
                extensions: self.standard_form_input.then(|| {
                    std::collections::HashMap::from([(
                        OPENAI_STANDARD_FORM_INPUT_EXTENSION_ID.to_owned(),
                        json!({}),
                    )])
                }),
            }),
        }
    }
}

#[derive(Debug, Deserialize)]
enum BootstrapKind {
    #[serde(rename = "bootstrap")]
    Bootstrap,
}

impl Bootstrap {
    pub fn decode(line: &[u8]) -> anyhow::Result<Self> {
        let bootstrap: Self = serde_json::from_slice(line).context("decode bootstrap object")?;
        anyhow::ensure!(
            bootstrap.codex_home.is_absolute(),
            "codex_home must be absolute"
        );
        anyhow::ensure!(bootstrap.cwd.is_absolute(), "cwd must be absolute");
        anyhow::ensure!(
            bootstrap.overrides.keys().all(|key| !key.trim().is_empty()),
            "override keys must not be empty"
        );
        Ok(bootstrap)
    }
}

pub fn emit(value: &impl Serialize) -> std::io::Result<()> {
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, value)?;
    output.write_all(b"\n")?;
    output.flush()
}

pub fn notification(method: &str, params: Value) -> Value {
    json!({ "method": method, "params": params })
}

pub fn error(id: Option<&RequestId>, code: i64, message: impl Into<String>) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message.into() } })
}

pub fn decode_message(line: &[u8]) -> Result<JSONRPCMessage, Value> {
    let value: Value = serde_json::from_slice(line)
        .map_err(|err| error(None, -32700, format!("invalid JSON: {err}")))?;
    let id = value
        .get("id")
        .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok());
    let invalid = || error(id.as_ref(), -32600, "invalid app-server message envelope");
    let object = value.as_object().ok_or_else(invalid)?;
    let has_id = object.contains_key("id");
    if has_id && id.is_none() {
        return Err(invalid());
    }
    // Untagged upstream decoding otherwise accepts a malformed response as a
    // notification, or silently ignores an error alongside a result.
    let message = if object.contains_key("method") {
        if !value["method"].is_string()
            || object.contains_key("result")
            || object.contains_key("error")
        {
            return Err(invalid());
        }
        if has_id {
            serde_json::from_value(value).map(JSONRPCMessage::Request)
        } else {
            serde_json::from_value(value).map(JSONRPCMessage::Notification)
        }
    } else if has_id && object.contains_key("result") != object.contains_key("error") {
        if object.contains_key("result") {
            serde_json::from_value(value).map(JSONRPCMessage::Response)
        } else {
            serde_json::from_value(value).map(JSONRPCMessage::Error)
        }
    } else {
        return Err(invalid());
    };
    message.map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_preserves_typed_config_overrides() {
        let bootstrap = Bootstrap::decode(br#"{"type":"bootstrap","codex_home":"/home/codex","cwd":"/work","overrides":{"model":"example","features.web_search":false,"model_context_window":8192}}"#).unwrap();
        assert_eq!(bootstrap.overrides["model"].as_str(), Some("example"));
        assert_eq!(
            bootstrap.overrides["features.web_search"].as_bool(),
            Some(false)
        );
        assert_eq!(
            bootstrap.overrides["model_context_window"].as_integer(),
            Some(8192)
        );
    }

    #[test]
    fn undeclared_host_capabilities_stay_disabled() {
        let bootstrap =
            Bootstrap::decode(br#"{"type":"bootstrap","codex_home":"/home/codex","cwd":"/work"}"#)
                .unwrap();
        assert_eq!(bootstrap.host_capabilities, HostCapabilities::default());
        let initialize = bootstrap.host_capabilities.initialize_params("test");
        let capabilities = initialize.capabilities.unwrap();
        assert!(capabilities.extensions.is_none());
        assert!(!capabilities.mcp_server_openai_form_elicitation);
        assert_eq!(
            serde_json::to_value(bootstrap.host_capabilities).unwrap(),
            json!({"standard_form_input": false})
        );
    }

    #[test]
    fn declared_form_support_initializes_only_the_standard_extension() {
        let bootstrap = Bootstrap::decode(br#"{"type":"bootstrap","codex_home":"/home/codex","cwd":"/work","host_capabilities":{"standard_form_input":true}}"#).unwrap();
        let initialize =
            serde_json::to_value(bootstrap.host_capabilities.initialize_params("test")).unwrap();
        assert_eq!(
            initialize["capabilities"]["extensions"],
            json!({"openai/standard-form-input": {}})
        );
        assert_eq!(initialize["capabilities"]["experimentalApi"], true);
        assert_eq!(initialize["capabilities"]["requestAttestation"], false);
        assert!(
            initialize["capabilities"]
                .get("mcpServerOpenaiFormElicitation")
                .is_none()
        );
        assert_eq!(
            serde_json::to_value(bootstrap.host_capabilities).unwrap(),
            json!({"standard_form_input": true})
        );
    }

    #[test]
    fn empty_or_explicitly_disabled_host_capabilities_stay_disabled() {
        for capabilities in [json!({}), json!({"standard_form_input": false})] {
            let value = json!({"type":"bootstrap","codex_home":"/home/codex","cwd":"/work","host_capabilities":capabilities});
            let bootstrap = Bootstrap::decode(&serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(bootstrap.host_capabilities, HostCapabilities::default());
            let initialize = bootstrap.host_capabilities.initialize_params("test");
            assert!(initialize.capabilities.unwrap().extensions.is_none());
        }
    }

    #[test]
    fn rejects_unknown_or_malformed_host_capabilities() {
        for capabilities in [
            json!([true]),
            json!([false]),
            json!([]),
            json!({"standard_form_input": "true"}),
            json!({"standard_form_input": true, "approval_policy": "never"}),
            json!({"extensions": {"openai/form": {}}}),
            json!(null),
        ] {
            let value = json!({"type":"bootstrap","codex_home":"/home/codex","cwd":"/work","host_capabilities":capabilities});
            assert!(Bootstrap::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        }
    }

    #[test]
    fn bootstrap_rejects_wrong_first_message_and_relative_paths() {
        for line in [
            r#"{"id":1,"method":"initialize","params":{}}"#,
            r#"{"type":"bootstrap","codex_home":"relative","cwd":"/work"}"#,
            r#"{"type":"bootstrap","codex_home":"/home/codex","cwd":"relative"}"#,
            r#"{"type":"bootstrap","codex_home":"/home/codex","cwd":"/work","overrides":{"model":null}}"#,
        ] {
            assert!(Bootstrap::decode(line.as_bytes()).is_err(), "{line}");
        }
    }

    #[test]
    fn preserves_request_ids_and_null_successful_results() {
        let JSONRPCMessage::Response(response) =
            decode_message(br#"{"id":"approval-1","result":null}"#).unwrap()
        else {
            panic!("expected response");
        };
        assert_eq!(response.id, RequestId::String("approval-1".to_owned()));
        assert_eq!(response.result, Value::Null);
        assert!(matches!(
            decode_message(br#"{"id":7,"method":"model/list","params":{}}"#).unwrap(),
            JSONRPCMessage::Request(_)
        ));
        assert!(matches!(
            decode_message(br#"{"id":"approval-1","error":{"code":-32000,"message":"declined"}}"#)
                .unwrap(),
            JSONRPCMessage::Error(_)
        ));
        assert!(matches!(
            decode_message(br#"{"method":"initialized"}"#).unwrap(),
            JSONRPCMessage::Notification(_)
        ));
    }

    #[test]
    fn rejects_ambiguous_and_invalid_envelopes() {
        for line in [
            r#"{"id":1,"result":{},"error":{"code":1,"message":"bad"}}"#,
            r#"{"id":null,"method":"model/list"}"#,
            r#"{"method":12}"#,
            r#"{"id":1,"method":"model/list","result":{}}"#,
            r#"{"id":1}"#,
            r#"[]"#,
        ] {
            assert_eq!(
                decode_message(line.as_bytes()).unwrap_err()["error"]["code"],
                -32600,
                "{line}"
            );
        }
        assert_eq!(decode_message(b"{").unwrap_err()["error"]["code"], -32700);
    }
}
