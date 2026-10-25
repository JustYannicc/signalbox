// signalbox: host-owned WebSocket messages use the existing WASI Tokio reactor.
mod abi;
mod codec;
mod transport;

use std::io;
use std::sync::Arc;

use codex_http_client::OutboundProxyRoute;
use rustls::ClientConfig;
use tokio_tungstenite::tungstenite::Error;
use tokio_tungstenite::tungstenite::handshake::client::{Request, Response};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

use crate::TcpNodelay;
use transport::{Direction, Host, Transport};

pub(crate) type HostConnection = Transport<abi::Socket>;

pub(crate) async fn connect(
    request: Request,
    config: WebSocketConfig,
    _tls_config: Option<Arc<ClientConfig>>,
    proxy_route: OutboundProxyRoute,
    _tcp_nodelay: TcpNodelay,
    _loopback_direct: bool,
) -> Result<(HostConnection, Response), Error> {
    // The host owns the network connection and default TLS; resolved proxy policy still applies.
    let custom_ca = ["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()));
    if !matches!(request.uri().scheme_str(), Some("ws" | "wss"))
        || !matches!(proxy_route, OutboundProxyRoute::Direct)
        || custom_ca
        || config.accept_unmasked_frames
    {
        return Err(Error::Io(io::Error::new(
            io::ErrorKind::Unsupported,
            "WASI host WebSocket requires resolved direct ws/wss; proxy, custom TLS/CA and unmasked-frame configuration are unsupported",
        )));
    }
    // This first host slice has fixed upper bounds, including when Tungstenite permits more.
    let frame = config
        .max_message_size
        .unwrap_or(codec::MAX_FRAME)
        .min(config.max_frame_size.unwrap_or(codec::MAX_FRAME))
        .min(codec::MAX_FRAME);
    let queue = config.max_write_buffer_size.min(codec::MAX_QUEUE);
    let request = codec::encode_request(&request, frame, queue)?;
    let socket = abi::Socket::open(&request, frame)?;
    let response =
        std::future::poll_fn(|cx| socket.poll(cx, Direction::Read, || socket.handshake())).await?;
    let response = codec::complete_handshake(response)?.map(|()| None);
    Ok((Transport::new(socket, frame), response))
}
