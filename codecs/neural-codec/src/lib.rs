mod entropy;
#[cfg(feature = "gru-l")]
mod gru;
mod model;
#[cfg(feature = "transformer-l")]
mod transformer;

use std::alloc::{Layout, alloc, dealloc};
use std::ptr::{copy_nonoverlapping, write_unaligned};

use entropy::{Decoder, Encoder, cumulative_frequencies};
use model::{DELIMITER, MAXIMUM_URL_BYTES, Predictor, byte_to_token, token_to_byte};

#[cfg(all(feature = "gru-l", feature = "transformer-l"))]
compile_error!("select exactly one neural codec feature");
#[cfg(not(any(feature = "gru-l", feature = "transformer-l")))]
compile_error!("select exactly one neural codec feature");
#[cfg(all(feature = "arithmetic", feature = "rans"))]
compile_error!("select exactly one entropy coder feature");
#[cfg(not(any(feature = "arithmetic", feature = "rans")))]
compile_error!("select exactly one entropy coder feature");

const ALLOCATION_ALIGNMENT: usize = align_of::<u64>();
const STATUS_OK: u32 = 0;
const STATUS_INVALID_INPUT: u32 = 1;
const STATUS_MALFORMED_PAYLOAD: u32 = 2;
const STATUS_RESOURCE_LIMIT: u32 = 3;
const STATUS_INTERNAL_ERROR: u32 = 4;

fn layout(length: u32) -> Option<Layout> {
    Layout::from_size_align(length as usize, ALLOCATION_ALIGNMENT).ok()
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_alloc(length: u32) -> u32 {
    if length == 0 {
        return 0;
    }
    let Some(layout) = layout(length) else {
        return 0;
    };
    unsafe { alloc(layout) as usize as u32 }
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_free(pointer: u32, length: u32) {
    if pointer == 0 || length == 0 {
        return;
    }
    let Some(layout) = layout(length) else {
        return;
    };
    unsafe { dealloc(pointer as *mut u8, layout) };
}

#[cfg(feature = "gru-l")]
fn predictor() -> Result<gru::Gru, ()> {
    gru::Gru::new()
}

#[cfg(feature = "transformer-l")]
fn predictor() -> Result<transformer::Transformer, ()> {
    transformer::Transformer::new()
}

fn encode(input: &[u8]) -> Result<Vec<u8>, u32> {
    if input.len() > MAXIMUM_URL_BYTES {
        return Err(STATUS_INVALID_INPUT);
    }
    let tokens = input
        .iter()
        .map(|byte| byte_to_token(*byte).ok_or(STATUS_INVALID_INPUT))
        .collect::<Result<Vec<_>, _>>()?;
    let mut model = predictor().map_err(|_| STATUS_INTERNAL_ERROR)?;
    let mut coder = Encoder::new();
    let mut previous = DELIMITER;
    for target in tokens.into_iter().chain(std::iter::once(DELIMITER)) {
        let logits = model.predict(previous).map_err(|_| STATUS_INTERNAL_ERROR)?;
        let cumulative = cumulative_frequencies(&logits).map_err(|_| STATUS_INTERNAL_ERROR)?;
        coder.symbol(target as usize, cumulative);
        previous = target;
    }
    coder.finish().map_err(|_| STATUS_INTERNAL_ERROR)
}

fn decode(input: &[u8]) -> Result<Vec<u8>, u32> {
    if input.is_empty() {
        return Err(STATUS_MALFORMED_PAYLOAD);
    }
    let mut model = predictor().map_err(|_| STATUS_INTERNAL_ERROR)?;
    let mut coder = Decoder::new(input).map_err(|_| STATUS_MALFORMED_PAYLOAD)?;
    let mut output = Vec::new();
    let mut previous = DELIMITER;
    loop {
        let logits = model
            .predict(previous)
            .map_err(|_| STATUS_MALFORMED_PAYLOAD)?;
        let cumulative = cumulative_frequencies(&logits).map_err(|_| STATUS_INTERNAL_ERROR)?;
        let symbol = coder
            .symbol(&cumulative)
            .map_err(|_| STATUS_MALFORMED_PAYLOAD)?;
        if symbol == DELIMITER as usize {
            coder.finish().map_err(|_| STATUS_MALFORMED_PAYLOAD)?;
            return Ok(output);
        }
        if output.len() >= MAXIMUM_URL_BYTES {
            return Err(STATUS_MALFORMED_PAYLOAD);
        }
        output.push(token_to_byte(symbol).ok_or(STATUS_MALFORMED_PAYLOAD)?);
        previous = symbol as u16;
    }
}

fn transform(
    input_pointer: u32,
    input_length: u32,
    descriptor_pointer: u32,
    operation: fn(&[u8]) -> Result<Vec<u8>, u32>,
) -> u32 {
    if descriptor_pointer == 0
        || (input_length == 0 && input_pointer != 0)
        || (input_length != 0 && input_pointer == 0)
    {
        return STATUS_INVALID_INPUT;
    }
    let input =
        unsafe { std::slice::from_raw_parts(input_pointer as *const u8, input_length as usize) };
    let output = match operation(input) {
        Ok(value) => value,
        Err(status) => return status,
    };
    let length = match u32::try_from(output.len()) {
        Ok(value) => value,
        Err(_) => return STATUS_RESOURCE_LIMIT,
    };
    let pointer = minug_alloc(length);
    if length != 0 && pointer == 0 {
        return STATUS_RESOURCE_LIMIT;
    }
    unsafe {
        if length != 0 {
            copy_nonoverlapping(output.as_ptr(), pointer as *mut u8, output.len());
        }
        write_unaligned(descriptor_pointer as *mut u32, pointer);
        write_unaligned((descriptor_pointer + 4) as *mut u32, length);
    }
    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_encode(
    input_pointer: u32,
    input_length: u32,
    descriptor_pointer: u32,
) -> u32 {
    transform(input_pointer, input_length, descriptor_pointer, encode)
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_decode(
    input_pointer: u32,
    input_length: u32,
    descriptor_pointer: u32,
) -> u32 {
    transform(input_pointer, input_length, descriptor_pointer, decode)
}
