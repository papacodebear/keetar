use std::io::{self, Read, Write};

// Firefox rejects anything larger from a native app, so read replies stay under this after base64.
pub const MAX_OUTGOING_BYTES: usize = 1024 * 1024;
const MAX_INCOMING_BYTES: usize = 256 * 1024 * 1024;

/// Returns `None` once the browser closes stdin, which is the signal to exit.
pub fn read_message(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length > MAX_INCOMING_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message is too large"));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn write_message(output: &mut impl Write, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_OUTGOING_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "reply is too large for the browser"));
    }
    output.write_all(&(body.len() as u32).to_ne_bytes())?;
    output.write_all(body)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn round_trips_a_message() {
        let mut buffer = Vec::new();
        write_message(&mut buffer, b"{\"a\":1}").unwrap();
        let body = read_message(&mut Cursor::new(buffer)).unwrap();
        assert_eq!(body.as_deref(), Some(&b"{\"a\":1}"[..]));
    }

    #[test]
    fn treats_closed_input_as_the_end() {
        assert!(read_message(&mut Cursor::new(Vec::new())).unwrap().is_none());
    }

    #[test]
    fn rejects_truncated_bodies() {
        let mut bytes = 10u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"abc");
        assert!(read_message(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn rejects_oversized_declared_lengths_before_allocating() {
        let bytes = u32::MAX.to_ne_bytes().to_vec();
        assert!(read_message(&mut Cursor::new(bytes)).is_err());
    }

    #[test]
    fn refuses_replies_the_browser_would_reject() {
        let body = vec![b'x'; MAX_OUTGOING_BYTES + 1];
        assert!(write_message(&mut Vec::new(), &body).is_err());
    }
}
