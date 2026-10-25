use std::future::{Future, poll_fn};
use std::task::Poll;

use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::{abi, codec, mark, transport::Transport};

pub(crate) async fn run(socket: abi::Socket, mode: u32) {
    let (mut sink, mut stream) = Transport::new(socket, codec::MAX_FRAME).split();
    if mode == 2 {
        let mut next = Box::pin(stream.next());
        poll_fn(|cx| {
            assert!(next.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(next);
        mark(12);
        // A read frame arrives while send credit is exhausted. The canceled
        // next() must not keep that readable direction in the reactor forever.
        sink.send(Message::text("initialize")).await.unwrap();
        mark(4);
        let reply = stream.next().await.unwrap().unwrap();
        assert_eq!(reply, Message::text("r".repeat(8192)));
        mark(6);
    } else {
        let mut sending = Box::pin(sink.send(Message::text("initialize")));
        poll_fn(|cx| {
            assert!(sending.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(sending);
        mark(13);
        // Credit arrives while an independent receive remains pending. The
        // abandoned send waiter must not repeatedly wake the level selector.
        let reply = stream.next().await.unwrap().unwrap();
        assert_eq!(reply, Message::text("r".repeat(8192)));
        mark(6);
        sink.flush().await.unwrap();
        mark(4);
    }
    sink.send(Message::text("second")).await.unwrap();
    mark(5);
    sink.close().await.unwrap();
    mark(7);
    drop(stream);
    drop(sink);
    mark(8);
    mark(14);
}
