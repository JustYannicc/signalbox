use crate::codec;
use tokio_tungstenite::tungstenite::{Error, Message, http::Request};

fn bytes(output: &mut Vec<u8>, value: &[u8]) {
    output.extend_from_slice(&(value.len() as u32).to_le_bytes());
    output.extend_from_slice(value);
}
#[test]
fn handshake_preserves_repeated_cookies_and_http_rejection_body() {
    for status in [200_u32, 401, 403] {
        let mut input = status.to_le_bytes().to_vec();
        input.extend_from_slice(&2_u32.to_le_bytes());
        for value in [b"first=1".as_slice(), b"second=2".as_slice()] {
            bytes(&mut input, b"set-cookie");
            bytes(&mut input, value);
        }
        bytes(&mut input, b"rejected");
        let response = codec::decode_response(&input).unwrap();
        assert_eq!(response.status().as_u16(), status as u16);
        assert_eq!(response.headers().get_all("set-cookie").iter().count(), 2);
        assert_eq!(response.body().as_deref(), Some(b"rejected".as_slice()));
        let error = codec::complete_handshake(response).unwrap_err();
        let Error::Http(rejection) = error else {
            panic!("expected HTTP rejection")
        };
        assert_eq!(rejection.status().as_u16(), status as u16);
        assert_eq!(rejection.headers().get_all("set-cookie").iter().count(), 2);
        input.push(0);
        assert!(codec::decode_response(&input).is_err());
    }
}

#[test]
fn framed_messages_roundtrip_and_malformed_payloads_fail() {
    for message in [
        Message::text("hello"),
        Message::binary(vec![0, 255]),
        Message::Close(None),
        Message::Ping(vec![1].into()),
        Message::Pong(vec![2].into()),
    ] {
        let (opcode, bytes) = codec::encode_frame(&message).unwrap();
        assert_eq!(codec::decode_frame(opcode, bytes).unwrap(), Some(message));
    }
    for (opcode, data) in [
        (1, vec![255]),
        (8, vec![1]),
        (8, vec![3, 237]),
        (9, vec![0; 126]),
        (0, vec![1]),
        (3, vec![]),
    ] {
        assert!(codec::decode_frame(opcode, data).is_err());
    }
    assert_eq!(codec::decode_frame(0, vec![]).unwrap(), None);
}

#[test]
fn request_encoding_rejects_invalid_limits_and_huge_headers() {
    let request = Request::builder()
        .uri("ws://localhost/exec")
        .header("cookie", "session=a")
        .body(())
        .unwrap();
    let encoded = codec::encode_request(&request, 1024, 4096).unwrap();
    assert_eq!(&encoded[..12], &[1, 0, 0, 0, 0, 4, 0, 0, 0, 16, 0, 0]);
    for (frame, queue) in [
        (0, 1024),
        (4096, 1024),
        (codec::MAX_FRAME + 1, codec::MAX_QUEUE),
    ] {
        assert!(codec::encode_request(&request, frame, queue).is_err());
    }
    let huge = Request::builder()
        .uri("ws://localhost/")
        .header("x-huge", "x".repeat(codec::MAX_HEADERS))
        .body(())
        .unwrap();
    assert!(codec::encode_request(&huge, 1024, 4096).is_err());
}
