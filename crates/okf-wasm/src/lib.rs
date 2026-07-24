//! Minimal raw Wasm ABI for the Extension Host.
//!
//! The module deliberately has no WASI imports. The caller owns workspace I/O and passes a
//! versioned JSON request through linear memory.

pub const ABI_VERSION: u32 = okf_core::ABI_VERSION;

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn okf_abi_version() -> u32 {
    ABI_VERSION
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn okf_alloc(length: u32) -> u32 {
    let mut bytes = Vec::<u8>::with_capacity(length as usize);
    let pointer = bytes.as_mut_ptr() as u32;
    std::mem::forget(bytes);
    pointer
}

#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn okf_dealloc(pointer: u32, length: u32) {
    if length == 0 {
        return;
    }
    // SAFETY: `pointer` and `length` must be a buffer returned by `okf_alloc` or `okf_call`.
    unsafe {
        drop(Vec::from_raw_parts(
            pointer as *mut u8,
            length as usize,
            length as usize,
        ));
    }
}

/// Dispatch UTF-8 JSON and return `(response_pointer << 32) | response_length`.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn okf_call(pointer: u32, length: u32) -> u64 {
    let request = if length == 0 {
        Vec::new()
    } else {
        // SAFETY: the caller initialized exactly `length` bytes in an `okf_alloc` buffer.
        unsafe { Vec::from_raw_parts(pointer as *mut u8, length as usize, length as usize) }
    };
    let response = match std::str::from_utf8(&request) {
        Ok(request) => okf_core::dispatch_json(request),
        Err(_) => okf_core::dispatch_json("{"),
    };
    let response = response.into_bytes().into_boxed_slice();
    let response_length = response.len() as u32;
    let response_pointer = Box::into_raw(response) as *mut u8 as u32;
    ((response_pointer as u64) << 32) | response_length as u64
}

#[cfg(test)]
mod tests {
    #[test]
    fn adapter_and_core_abi_match() {
        assert_eq!(super::ABI_VERSION, okf_core::ABI_VERSION);
    }
}
