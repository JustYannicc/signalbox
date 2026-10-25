use mio::{wasi::SourceFd, Interest, Poll, Token};

// Compiled separately with os-ext + os-poll and no net feature.
pub fn registration_contract(fd: std::os::wasi::io::RawFd) -> std::io::Result<()> {
    let poll = Poll::new()?;
    poll.registry().register(&mut SourceFd(&fd), Token(1), Interest::READABLE)?;
    poll.registry().reregister(&mut SourceFd(&fd), Token(2), Interest::WRITABLE)?;
    poll.registry().deregister(&mut SourceFd(&fd))
}
