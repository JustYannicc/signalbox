use std::io;
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use futures::{Sink, Stream};
use tokio_tungstenite::tungstenite::{Error, Message};

use super::codec;

#[derive(Clone, Copy)]
pub(crate) enum Direction {
    Read,
    Write,
}

pub(crate) trait Host: Unpin {
    fn poll<T>(
        &self,
        cx: &mut Context<'_>,
        direction: Direction,
        operation: impl FnMut() -> io::Result<T>,
    ) -> Poll<io::Result<T>>;
    fn receive(&self) -> io::Result<Option<Message>>;
    fn ready(&self) -> io::Result<()>;
    fn send(&self, message: &Message) -> io::Result<()>;
    fn flush(&self) -> io::Result<()>;
    fn close(&self) -> io::Result<()>;
}

pub(crate) struct Transport<H> {
    pub(crate) host: H,
    pending: Option<Message>,
    max_frame: usize,
    read_terminated: bool,
    closing: bool,
    closed: bool,
}

impl<H: Host> Transport<H> {
    pub(crate) fn new(host: H, max_frame: usize) -> Self {
        Self {
            host,
            pending: None,
            max_frame,
            read_terminated: false,
            closing: false,
            closed: false,
        }
    }

    fn drain(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        if let Some(message) = &self.pending {
            ready!(
                self.host
                    .poll(cx, Direction::Write, || self.host.send(message))
            )?;
            self.pending = None;
        }
        Poll::Ready(Ok(()))
    }
}

impl<H: Host> Stream for Transport<H> {
    type Item = Result<Message, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.read_terminated {
            return Poll::Ready(None);
        }
        match ready!(this.host.poll(cx, Direction::Read, || this.host.receive())) {
            Ok(Some(message)) => Poll::Ready(Some(Ok(message))),
            Ok(None) => {
                this.read_terminated = true;
                Poll::Ready(None)
            }
            Err(error) => {
                this.read_terminated = true;
                Poll::Ready(Some(Err(Error::Io(error))))
            }
        }
    }
}

impl<H: Host> Sink<Message> for Transport<H> {
    type Error = Error;

    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        let this = self.get_mut();
        if this.closing || this.closed {
            return Poll::Ready(Err(Error::ConnectionClosed));
        }
        ready!(this.drain(cx))?;
        this.host
            .poll(cx, Direction::Write, || this.host.ready())
            .map_err(Error::Io)
    }

    fn start_send(self: Pin<&mut Self>, message: Message) -> Result<(), Error> {
        let this = self.get_mut();
        if this.closing || this.closed {
            return Err(Error::ConnectionClosed);
        }
        if this.pending.is_some() {
            return Err(Error::WriteBufferFull(Box::new(message)));
        }
        if codec::frame_len(&message)? > this.max_frame {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "host WebSocket frame limit exceeded",
            )));
        }
        match this.host.send(&message) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                // Sink::start_send cannot return Pending. Keep exactly this frame until credit.
                this.pending = Some(message);
                Ok(())
            }
            Err(error) => Err(Error::Io(error)),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        let this = self.get_mut();
        if this.closed {
            return Poll::Ready(Ok(()));
        }
        ready!(this.drain(cx))?;
        this.host
            .poll(cx, Direction::Write, || this.host.flush())
            .map_err(Error::Io)
    }

    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
        let this = self.get_mut();
        if this.closed {
            return Poll::Ready(Ok(()));
        }
        this.closing = true;
        ready!(Pin::new(&mut *this).poll_flush(cx))?;
        ready!(this.host.poll(cx, Direction::Write, || this.host.close()))?;
        this.closed = true;
        Poll::Ready(Ok(()))
    }
}
