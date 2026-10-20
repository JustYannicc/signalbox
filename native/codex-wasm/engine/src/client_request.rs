use std::io;
use tokio::sync::oneshot;

pub(crate) type Reply<T> = oneshot::Sender<io::Result<T>>;

pub(crate) async fn complete_request<T>(
    request: impl std::future::Future<Output = io::Result<T>>,
    mut response: Reply<T>,
    cancellable: bool,
) {
    tokio::select! {
        _ = response.closed(), if cancellable => {}
        result = request => { let _ = response.send(result); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn closed(error: impl std::fmt::Display) -> io::Error {
        io::Error::other(error.to_string())
    }
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct OnDrop(Arc<AtomicBool>);
    impl Drop for OnDrop {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn dropping_an_ordinary_response_keeps_the_native_request_alive() {
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = OnDrop(dropped.clone());
        let (finish, finished) = oneshot::channel();
        let (reply, response) = oneshot::channel();
        let running = tokio::spawn(complete_request(
            async move {
                let _guard = guard;
                finished.await.map_err(closed)
            },
            reply,
            false,
        ));
        drop(response);
        tokio::task::yield_now().await;
        assert!(!running.is_finished());
        assert!(!dropped.load(Ordering::SeqCst));
        finish.send(()).unwrap();
        running.await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn dropping_a_device_ceremony_response_cancels_the_native_request() {
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = OnDrop(dropped.clone());
        let (reply, response) = oneshot::channel::<io::Result<()>>();
        let running = tokio::spawn(complete_request(
            async move {
                let _guard = guard;
                std::future::pending().await
            },
            reply,
            true,
        ));
        drop(response);
        running.await.unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }
}
