use std::io;

use tokio_tungstenite::tungstenite::handshake::client::Request;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue, Response};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
use tokio_tungstenite::tungstenite::{Error, Message};

pub(crate) const MAX_FRAME: usize = 1024 * 1024;
pub(crate) const MAX_QUEUE: usize = 4 * MAX_FRAME;
pub(crate) const MAX_HEADERS: usize = 64 * 1024;
pub(crate) const MAX_HANDSHAKE: usize = MAX_FRAME + MAX_HEADERS + 16;

pub(crate) fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn append_bytes(output: &mut Vec<u8>, bytes: &[u8]) {
    output.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    output.extend_from_slice(bytes);
}

pub(crate) fn encode_request(request: &Request, frame: usize, queue: usize) -> io::Result<Vec<u8>> {
    let url = request.uri().to_string();
    if url.len() > 8192 || frame == 0 || frame > MAX_FRAME || queue < frame || queue > MAX_QUEUE {
        return Err(invalid("invalid host WebSocket limits"));
    }
    let header_bytes: usize = request
        .headers()
        .iter()
        .map(|(name, value)| name.as_str().len() + value.as_bytes().len() + 8)
        .sum();
    if header_bytes + 4 > MAX_HEADERS {
        return Err(invalid("host WebSocket headers exceed 64 KiB"));
    }
    let mut output = Vec::with_capacity(24 + url.len() + header_bytes);
    for value in [1, frame as u32, queue as u32] {
        output.extend_from_slice(&value.to_le_bytes());
    }
    append_bytes(&mut output, url.as_bytes());
    output.extend_from_slice(&(request.headers().len() as u32).to_le_bytes());
    for (name, value) in request.headers() {
        append_bytes(&mut output, name.as_str().as_bytes());
        append_bytes(&mut output, value.as_bytes());
    }
    Ok(output)
}

struct Input<'a>(&'a [u8]);
impl<'a> Input<'a> {
    fn take(&mut self, length: usize) -> io::Result<&'a [u8]> {
        if length > self.0.len() {
            return Err(invalid("truncated host WebSocket data"));
        }
        let (bytes, rest) = self.0.split_at(length);
        self.0 = rest;
        Ok(bytes)
    }
    fn number(&mut self) -> io::Result<u32> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| invalid("invalid u32"))?;
        Ok(u32::from_le_bytes(bytes))
    }
    fn bytes(&mut self) -> io::Result<&'a [u8]> {
        let length = self.number()? as usize;
        self.take(length)
    }
}

pub(crate) fn decode_response(bytes: &[u8]) -> io::Result<Response<Option<Vec<u8>>>> {
    if bytes.len() > MAX_HANDSHAKE {
        return Err(invalid("host WebSocket handshake exceeds limit"));
    }
    let mut input = Input(bytes);
    let status = u16::try_from(input.number()?).map_err(|_| invalid("invalid HTTP status"))?;
    if !(100..600).contains(&status) {
        return Err(invalid("host WebSocket expected upgrade or HTTP rejection"));
    }
    let count = input.number()?;
    let mut response = Response::builder()
        .status(status)
        .body(None)
        .map_err(|_| invalid("invalid HTTP response"))?;
    let start = input.0.len();
    if count as usize > MAX_HEADERS / 8 {
        return Err(invalid("too many host WebSocket headers"));
    }
    for _ in 0..count {
        let name = HeaderName::from_bytes(input.bytes()?)
            .map_err(|_| invalid("invalid HTTP header name"))?;
        let value = HeaderValue::from_bytes(input.bytes()?)
            .map_err(|_| invalid("invalid HTTP header value"))?;
        if start - input.0.len() + 4 > MAX_HEADERS {
            return Err(invalid("host WebSocket headers exceed limit"));
        }
        response.headers_mut().append(name, value);
    }
    let body = input.bytes()?;
    if body.len() > MAX_FRAME || !input.0.is_empty() {
        return Err(invalid("invalid host WebSocket HTTP body"));
    }
    if !body.is_empty() {
        *response.body_mut() = Some(body.to_vec());
    }
    Ok(response)
}

pub(crate) fn complete_handshake(
    response: Response<Option<Vec<u8>>>,
) -> Result<Response<()>, Error> {
    if response.status().as_u16() != 101 {
        return Err(Error::Http(Box::new(response)));
    }
    Ok(response.map(|_| ()))
}

pub(crate) fn frame_len(message: &Message) -> Result<usize, Error> {
    let length = match message {
        Message::Close(Some(value)) => {
            if !value.code.is_allowed() {
                return Err(Error::Io(invalid("invalid WebSocket close code")));
            }
            value.reason.len().saturating_add(2)
        }
        Message::Frame(_) => {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::Unsupported,
                "raw WebSocket frames are unsupported by host transport",
            )));
        }
        _ => message.len(),
    };
    let control = matches!(
        message,
        Message::Close(_) | Message::Ping(_) | Message::Pong(_)
    );
    if length > MAX_FRAME || (control && length > 125) {
        return Err(Error::Io(invalid("host WebSocket frame exceeds limit")));
    }
    Ok(length)
}

pub(crate) fn encode_frame(message: &Message) -> Result<(u32, Vec<u8>), Error> {
    frame_len(message)?;
    let frame = match message {
        Message::Text(value) => (1, value.as_bytes().to_vec()),
        Message::Binary(value) => (2, value.to_vec()),
        Message::Close(None) => (8, Vec::new()),
        Message::Close(Some(value)) => {
            let mut bytes = u16::from(value.code).to_be_bytes().to_vec();
            bytes.extend_from_slice(value.reason.as_bytes());
            if !value.code.is_allowed() {
                return Err(Error::Io(invalid("invalid WebSocket close code")));
            }
            (8, bytes)
        }
        Message::Ping(value) => (9, value.to_vec()),
        Message::Pong(value) => (10, value.to_vec()),
        Message::Frame(_) => {
            return Err(Error::Io(io::Error::new(
                io::ErrorKind::Unsupported,
                "raw WebSocket frames are unsupported by host transport",
            )));
        }
    };
    if frame.0 >= 8 && frame.1.len() > 125 {
        return Err(Error::Io(invalid("oversized WebSocket control frame")));
    }
    Ok(frame)
}

pub(crate) fn decode_frame(opcode: u32, bytes: Vec<u8>) -> io::Result<Option<Message>> {
    if bytes.len() > MAX_FRAME || (opcode >= 8 && bytes.len() > 125) {
        return Err(invalid("host WebSocket frame exceeds limit"));
    }
    let message = match opcode {
        0 if bytes.is_empty() => return Ok(None),
        1 => Message::Text(
            String::from_utf8(bytes)
                .map_err(|_| invalid("invalid UTF8 WebSocket text"))?
                .into(),
        ),
        2 => Message::Binary(bytes.into()),
        8 if bytes.is_empty() => Message::Close(None),
        8 if bytes.len() >= 2 => {
            let code = CloseCode::from(u16::from_be_bytes([bytes[0], bytes[1]]));
            if !code.is_allowed() {
                return Err(invalid("invalid WebSocket close code"));
            }
            let reason = std::str::from_utf8(&bytes[2..])
                .map_err(|_| invalid("invalid UTF8 WebSocket close reason"))?;
            Message::Close(Some(CloseFrame {
                code,
                reason: reason.to_owned().into(),
            }))
        }
        9 => Message::Ping(bytes.into()),
        10 => Message::Pong(bytes.into()),
        _ => return Err(invalid("invalid host WebSocket opcode or payload")),
    };
    Ok(Some(message))
}
