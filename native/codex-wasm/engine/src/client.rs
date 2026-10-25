use std::io;
use std::time::Duration;

use codex_app_server::in_process::{self, InProcessStartArgs};
use codex_app_server_client::{InProcessServerEvent, RequestResult};
use codex_app_server_protocol::{
    ClientNotification, ClientRequest, JSONRPCErrorError, RequestId, ServerRequest,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use crate::client_request::{Reply, complete_request};

const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(45);

enum Command {
    Request(Box<ClientRequest>, Reply<RequestResult>),
    Notify(ClientNotification, Reply<()>),
    Respond(RequestId, RequestResult, Reply<()>),
    Shutdown(Reply<()>),
}

#[derive(Clone)]
pub struct RequestHandle(mpsc::Sender<Command>);

impl RequestHandle {
    pub async fn request(&self, request: ClientRequest) -> io::Result<RequestResult> {
        let (reply, response) = oneshot::channel();
        self.0
            .send(Command::Request(Box::new(request), reply))
            .await
            .map_err(closed)?;
        response.await.map_err(closed)?
    }
}

// The upstream facade cannot accept extensions. Keep its lossless event drain
// and request cancellation rules around the public initialization port.
pub struct Client {
    commands: mpsc::Sender<Command>,
    events: mpsc::UnboundedReceiver<InProcessServerEvent>,
    worker: JoinHandle<()>,
}

impl Client {
    pub async fn start(args: InProcessStartArgs) -> io::Result<Self> {
        let capacity = args.channel_capacity.max(1);
        let mut runtime = in_process::start(args).await?;
        let sender = runtime.sender();
        let (commands, mut commands_rx) = mpsc::channel::<Command>(capacity);
        let (events_tx, events) = mpsc::unbounded_channel();
        let worker = tokio::spawn(async move {
            let mut event_stream_enabled = true;
            loop {
                tokio::select! {
                    command = commands_rx.recv() => match command {
                        Some(Command::Request(request, response)) => {
                            let sender = sender.clone();
                            tokio::spawn(async move {
                                let cancellable = matches!(*request,
                                    ClientRequest::UserVerificationStatus { .. }
                                    | ClientRequest::UserVerificationEnroll { .. }
                                    | ClientRequest::UserVerificationDelete { .. }
                                    | ClientRequest::UserVerificationVerify { .. });
                                complete_request(sender.request(*request), response, cancellable).await;
                            });
                        }
                        Some(Command::Notify(notification, response)) => {
                            let _ = response.send(sender.notify(notification));
                        }
                        Some(Command::Respond(id, result, response)) => {
                            let result = match result {
                                Ok(value) => sender.respond_to_server_request(id, value),
                                Err(error) => sender.fail_server_request(id, error),
                            };
                            let _ = response.send(result);
                        }
                        Some(Command::Shutdown(response)) => {
                            let _ = response.send(runtime.shutdown().await);
                            break;
                        }
                        None => {
                            let _ = runtime.shutdown().await;
                            break;
                        }
                    },
                    event = runtime.next_event(), if event_stream_enabled => {
                        let Some(event) = event else { break };
                        if let InProcessServerEvent::ServerRequest(request) = &event
                            && let ServerRequest::ChatgptAuthTokensRefresh { request_id, .. } = request.as_ref()
                        {
                            if let Err(error) = sender.fail_server_request(request_id.clone(), JSONRPCErrorError {
                                code: -32000,
                                message: "chatgpt auth token refresh is not supported for in-process app-server clients".to_owned(),
                                data: None,
                            }) {
                                eprintln!("failed to reject unsupported chatgpt auth token refresh request: {error}");
                            }
                            continue;
                        }
                        if events_tx.send(event).is_err() {
                            event_stream_enabled = false;
                        }
                    }
                }
            }
        });
        Ok(Self {
            commands,
            events,
            worker,
        })
    }

    pub fn request_handle(&self) -> RequestHandle {
        RequestHandle(self.commands.clone())
    }

    pub async fn notify(&self, notification: ClientNotification) -> io::Result<()> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::Notify(notification, reply))
            .await
            .map_err(closed)?;
        response.await.map_err(closed)?
    }

    pub async fn resolve_server_request(
        &self,
        id: RequestId,
        result: serde_json::Value,
    ) -> io::Result<()> {
        self.respond(id, Ok(result)).await
    }

    pub async fn reject_server_request(
        &self,
        id: RequestId,
        error: JSONRPCErrorError,
    ) -> io::Result<()> {
        self.respond(id, Err(error)).await
    }

    async fn respond(&self, id: RequestId, result: RequestResult) -> io::Result<()> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(Command::Respond(id, result, reply))
            .await
            .map_err(closed)?;
        response.await.map_err(closed)?
    }

    pub async fn next_event(&mut self) -> Option<InProcessServerEvent> {
        self.events.recv().await
    }

    pub async fn shutdown(self) -> io::Result<()> {
        let Self {
            commands,
            events,
            mut worker,
        } = self;
        drop(events);
        let (reply, response) = oneshot::channel();
        if commands.send(Command::Shutdown(reply)).await.is_ok()
            && let Ok(result) = tokio::time::timeout(SHUTDOWN_TIMEOUT, response).await
        {
            result.map_err(closed)??;
        }
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, &mut worker)
            .await
            .is_err()
        {
            worker.abort();
            let _ = worker.await;
        }
        Ok(())
    }
}

fn closed(error: impl std::fmt::Display) -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        format!("in-process client channel closed: {error}"),
    )
}
