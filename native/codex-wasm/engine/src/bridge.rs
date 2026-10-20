use std::collections::BTreeSet;
use std::io;
use std::time::Duration;

use anyhow::Context;
use codex_app_server_client::InProcessServerEvent;
use codex_app_server_client::RequestResult;
use codex_app_server_protocol::ClientNotification;
use codex_app_server_protocol::ClientRequest;
use codex_app_server_protocol::JSONRPCMessage;
use codex_app_server_protocol::RequestId;
use futures::StreamExt;
use futures::future::LocalBoxFuture;
use futures::stream::FuturesUnordered;
use serde_json::json;
use tokio::time::Instant;

use crate::client::Client;
use crate::input::StdinLines;
use crate::protocol;

const MAX_PENDING_REQUESTS: usize = 128;
const INTERRUPT_RESERVE: usize = 8;
const EOF_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
type PendingResponse = LocalBoxFuture<'static, (RequestId, io::Result<RequestResult>)>;

pub async fn run(mut client: Client, mut input: StdinLines) -> anyhow::Result<()> {
    let result = forward(&mut client, &mut input).await;
    let shutdown = client
        .shutdown()
        .await
        .context("shutdown in-process Codex app-server");
    result.and(shutdown)
}

async fn forward(client: &mut Client, input: &mut StdinLines) -> anyhow::Result<()> {
    let mut pending = FuturesUnordered::<PendingResponse>::new();
    let mut pending_ids = BTreeSet::new();
    let mut eof_deadline = None;
    loop {
        if eof_deadline.is_some() && pending.is_empty() {
            return Ok(());
        }
        tokio::select! {
            line = input.next_line(), if eof_deadline.is_none() => {
                let Some(line) = line.context("read engine stdin")? else {
                    // Permit piped model/list calls to finish after their last line.
                    // Missing approval responses still cannot hold shutdown forever.
                    eof_deadline = Some(Instant::now() + EOF_DRAIN_TIMEOUT);
                    continue;
                };
                let message = match protocol::decode_message(&line) {
                    Ok(message) => message,
                    Err(error) => {
                        protocol::emit(&error)?;
                        continue;
                    }
                };
                match message {
                    JSONRPCMessage::Request(request) => {
                        let id = request.id.clone();
                        if request.method == "initialize" {
                            protocol::emit(&protocol::error(Some(&id), -32600, "engine is already initialized; wait for signalbox/ready"))?;
                            continue;
                        }
                        let request = match ClientRequest::try_from(request) {
                            Ok(request) => request,
                            Err(error) => {
                                protocol::emit(&protocol::error(Some(&id), -32602, format!("invalid or unsupported app-server request: {error}")))?;
                                continue;
                            }
                        };
                        let interrupt = matches!(&request, ClientRequest::TurnInterrupt { .. });
                        if let Err(error) = admit_request(&mut pending_ids, &id, interrupt) {
                            protocol::emit(&error)?;
                            continue;
                        }
                        let handle = client.request_handle();
                        // Await responses outside dispatch: thread/start and turns may
                        // need an incoming approval response or turn/interrupt first.
                        pending.push(Box::pin(async move {
                            let result = handle.request(request).await;
                            (id, result)
                        }));
                    }
                    JSONRPCMessage::Notification(notification) => {
                        match serde_json::from_value::<ClientNotification>(serde_json::to_value(notification)?) {
                            Ok(notification) => client.notify(notification).await.context("forward client notification")?,
                            Err(error) => protocol::emit(&protocol::notification("signalbox/error", json!({
                                "message": format!("invalid or unsupported client notification: {error}"),
                            })))?,
                        }
                    }
                    JSONRPCMessage::Response(response) => {
                        client.resolve_server_request(response.id, response.result).await.context("resolve server request")?;
                    }
                    JSONRPCMessage::Error(response) => {
                        client.reject_server_request(response.id, response.error).await.context("reject server request")?;
                    }
                }
            }
            Some((id, result)) = pending.next(), if !pending.is_empty() => {
                pending_ids.remove(&id);
                let response = match result {
                    Ok(Ok(result)) => json!({ "id": id, "result": result }),
                    Ok(Err(error)) => json!({ "id": id, "error": error }),
                    Err(error) => protocol::error(Some(&id), -32603, format!("app-server transport: {error}")),
                };
                protocol::emit(&response)?;
            }
            event = client.next_event() => {
                match event.context("in-process app-server event stream closed")? {
                    InProcessServerEvent::ServerNotification(notification) => protocol::emit(&notification)?,
                    InProcessServerEvent::ServerRequest(request) => protocol::emit(&request)?,
                    InProcessServerEvent::Lagged { skipped } => protocol::emit(&protocol::notification("signalbox/lagged", json!({ "skipped": skipped })))?,
                }
            }
            _ = tokio::time::sleep_until(eof_deadline.unwrap_or_else(Instant::now)), if eof_deadline.is_some() => {
                for id in &pending_ids {
                    protocol::emit(&protocol::error(Some(id), -32000, "stdin closed before app-server response"))?;
                }
                return Ok(());
            }
        }
    }
}

fn admit_request(
    pending_ids: &mut BTreeSet<RequestId>,
    id: &RequestId,
    interrupt: bool,
) -> Result<(), serde_json::Value> {
    if pending_ids.contains(id) {
        return Err(protocol::error(
            Some(id),
            -32600,
            "duplicate in-flight request id",
        ));
    }
    // A full ordinary-request budget must not prevent stopping a stuck turn.
    let limit = MAX_PENDING_REQUESTS + if interrupt { INTERRUPT_RESERVE } else { 0 };
    if pending_ids.len() >= limit {
        return Err(protocol::error(
            Some(id),
            -32001,
            "too many in-flight requests",
        ));
    }
    pending_ids.insert(id.clone());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_ids_cannot_replace_a_waiting_request() {
        let mut pending = BTreeSet::new();
        let id = RequestId::Integer(1);
        admit_request(&mut pending, &id, false).unwrap();
        assert_eq!(
            admit_request(&mut pending, &id, false).unwrap_err()["error"]["code"],
            -32600
        );
        assert_eq!(pending.len(), 1);
        pending.remove(&id);
        assert!(admit_request(&mut pending, &id, false).is_ok());
    }

    #[test]
    fn bounds_requests_and_releases_capacity_after_completion() {
        let mut pending = BTreeSet::new();
        for id in 0..MAX_PENDING_REQUESTS {
            admit_request(&mut pending, &RequestId::Integer(id as i64), false).unwrap();
        }
        let extra = RequestId::String("extra".to_owned());
        assert_eq!(
            admit_request(&mut pending, &extra, false).unwrap_err()["error"]["code"],
            -32001
        );
        pending.remove(&RequestId::Integer(0));
        assert!(admit_request(&mut pending, &extra, false).is_ok());
        assert_eq!(pending.len(), MAX_PENDING_REQUESTS);
    }

    #[test]
    fn interrupts_have_bounded_capacity_when_ordinary_requests_are_full() {
        let mut pending = BTreeSet::new();
        for id in 0..MAX_PENDING_REQUESTS {
            admit_request(&mut pending, &RequestId::Integer(id as i64), false).unwrap();
        }
        for id in 0..INTERRUPT_RESERVE {
            let id = RequestId::String(format!("interrupt-{id}"));
            assert!(admit_request(&mut pending, &id, true).is_ok());
        }
        let extra = RequestId::String("extra".to_owned());
        assert_eq!(
            admit_request(&mut pending, &extra, true).unwrap_err()["error"]["code"],
            -32001
        );
    }
}
