use std::future::poll_fn;
use std::pin::Pin;
use std::task::Poll;

use futures::{SinkExt, Stream, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::{abi, codec, mark, transport::Transport};

pub(crate) async fn run(socket: abi::Socket) {
    let (mut sink, mut stream) = Transport::new(socket, codec::MAX_FRAME).split();
    let (pending, wait_pending) = tokio::sync::oneshot::channel();
    let (received, wait_received) = tokio::sync::oneshot::channel();
    let (closed, wait_closed) = tokio::sync::oneshot::channel();
    let reader = tokio::spawn(async move {
        poll_fn(|cx| {
            assert!(Pin::new(&mut stream).poll_next(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        pending.send(()).unwrap();
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            Message::text("r".repeat(8192))
        );
        mark(6);
        received.send(()).unwrap();
        // Leave another readable frame queued while the other task waits for
        // close completion. Readability without demand must not spin the reactor.
        wait_closed.await.unwrap();
        assert_eq!(
            stream.next().await.unwrap().unwrap(),
            Message::text("r".repeat(8192))
        );
        mark(15);
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
        closed.send(()).unwrap();
    });
    reader.await.unwrap();
    writer.await.unwrap();
    mark(8);
}
