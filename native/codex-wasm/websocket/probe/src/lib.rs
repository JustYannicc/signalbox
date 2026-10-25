#[path = "../../codec.rs"]
mod codec;
#[path = "../../transport.rs"]
mod transport;

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::pin::Pin;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use std::task::{Context, Poll, Wake, Waker};

    use crate::transport::{Direction, Host, Transport};
    use futures::{Sink, Stream};
    use tokio_tungstenite::tungstenite::Message;

    #[derive(Default)]
    struct State {
        receive: Mutex<VecDeque<Option<Message>>>,
        sent: Mutex<Vec<Message>>,
        read: Mutex<Option<Waker>>,
        write: Mutex<Option<Waker>>,
        blocked: AtomicBool,
        send_race: AtomicBool,
        closing: AtomicBool,
        flushed: AtomicBool,
        early: AtomicBool,
        owners: AtomicUsize,
        releases: AtomicUsize,
        final_closes: AtomicUsize,
    }
    struct Mock(Arc<State>);
    impl Mock {
        fn new(state: Arc<State>) -> Self {
            state.owners.fetch_add(1, Ordering::SeqCst);
            Self(state)
        }
    }
    impl Drop for Mock {
        fn drop(&mut self) {
            self.0.releases.fetch_add(1, Ordering::SeqCst);
            if self.0.owners.fetch_sub(1, Ordering::SeqCst) == 1 {
                self.0.final_closes.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    fn again<T>() -> io::Result<T> {
        Err(io::ErrorKind::WouldBlock.into())
    }
    impl Host for Mock {
        fn poll<T>(
            &self,
            cx: &mut Context<'_>,
            direction: Direction,
            mut operation: impl FnMut() -> io::Result<T>,
        ) -> Poll<io::Result<T>> {
            let slot = match direction {
                Direction::Read => &self.0.read,
                Direction::Write => &self.0.write,
            };
            *slot.lock().unwrap() = Some(cx.waker().clone());
            if self.0.early.swap(false, Ordering::SeqCst) {
                self.0
                    .receive
                    .lock()
                    .unwrap()
                    .push_back(Some(Message::text("early")));
                cx.waker().wake_by_ref();
            }
            match operation() {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => Poll::Pending,
                result => Poll::Ready(result),
            }
        }
        fn receive(&self) -> io::Result<Option<Message>> {
            self.0
                .receive
                .lock()
                .unwrap()
                .pop_front()
                .map(Ok)
                .unwrap_or_else(again)
        }
        fn ready(&self) -> io::Result<()> {
            if self.0.blocked.load(Ordering::SeqCst) {
                again()
            } else {
                Ok(())
            }
        }
        fn send(&self, message: &Message) -> io::Result<()> {
            if self.0.send_race.swap(false, Ordering::SeqCst)
                || self.0.blocked.load(Ordering::SeqCst)
            {
                return again();
            }
            self.0.sent.lock().unwrap().push(message.clone());
            Ok(())
        }
        fn flush(&self) -> io::Result<()> {
            if self.0.flushed.load(Ordering::SeqCst) {
                Ok(())
            } else {
                again()
            }
        }
        fn close(&self) -> io::Result<()> {
            if self.0.closing.load(Ordering::SeqCst) {
                Ok(())
            } else {
                again()
            }
        }
    }
    #[derive(Default)]
    struct Count(AtomicUsize);
    impl Wake for Count {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn fixture() -> (Transport<Mock>, Arc<State>, Arc<Count>, Waker) {
        let state = Arc::new(State::default());
        let count = Arc::new(Count::default());
        let waker = Waker::from(count.clone());
        (
            Transport::new(Mock::new(state.clone()), 1024),
            state,
            count,
            waker,
        )
    }

    #[test]
    fn pending_receive_does_not_block_initialize_send() {
        let (mut transport, state, _, waker) = fixture();
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut transport).poll_next(&mut cx).is_pending());
        assert!(matches!(
            Pin::new(&mut transport).poll_ready(&mut cx),
            Poll::Ready(Ok(()))
        ));
        Pin::new(&mut transport)
            .start_send(Message::text(r#"{"method":"initialize"}"#))
            .unwrap();
        assert_eq!(state.sent.lock().unwrap().len(), 1);
        state
            .receive
            .lock()
            .unwrap()
            .push_back(Some(Message::text("reply")));
        state.read.lock().unwrap().take().unwrap().wake();
        assert!(matches!(
            Pin::new(&mut transport).poll_next(&mut cx),
            Poll::Ready(Some(Ok(Message::Text(_))))
        ));
    }

    #[test]
    fn early_wake_is_observed_without_selfwake_or_sleep() {
        let (mut transport, state, count, waker) = fixture();
        state.early.store(true, Ordering::SeqCst);
        let mut cx = Context::from_waker(&waker);
        assert!(matches!(
            Pin::new(&mut transport).poll_next(&mut cx),
            Poll::Ready(Some(Ok(Message::Text(_))))
        ));
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
        assert!(Pin::new(&mut transport).poll_next(&mut cx).is_pending());
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn eagain_retains_exact_frame_and_order_until_credit_returns() {
        let (mut transport, state, _, waker) = fixture();
        let mut cx = Context::from_waker(&waker);
        state.send_race.store(true, Ordering::SeqCst);
        Pin::new(&mut transport)
            .start_send(Message::text("first"))
            .unwrap();
        state.blocked.store(true, Ordering::SeqCst);
        assert!(Pin::new(&mut transport).poll_ready(&mut cx).is_pending());
        assert!(
            Pin::new(&mut transport)
                .start_send(Message::text("lost"))
                .is_err()
        );
        state.blocked.store(false, Ordering::SeqCst);
        state.write.lock().unwrap().take().unwrap().wake();
        assert!(matches!(
            Pin::new(&mut transport).poll_ready(&mut cx),
            Poll::Ready(Ok(()))
        ));
        Pin::new(&mut transport)
            .start_send(Message::text("second"))
            .unwrap();
        assert_eq!(
            *state.sent.lock().unwrap(),
            vec![Message::text("first"), Message::text("second")]
        );
    }

    #[test]
    fn flush_and_close_wait_for_host_progress_and_close_is_idempotent() {
        let (mut transport, state, _, waker) = fixture();
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut transport).poll_flush(&mut cx).is_pending());
        state.flushed.store(true, Ordering::SeqCst);
        assert!(matches!(
            Pin::new(&mut transport).poll_flush(&mut cx),
            Poll::Ready(Ok(()))
        ));
        assert!(Pin::new(&mut transport).poll_close(&mut cx).is_pending());
        assert!(
            Pin::new(&mut transport)
                .start_send(Message::text("late"))
                .is_err()
        );
        state.closing.store(true, Ordering::SeqCst);
        assert!(matches!(
            Pin::new(&mut transport).poll_close(&mut cx),
            Poll::Ready(Ok(()))
        ));
        assert!(matches!(
            Pin::new(&mut transport).poll_close(&mut cx),
            Poll::Ready(Ok(()))
        ));
    }

    #[test]
    fn eof_is_fused_and_cancellation_releases_only_its_descriptor() {
        let (mut transport, state, _, waker) = fixture();
        let duplicate = Mock::new(state.clone());
        let mut cx = Context::from_waker(&waker);
        state.receive.lock().unwrap().push_back(None);
        assert!(matches!(
            Pin::new(&mut transport).poll_next(&mut cx),
            Poll::Ready(None)
        ));
        assert!(matches!(
            Pin::new(&mut transport).poll_next(&mut cx),
            Poll::Ready(None)
        ));
        drop(transport);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
        assert_eq!(state.final_closes.load(Ordering::SeqCst), 0);
        drop(duplicate);
        assert_eq!(state.final_closes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn cancellation_with_pending_io_releases_once_without_waiting_for_a_reply() {
        let (mut transport, state, _, waker) = fixture();
        let mut cx = Context::from_waker(&waker);
        assert!(Pin::new(&mut transport).poll_next(&mut cx).is_pending());
        state.send_race.store(true, Ordering::SeqCst);
        Pin::new(&mut transport)
            .start_send(Message::text("pending"))
            .unwrap();
        drop(transport);
        assert_eq!(state.releases.load(Ordering::SeqCst), 1);
        assert_eq!(state.final_closes.load(Ordering::SeqCst), 1);
        assert!(state.sent.lock().unwrap().is_empty());
    }

    #[test]
    fn oversized_frame_never_reaches_host() {
        let (mut transport, state, _, _) = fixture();
        assert!(
            Pin::new(&mut transport)
                .start_send(Message::text("x".repeat(1025)))
                .is_err()
        );
        assert!(state.sent.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod codec_tests;
