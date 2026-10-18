use std::io;
use std::time::Duration;

const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
const MIN_BACKOFF: Duration = Duration::from_millis(2);
const MAX_BACKOFF: Duration = Duration::from_millis(25);

pub struct StdinLines {
    lines: LineBuffer,
    backoff: Duration,
}

impl StdinLines {
    pub fn new() -> io::Result<Self> {
        set_nonblocking()?;
        Ok(Self {
            lines: LineBuffer::default(),
            backoff: MIN_BACKOFF,
        })
    }

    // All consumed bytes live on self, so select! cancellation loses no input.
    pub async fn next_line(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(line) = self.lines.take_line()? {
                return Ok(Some(line));
            }
            if self.lines.eof {
                return Ok(None);
            }
            let mut chunk = [0u8; 8192];
            // SAFETY: fd 0 is nonblocking and chunk is writable for this length.
            let count = unsafe { libc::read(0, chunk.as_mut_ptr().cast(), chunk.len()) };
            if count > 0 {
                self.lines.bytes.extend_from_slice(&chunk[..count as usize]);
                self.backoff = MIN_BACKOFF;
                tokio::task::yield_now().await;
            } else if count == 0 {
                self.lines.eof = true;
            } else {
                let error = io::Error::last_os_error();
                match error.kind() {
                    io::ErrorKind::WouldBlock => {
                        tokio::time::sleep(self.backoff).await;
                        self.backoff = (self.backoff * 2).min(MAX_BACKOFF);
                    }
                    io::ErrorKind::Interrupted => tokio::task::yield_now().await,
                    _ => return Err(error),
                }
            }
        }
    }
}

#[derive(Default)]
struct LineBuffer {
    bytes: Vec<u8>,
    scanned: usize,
    eof: bool,
}

impl LineBuffer {
    fn take_line(&mut self) -> io::Result<Option<Vec<u8>>> {
        let newline = self.bytes[self.scanned..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| self.scanned + position);
        let length = newline.unwrap_or(self.bytes.len());
        if length > MAX_LINE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "NDJSON line exceeds 16 MiB",
            ));
        }
        if let Some(position) = newline {
            let line = self.bytes.drain(..=position).collect();
            self.scanned = 0;
            return Ok(Some(line));
        }
        self.scanned = self.bytes.len();
        if self.eof && !self.bytes.is_empty() {
            self.scanned = 0;
            return Ok(Some(std::mem::take(&mut self.bytes)));
        }
        Ok(None)
    }
}

#[cfg(target_os = "wasi")]
fn set_nonblocking() -> io::Result<()> {
    #[link(wasm_import_module = "wasi_snapshot_preview1")]
    unsafe extern "C" {
        fn fd_fdstat_set_flags(fd: u32, flags: u16) -> u16;
    }
    // Preview1 FDFLAGS_NONBLOCK. agentOS blocking stdin reads park the VM.
    // SAFETY: this only changes flags on the engine's stdin descriptor.
    let errno = unsafe { fd_fdstat_set_flags(0, 4) };
    if errno != 0 {
        return Err(io::Error::from_raw_os_error(i32::from(errno)));
    }
    Ok(())
}

#[cfg(all(not(target_os = "wasi"), unix))]
fn set_nonblocking() -> io::Result<()> {
    // SAFETY: fcntl reads and updates flags on the engine's stdin descriptor.
    unsafe {
        let flags = libc::fcntl(0, libc::F_GETFL);
        if flags < 0 || libc::fcntl(0, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "wasi", unix)))]
fn set_nonblocking() -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "nonblocking stdin requires WASI or Unix",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_utf8_crlf_and_multiple_lines_are_lossless() {
        let bytes = "{\"text\":\"ä\"}\r\n{\"id\":2}\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte == 0xc3).unwrap() + 1;
        let mut buffer = LineBuffer::default();
        buffer.bytes.extend_from_slice(&bytes[..split]);
        assert_eq!(buffer.take_line().unwrap(), None);
        // This is also the state retained when next_line is cancelled by select!.
        buffer.bytes.extend_from_slice(&bytes[split..]);
        assert_eq!(
            buffer.take_line().unwrap().unwrap(),
            "{\"text\":\"ä\"}\r\n".as_bytes()
        );
        assert_eq!(buffer.take_line().unwrap().unwrap(), b"{\"id\":2}\n");
        assert_eq!(buffer.take_line().unwrap(), None);
    }

    #[test]
    fn eof_keeps_the_last_unterminated_message() {
        let mut buffer = LineBuffer {
            bytes: b"{\"id\":1}".to_vec(),
            eof: true,
            ..Default::default()
        };
        assert_eq!(buffer.take_line().unwrap().unwrap(), b"{\"id\":1}");
        assert_eq!(buffer.take_line().unwrap(), None);
    }

    #[test]
    fn oversized_messages_fail_with_and_without_newline() {
        let mut buffer = LineBuffer {
            bytes: vec![b'x'; MAX_LINE_BYTES + 1],
            ..Default::default()
        };
        assert_eq!(
            buffer.take_line().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        buffer.bytes.push(b'\n');
        assert_eq!(
            buffer.take_line().unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }
}
