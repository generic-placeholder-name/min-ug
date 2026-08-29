//! Copying into a fresh allocation exercises ABI ownership and cleanup without making adapter
//! conformance tests depend on a real compression format.

use std::alloc::{Layout, alloc, dealloc};
use std::ptr::{copy_nonoverlapping, write_unaligned};

const ALLOCATION_ALIGNMENT: usize = align_of::<u64>();
const STATUS_OK: u32 = 0;
const STATUS_INVALID_INPUT: u32 = 1;
const STATUS_RESOURCE_LIMIT: u32 = 3;

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
    let pointer = unsafe { alloc(layout) };
    pointer as usize as u32
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

fn copy_to_output(input_pointer: u32, input_length: u32, descriptor_pointer: u32) -> u32 {
    if descriptor_pointer == 0
        || (input_length == 0 && input_pointer != 0)
        || (input_length != 0 && input_pointer == 0)
    {
        return STATUS_INVALID_INPUT;
    }

    let output_pointer = minug_alloc(input_length);
    if input_length != 0 && output_pointer == 0 {
        return STATUS_RESOURCE_LIMIT;
    }

    unsafe {
        if input_length != 0 {
            copy_nonoverlapping(
                input_pointer as *const u8,
                output_pointer as *mut u8,
                input_length as usize,
            );
        }
        write_unaligned(descriptor_pointer as *mut u32, output_pointer);
        write_unaligned((descriptor_pointer + 4) as *mut u32, input_length);
    }

    STATUS_OK
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_encode(
    input_pointer: u32,
    input_length: u32,
    descriptor_pointer: u32,
) -> u32 {
    copy_to_output(input_pointer, input_length, descriptor_pointer)
}

#[unsafe(no_mangle)]
pub extern "C" fn minug_decode(
    input_pointer: u32,
    input_length: u32,
    descriptor_pointer: u32,
) -> u32 {
    copy_to_output(input_pointer, input_length, descriptor_pointer)
}
