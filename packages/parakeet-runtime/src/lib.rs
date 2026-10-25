//! Synchronous CPU inference. Cancellation of delivery belongs to the caller; never destroy an active recognizer.
mod bundle;
mod storage;
pub use bundle::{VerifiedBundle, ARCHIVE_BYTES, ARCHIVE_SHA256, ARCHIVE_URL, MODEL_ID};
use std::{
    cell::Cell,
    ffi::{c_char, c_int, c_void, CStr, CString},
    marker::PhantomData,
    ptr::NonNull,
};
pub const MAX_SAMPLES: usize = 16_000 * 30;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    InvalidBundle,
    Storage,
    InvalidAudio,
    Native,
    OutputLimit,
    InvalidText,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::InvalidBundle => "The model does not match the pinned Parakeet catalog bundle",
            Self::Storage => "Private Parakeet model storage is unavailable",
            Self::InvalidAudio => {
                "Audio must be 0.1–30 seconds of finite mono 16 kHz samples in [-1, 1]"
            }
            Self::Native => "The local Parakeet runtime could not complete this operation",
            Self::OutputLimit => "Parakeet output exceeds the text limit",
            Self::InvalidText => "Parakeet returned invalid UTF-8 text",
        })
    }
}
impl std::error::Error for Error {}
unsafe extern "C" {
    fn lazysh_parakeet_version() -> *const c_char;
    fn lazysh_parakeet_create(
        encoder: *const c_char,
        decoder: *const c_char,
        joiner: *const c_char,
        tokens: *const c_char,
        out: *mut *mut c_void,
    ) -> c_int;
    fn lazysh_parakeet_transcribe(
        engine: *mut c_void,
        samples: *const f32,
        count: i32,
        out: *mut c_char,
        capacity: usize,
        written: *mut usize,
    ) -> c_int;
    fn lazysh_parakeet_destroy(engine: *mut c_void);
}
pub fn version() -> Result<&'static str, Error> {
    // SAFETY: The shim returns a static library-owned version string or null, never an allocated result.
    let value = unsafe { lazysh_parakeet_version() };
    if value.is_null() {
        return Err(Error::Native);
    }
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map_err(|_| Error::Native)
}
/// One exclusively owned recognizer, including its verified private model files. Not concurrently shareable.
pub struct Recognizer {
    handle: NonNull<c_void>,
    _bundle: VerifiedBundle,
    _not_sync: PhantomData<Cell<()>>,
}
// SAFETY: CPU-only native handles contain no renderer/platform callbacks or Rust borrows. Moving ownership does
// not permit concurrent use; inference needs &mut self, and Cell prevents Sync. Destroy only after the call returns.
unsafe impl Send for Recognizer {}
impl Recognizer {
    pub fn new(bundle: VerifiedBundle) -> Result<Self, Error> {
        let paths = bundle.files().map(|path| {
            path.to_str()
                .and_then(|value| CString::new(value).ok())
                .ok_or(Error::Storage)
        });
        let [encoder, decoder, joiner, tokens] = paths;
        let (encoder, decoder, joiner, tokens) = (encoder?, decoder?, joiner?, tokens?);
        let mut handle = std::ptr::null_mut();
        // SAFETY: Strings live through creation; the C++ shim copies the config and catches exceptions.
        let status = unsafe {
            lazysh_parakeet_create(
                encoder.as_ptr(),
                decoder.as_ptr(),
                joiner.as_ptr(),
                tokens.as_ptr(),
                &mut handle,
            )
        };
        if status != 0 {
            return Err(Error::Native);
        }
        Ok(Self {
            handle: NonNull::new(handle).ok_or(Error::Native)?,
            _bundle: bundle,
            _not_sync: PhantomData,
        })
    }
    /// Call on an owned blocking worker. A cancelled delivery must retain this object until this returns.
    pub fn transcribe(&mut self, samples: &[f32]) -> Result<String, Error> {
        validate_audio(samples)?;
        let mut buffer = vec![0_u8; MAX_TEXT_BYTES + 1];
        let mut written = 0;
        // SAFETY: Exclusive engine access and all borrowed buffers remain live for this synchronous call.
        let status = unsafe {
            lazysh_parakeet_transcribe(
                self.handle.as_ptr(),
                samples.as_ptr(),
                samples.len() as i32,
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut written,
            )
        };
        match status {
            0 => {}
            3 => return Err(Error::OutputLimit),
            _ => return Err(Error::Native),
        }
        if written > MAX_TEXT_BYTES || buffer[written] != 0 {
            return Err(Error::OutputLimit);
        }
        std::str::from_utf8(&buffer[..written])
            .map(|text| text.trim().to_owned())
            .map_err(|_| Error::InvalidText)
    }
}
impl Drop for Recognizer {
    fn drop(&mut self) {
        // SAFETY: &mut self ensures inference has returned; the no-throw destructor runs before model files drop.
        unsafe {
            lazysh_parakeet_destroy(self.handle.as_ptr());
        }
    }
}
fn validate_audio(samples: &[f32]) -> Result<(), Error> {
    if !(1600..=MAX_SAMPLES).contains(&samples.len())
        || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0)
    {
        Err(Error::InvalidAudio)
    } else {
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linked_runtime_is_pinned() {
        assert_eq!(version().unwrap(), "2.0.0");
    }
    #[test]
    fn rejects_invalid_audio_before_native_work() {
        for samples in [
            vec![],
            vec![0.; 1599],
            vec![0.; MAX_SAMPLES + 1],
            vec![f32::NAN; 1600],
            vec![f32::INFINITY; 1600],
            vec![1.01; 1600],
        ] {
            assert_eq!(validate_audio(&samples), Err(Error::InvalidAudio));
        }
        assert!(validate_audio(&vec![0.; 1600]).is_ok());
        assert!(validate_audio(&vec![-1.; MAX_SAMPLES]).is_ok());
    }
}
