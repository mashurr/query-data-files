//! Framing shared with the extension. Every message in either direction is
//! `u32 header length | u32 body length | JSON header | body`, lengths little-endian.
//! Bodies carry Arrow IPC streams; requests never have one.

use std::io::{self, Read, Write};

use serde_json::Value;

pub struct Frame {
    pub header: Value,
    pub body: Vec<u8>,
}

const MAX_HEADER: usize = 64 << 20;

pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut lengths = [0u8; 8];
    match input.read_exact(&mut lengths) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let header_len = u32::from_le_bytes(lengths[..4].try_into().unwrap()) as usize;
    let body_len = u32::from_le_bytes(lengths[4..].try_into().unwrap()) as usize;
    if header_len > MAX_HEADER || body_len > MAX_HEADER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut header = vec![0u8; header_len];
    input.read_exact(&mut header)?;
    let mut body = vec![0u8; body_len];
    input.read_exact(&mut body)?;
    let header = serde_json::from_slice(&header)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(Frame { header, body }))
}

pub fn write_frame(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let header = serde_json::to_vec(&frame.header)?;
    output.write_all(&(header.len() as u32).to_le_bytes())?;
    output.write_all(&(frame.body.len() as u32).to_le_bytes())?;
    output.write_all(&header)?;
    output.write_all(&frame.body)?;
    output.flush()
}
