use std::io;
use std::os::wasi::io::{FromRawFd, IntoRawFd, RawFd};
use std::time::Duration;

use mio::wasi::SourceFd;
use mio::{Events, Interest, Poll, Token};

fn poll_count(poll: &mut Poll, events: &mut Events, count: usize) -> io::Result<()> {
    poll.poll(events, Some(Duration::ZERO))?;
    assert_eq!(events.iter().count(), count);
    Ok(())
}

/// Exercises actual Mio registration state through the public WASI host.
#[no_mangle]
pub extern "C" fn selector_probe(first: RawFd, second: RawFd) -> u32 {
    let mut poll = Poll::new().unwrap();
    let mut events = Events::with_capacity(8);
    let both = Interest::READABLE | Interest::WRITABLE;
    poll.registry().register(&mut SourceFd(&first), Token(7), Interest::READABLE).unwrap();
    poll.registry().register(&mut SourceFd(&second), Token(7), Interest::READABLE).unwrap();
    poll_count(&mut poll, &mut events, 2).unwrap();
    assert!(events.iter().all(|event| event.token() == Token(7)));
    poll_count(&mut poll, &mut events, 0).unwrap();
    // Fully-disarmed entries must remain available for reregister and deregister.
    poll.registry().reregister(&mut SourceFd(&first), Token(8), both).unwrap();
    poll_count(&mut poll, &mut events, 2).unwrap();
    assert!(events.iter().any(|event| event.is_readable()));
    assert!(events.iter().any(|event| event.is_writable()));
    poll_count(&mut poll, &mut events, 0).unwrap();
    poll.registry().reregister(&mut SourceFd(&second), Token(7), Interest::READABLE).unwrap();
    poll_count(&mut poll, &mut events, 1).unwrap();
    poll.registry().deregister(&mut SourceFd(&second)).unwrap();
    let absent = 0x7fff0000;
    assert_eq!(poll.registry().reregister(&mut SourceFd(&absent), Token(1), both)
        .unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(poll.poll(&mut events, None).unwrap_err().kind(), io::ErrorKind::Unsupported);

    super::mark(20); // Both fd directions become unready.
    poll.registry().reregister(&mut SourceFd(&first), Token(8), both).unwrap();
    poll_count(&mut poll, &mut events, 0).unwrap();
    super::mark(21); // Only read becomes ready.
    poll_count(&mut poll, &mut events, 1).unwrap();
    assert!(events.iter().next().unwrap().is_readable());
    super::mark(22); // Write must still be armed after the read delivery.
    poll_count(&mut poll, &mut events, 1).unwrap();
    assert!(events.iter().next().unwrap().is_writable());
    poll_count(&mut poll, &mut events, 0).unwrap();
    super::mark(23); // HUP is reported independently for both directions.
    poll.registry().reregister(&mut SourceFd(&first), Token(8), both).unwrap();
    poll_count(&mut poll, &mut events, 2).unwrap();
    assert!(events.iter().any(|event| event.is_read_closed()));
    assert!(events.iter().any(|event| event.is_write_closed()));
    poll_count(&mut poll, &mut events, 0).unwrap();
    poll.registry().deregister(&mut SourceFd(&first)).unwrap();

    // No socket I/O occurs. TcpStream's public try_io drives the real IoSourceState
    // WouldBlock path using this nonblocking custom fd, then returns ownership.
    let stream = unsafe { std::net::TcpStream::from_raw_fd(first) };
    let mut stream = mio::net::TcpStream::from_std(stream);
    poll.registry().register(&mut stream, Token(9), both).unwrap();
    poll_count(&mut poll, &mut events, 2).unwrap();
    for _ in 0..3 {
        poll_count(&mut poll, &mut events, 0).unwrap();
        assert_eq!(stream.try_io::<_, ()>(|| Err(io::ErrorKind::WouldBlock.into()))
            .unwrap_err().kind(), io::ErrorKind::WouldBlock);
        poll_count(&mut poll, &mut events, 2).unwrap();
    }
    assert_eq!(stream.try_io(|| Ok(33)).unwrap(), 33);
    poll_count(&mut poll, &mut events, 0).unwrap();
    poll.registry().reregister(&mut stream, Token(10), Interest::READABLE).unwrap();
    poll_count(&mut poll, &mut events, 1).unwrap();
    poll.registry().deregister(&mut stream).unwrap();
    assert_eq!(stream.into_raw_fd(), first);

    // Returning an error must not consume another descriptor's readiness.
    poll.registry().register(&mut SourceFd(&first), Token(11), Interest::READABLE).unwrap();
    poll.registry().register(&mut SourceFd(&second), Token(12), Interest::READABLE).unwrap();
    assert_eq!(unsafe { super::close(second) }, 0);
    assert_eq!(poll.poll(&mut events, Some(Duration::ZERO)).unwrap_err().raw_os_error(), Some(8));
    poll.registry().deregister(&mut SourceFd(&second)).unwrap();
    poll_count(&mut poll, &mut events, 1).unwrap();
    assert_eq!(events.iter().next().unwrap().token(), Token(11));
    poll.registry().deregister(&mut SourceFd(&first)).unwrap();
    assert_eq!(unsafe { super::close(first) }, 0);
    super::mark(24);
    0
}
