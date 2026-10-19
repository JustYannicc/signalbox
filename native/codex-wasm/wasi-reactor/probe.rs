#[path = "selector-cases.rs"]
mod selector_cases;

use std::future::poll_fn;
use std::io;
use std::os::wasi::io::{AsRawFd, RawFd};
use std::task::Poll;

use mio::wasi::SourceFd;
use tokio::io::{wasi::AsyncFd, Interest};

// Probe-only receive. Production framed WebSockets have their own synchronous
// C ABI; both resolve the resource through the kernel's one descriptor table.
#[link(wasm_import_module = "signalbox_reactor_probe")]
extern "C" {
    fn try_recv(fd: RawFd, byte: *mut u8, length: usize) -> i32;
    fn try_send(fd: RawFd, bytes: *const u8, length: usize) -> i32;
    fn close(fd: RawFd) -> i32;
    fn record(event: u32);
}

fn receive(fd: &ReadyFd, byte: &mut [u8]) -> io::Result<usize> {
    let result = unsafe { try_recv(fd.as_raw_fd(), byte.as_mut_ptr(), byte.len()) };
    if result < 0 {
        Err(io::Error::from_raw_os_error(-result))
    } else {
        Ok(result as usize)
    }
}

struct ReadyFd(RawFd);

impl AsRawFd for ReadyFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0
    }
}

impl Drop for ReadyFd {
    fn drop(&mut self) {
        assert_eq!(unsafe { close(self.0) }, 0);
    }
}

fn mark(event: u32) {
    // Keep instrumentation synchronous even inside the future's poll method.
    unsafe { record(event) };
}

#[derive(Debug)]
struct InvalidFd;

impl AsRawFd for InvalidFd {
    fn as_raw_fd(&self) -> RawFd {
        -1
    }
}

fn check_mio(fd: RawFd) -> io::Result<()> {
    let mut poll = mio::Poll::new()?;
    let registry = poll.registry();
    let invalid = -1;
    assert_eq!(
        registry.register(&mut SourceFd(&invalid), mio::Token(1), mio::Interest::READABLE)
            .unwrap_err().kind(),
        io::ErrorKind::InvalidInput,
    );
    registry.register(&mut SourceFd(&fd), mio::Token(2), mio::Interest::READABLE)?;
    registry.reregister(&mut SourceFd(&fd), mio::Token(3), mio::Interest::WRITABLE)?;
    registry.reregister(&mut SourceFd(&fd), mio::Token(4), mio::Interest::READABLE)?;
    registry.deregister(&mut SourceFd(&fd))?;
    let mut events = mio::Events::with_capacity(4);
    // With the descriptor removed, only this zero timeout reaches the host.
    poll.poll(&mut events, Some(std::time::Duration::ZERO))?;
    assert!(events.is_empty());
    mark(1);
    Ok(())
}

async fn read_reply(fd: AsyncFd<ReadyFd>, first_pending: tokio::sync::oneshot::Sender<()>) -> io::Result<()> {
    let mut first_pending = Some(first_pending);
    let mut byte = [0];
    let n = poll_fn(|cx| loop {
        let mut guard = match fd.poll_read_ready(cx) {
            Poll::Pending => {
                mark(3);
                if let Some(sender) = first_pending.take() {
                    sender.send(()).unwrap();
                }
                return Poll::Pending;
            }
            Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
            Poll::Ready(Ok(guard)) => guard,
        };
        match guard.try_io(|fd| receive(fd.get_ref(), &mut byte)) {
            Ok(result) => return Poll::Ready(result),
            // WouldBlock clears only the observed readiness and rearms the task.
            Err(_) => mark(5),
        }
    }).await?;
    assert_eq!(n, 1);
    assert_eq!(byte, [42]);
    mark(6);
    let inner = fd.into_inner();
    mark(7);
    // Re-registering after into_inner exercises the same descriptor's lifecycle.
    let fd = AsyncFd::with_interest(inner, Interest::READABLE)?;
    drop(fd);
    mark(8);
    Ok(())
}

/// The host transfers ownership of one nonblocking request-owned descriptor.
/// Only the runtime's Mio selector is allowed to suspend guest execution.
#[no_mangle]
pub extern "C" fn probe(fd: RawFd) -> u32 {
    check_mio(fd).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .build()
        .unwrap();
    runtime.block_on(async move {
        let error = AsyncFd::try_with_interest(InvalidFd, Interest::READABLE).unwrap_err();
        assert_eq!(error.into_parts().1.kind(), io::ErrorKind::InvalidInput);
        mark(2);
        // The host transfers this fd exactly once, including synchronous close.
        let fd = AsyncFd::with_interest(ReadyFd(fd), Interest::READABLE).unwrap();
        let send_fd = fd.as_raw_fd();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let read = tokio::spawn(read_reply(fd, sender));
        let initialize = tokio::spawn(async move {
            receiver.await.unwrap();
            let frame = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
            assert_eq!(unsafe { try_send(send_fd, frame.as_ptr(), frame.len()) }, frame.len() as i32);
            mark(4);
        });
        read.await.unwrap().unwrap();
        initialize.await.unwrap();
    });
    drop(runtime);
    mark(9);
    0
}
