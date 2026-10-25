use base64::{Engine, engine::general_purpose::STANDARD};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::{Message, http::Request, protocol::WebSocketConfig};

use crate::{connector, mark, OutboundProxyRoute, TcpNodelay};

const PROCESS_ID: &str = "kernel-proof-process";
const OUTPUT: &[u8] = b"kernel-proof";

async fn send(transport: &mut connector::HostConnection, message: Value) {
    transport.send(Message::text(message.to_string())).await.unwrap();
}

async fn receive(transport: &mut connector::HostConnection) -> Value {
    let message = transport.next().await.expect("endpoint closed early").unwrap();
    assert!(message.is_text(), "endpoint returned a non-text JSON message");
    let value: Value = serde_json::from_str(message.to_text().unwrap()).unwrap();
    assert!(value.get("error").is_none(), "endpoint RPC error: {value}");
    value
}

fn chunks(value: &Value) -> Vec<u8> {
    let mut output = Vec::new();
    for entry in value["chunks"].as_array().unwrap() {
        let bytes = STANDARD.decode(entry["chunk"].as_str().unwrap()).unwrap();
        assert_eq!(entry["stream"], "stdout");
        output.extend(bytes);
    }
    output
}

pub(crate) async fn run() {
    let request = Request::builder().uri("ws://localhost/exec")
        .header("Upgrade", "websocket").body(()).unwrap();
    let (mut transport, response) = connector::connect(request, WebSocketConfig::default(),
        None, OutboundProxyRoute::Direct, TcpNodelay::Default, false).await.unwrap();
    let response: tokio_tungstenite::tungstenite::handshake::client::Response = response;
    assert_eq!(response.status(), 101);
    assert!(response.body().is_none());
    send(&mut transport, json!({"id":1,"method":"initialize","params":{"clientName":"kernel-proof"}})).await;
    mark(20);
    let initialized = receive(&mut transport).await;
    assert_eq!(initialized["id"], 1);
    assert!(initialized["result"]["sessionId"].as_str().is_some());
    assert_eq!(initialized["result"]["environmentInfo"]["capabilities"]["tty"], false);
    send(&mut transport, json!({"method":"initialized","params":{}})).await;
    mark(21);
    send(&mut transport, json!({"id":2,"method":"process/start","params":{
        "processId":PROCESS_ID,"argv":["/bin/proof"],"cwd":"file:///workspace","env":{},"tty":false
    }})).await;
    mark(22);
    let (mut started, mut exited, mut closed) = (false, false, false);
    let mut output = Vec::new();
    for _ in 0..128 {
        let message = receive(&mut transport).await;
        if message["id"] == 2 {
            assert!(!started, "duplicate start response");
            started = true;
        } else {
            let params = &message["params"];
            assert_eq!(params["processId"], PROCESS_ID);
            match message["method"].as_str().unwrap() {
                "process/output" => {
                    assert_eq!(params["stream"], "stdout");
                    output.extend(STANDARD.decode(params["chunk"].as_str().unwrap()).unwrap());
                    mark(23);
                }
                "process/exited" => {
                    assert!(!exited, "duplicate exit notification");
                    assert_eq!(params["exitCode"], 17);
                    exited = true;
                    mark(24);
                }
                "process/closed" => {
                    assert!(!closed, "duplicate closed notification");
                    closed = true;
                    mark(25);
                }
                method => panic!("unexpected endpoint notification: {method}"),
            }
        }
        if started && exited && closed { break; }
    }
    assert!(started && exited && closed, "missing endpoint milestones");
    assert_eq!(output, OUTPUT);
    send(&mut transport, json!({"id":3,"method":"process/read","params":{"processId":PROCESS_ID}})).await;
    let read = receive(&mut transport).await;
    assert_eq!(read["id"], 3);
    let result = &read["result"];
    assert_eq!(result["exited"], true);
    assert_eq!(result["closed"], true);
    assert_eq!(result["exitCode"], 17);
    assert_eq!(chunks(result), OUTPUT);
    mark(26);
    transport.close().await.unwrap();
    mark(27);
    drop(transport);
    mark(28);
}
