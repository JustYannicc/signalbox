use std::io;
use std::os::wasi::io::{AsRawFd, RawFd};
use std::task::{Context, Poll, ready};

use tokio::io::wasi::AsyncFd;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::http::Response;

use super::codec::{self, MAX_HANDSHAKE, invalid};
use super::transport::{Direction, Host};

#[link(wasm_import_module = "signalbox_ws_v1")]
unsafe extern "C" {
    fn ws_open(request: *const u8, length: u32, fd: *mut u32) -> u32;
    fn ws_handshake(fd: u32, output: *mut u8, capacity: u32, required: *mut u32) -> u32;
    fn ws_recv(
        fd: u32,
        opcode: *mut u32,
        output: *mut u8,
        capacity: u32,
        required: *mut u32,
    ) -> u32;
    fn ws_ready(fd: u32) -> u32;
    fn ws_send(fd: u32, opcode: u32, data: *const u8, length: u32) -> u32;
    fn ws_flush(fd: u32) -> u32;
    fn ws_close(fd: u32) -> u32;
    fn ws_drop(fd: u32) -> u32;
}

fn errno(code: u32) -> io::Result<()> {
    match code {
        0 => Ok(()),
        value if value <= i32::MAX as u32 => Err(io::Error::from_raw_os_error(value as i32)),
        _ => Err(invalid("invalid host WebSocket errno")),
    }
}

struct OwnedSocket(u32);
impl AsRawFd for OwnedSocket {
    fn as_raw_fd(&self) -> RawFd {
        // #1064 allocates at most i32::MAX, including on SDKs whose RawFd is signed.
        self.0 as RawFd
    }
}
impl Drop for OwnedSocket {
    fn drop(&mut self) {
        // This releases one descriptor reference. Only the host's final release closes the resource.
        let _ = unsafe { ws_drop(self.0) };
    }
}

pub(crate) struct Socket {
    fd: AsyncFd<OwnedSocket>,
    max_frame: usize,
}

impl Socket {
    pub(crate) fn open(request: &[u8], max_frame: usize) -> io::Result<Self> {
        let mut fd = 0;
        // Imports never retain a guest pointer or suspend; ownership transfers only on success.
        errno(unsafe { ws_open(request.as_ptr(), request.len() as u32, &mut fd) })?;
        let owned = OwnedSocket(fd);
        if fd > i32::MAX as u32 {
            return Err(invalid(
                "host WebSocket fd exceeds shared descriptor namespace",
            ));
        }
        let fd = AsyncFd::new(owned)?;
        Ok(Self { fd, max_frame })
    }

    fn raw(&self) -> u32 {
        self.fd.get_ref().0
    }

    fn copy(&self, handshake: bool) -> io::Result<(u32, Vec<u8>)> {
        let limit = if handshake {
            MAX_HANDSHAKE
        } else {
            self.max_frame
        };
        let mut output = vec![0; limit.min(4096)];
        loop {
            let mut opcode = 0;
            let mut required = 0;
            let code = if handshake {
                unsafe {
                    ws_handshake(
                        self.raw(),
                        output.as_mut_ptr(),
                        output.len() as u32,
                        &mut required,
                    )
                }
            } else {
                unsafe {
                    ws_recv(
                        self.raw(),
                        &mut opcode,
                        output.as_mut_ptr(),
                        output.len() as u32,
                        &mut required,
                    )
                }
            };
            if code == 42 {
                // ENOBUFS must preserve the queue head and handshake readiness.
                let required = required as usize;
                if required <= output.len() || required > limit {
                    return Err(invalid("invalid host WebSocket required length"));
                }
                output.resize(required, 0);
                continue;
            }
            errno(code)?;
            if required as usize > output.len() {
                return Err(invalid("host WebSocket returned an invalid length"));
            }
            output.truncate(required as usize);
            return Ok((opcode, output));
        }
    }

    pub(crate) fn handshake(&self) -> io::Result<Response<Option<Vec<u8>>>> {
        let (_, bytes) = self.copy(true)?;
        codec::decode_response(&bytes)
    }
}

impl Host for Socket {
    fn poll<T>(
        &self,
        cx: &mut Context<'_>,
        direction: Direction,
        mut operation: impl FnMut() -> io::Result<T>,
    ) -> Poll<io::Result<T>> {
        loop {
            // Tokio registers this task before the attempt. Only reactor park calls poll_oneoff.
            let mut guard = match direction {
                Direction::Read => ready!(self.fd.poll_read_ready(cx))?,
                Direction::Write => ready!(self.fd.poll_write_ready(cx))?,
            };
            match guard.try_io(|_| operation()) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }

    fn receive(&self) -> io::Result<Option<Message>> {
        let (opcode, bytes) = self.copy(false)?;
        codec::decode_frame(opcode, bytes)
    }
    fn ready(&self) -> io::Result<()> {
        errno(unsafe { ws_ready(self.raw()) })
    }
    fn send(&self, message: &Message) -> io::Result<()> {
        let (opcode, bytes) = codec::encode_frame(message)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
        errno(unsafe { ws_send(self.raw(), opcode, bytes.as_ptr(), bytes.len() as u32) })
    }
    fn flush(&self) -> io::Result<()> {
        errno(unsafe { ws_flush(self.raw()) })
    }
    fn close(&self) -> io::Result<()> {
        errno(unsafe { ws_close(self.raw()) })
    }
}
