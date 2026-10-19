include!("parent_context.rs");
#[path = "../mod.rs"]
mod connector;

#[path = "../abi.rs"]
mod abi;
#[path = "../codec.rs"]
mod codec;
#[path = "../transport.rs"]
mod transport;

mod cancellation;
mod repeated;
mod protocol;

use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::Poll;

use futures::{SinkExt, Stream, StreamExt};
use tokio_tungstenite::tungstenite::{Message, http::Request};
use transport::{Direction, Host, Transport};

#[link(wasm_import_module = "signalbox_ws_probe")]
unsafe extern "C" {
    fn record(event: u32);
}
fn mark(event: u32) {
    unsafe { record(event) };
}

async fn open() -> abi::Socket {
    let request = Request::builder()
        .uri("ws://localhost/exec")
        .body(())
        .unwrap();
    let bytes = codec::encode_request(&request, codec::MAX_FRAME, codec::MAX_QUEUE).unwrap();
    let socket = abi::Socket::open(&bytes, codec::MAX_FRAME).unwrap();
    mark(1);
    let response = poll_fn(|cx| socket.poll(cx, Direction::Read, || socket.handshake()))
        .await
        .unwrap();
    let response = codec::complete_handshake(response).unwrap();
    assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
    mark(2);
    socket
}

#[unsafe(no_mangle)]
pub extern "C" fn probe(mode: u32) -> u32 {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .unwrap();
    runtime.block_on(async {
        if mode == 5 {
            protocol::run().await;
            return;
        }
        if mode == 1 {
            let mut connecting = Box::pin(open());
            poll_fn(|cx| {
                assert!(connecting.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            drop(connecting);
            mark(10);
            return;
        }
        let socket = open().await;
        if mode == 4 {
            repeated::run(socket).await;
            return;
        }
        if mode == 2 || mode == 3 {
            cancellation::run(socket, mode).await;
            return;
        }
        let (mut sink, mut stream) = Transport::new(socket, codec::MAX_FRAME).split();
        let (pending, wait_pending) = tokio::sync::oneshot::channel();
        let (received, wait_received) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            poll_fn(|cx| {
                assert!(Pin::new(&mut stream).poll_next(cx).is_pending());
                mark(3);
                Poll::Ready(())
            })
            .await;
            pending.send(()).unwrap();
            let reply = stream.next().await.unwrap().unwrap();
            assert_eq!(reply, Message::text("r".repeat(8192)));
            mark(6);
            received.send(()).unwrap();
        });
        let writer = tokio::spawn(async move {
            wait_pending.await.unwrap();
            sink.send(Message::text("initialize")).await.unwrap();
            mark(4);
            sink.send(Message::text("second")).await.unwrap();
            mark(5);
            wait_received.await.unwrap();
            sink.close().await.unwrap();
            mark(7);
        });
        reader.await.unwrap();
        writer.await.unwrap();
        mark(8);
    });
    drop(runtime);
    mark(9);
    0
}
