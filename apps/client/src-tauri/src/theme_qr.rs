//! Local, explicitly requested QR decoding. No camera, URL or filesystem access.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::State;

// Android serializes byte arrays as JSON. Even 4 characters per byte plus the
// command/nonce envelope stays below 1 MiB. Never accept a path or remote URL.
const INPUT_LIMIT: usize = 192 * 1024;
const AXIS_LIMIT: u32 = 4096;
const PIXEL_LIMIT: u64 = 4 * 1024 * 1024;
const PAYLOAD_LIMIT: usize = 16 * 1024;
type Protected = Result<Guarded<Option<String>>, GuardedError<QrError>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QrError {
    Busy,
    ImageLimit,
    InvalidImage,
    MultipleCodes,
    InvalidPayload,
    Stopped,
}

#[derive(Clone, Default)]
pub struct QrState(Arc<AtomicBool>);
#[derive(Debug)]
struct Permit(Arc<AtomicBool>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl QrState {
    fn reserve(&self, access: &AccessLease) -> Result<Permit, GuardedError<QrError>> {
        access
            .with_current(|| {
                self.0
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .map(|_| Permit(self.0.clone()))
                    .map_err(|_| QrError::Busy)
            })?
            .map_err(|error| access.error(error))
    }
}

fn validate_dimensions(width: u32, height: u32) -> Result<(), QrError> {
    if width == 0
        || height == 0
        || width > AXIS_LIMIT
        || height > AXIS_LIMIT
        || u64::from(width) * u64::from(height) > PIXEL_LIMIT
    {
        return Err(QrError::ImageLimit);
    }
    Ok(())
}

fn decode(bytes: &[u8]) -> Result<Option<String>, QrError> {
    use image::{ImageDecoder, ImageFormat, ImageReader};
    use std::io::Cursor;
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(QrError::ImageLimit);
    }
    let format = image::guess_format(bytes).map_err(|_| QrError::InvalidImage)?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg) {
        return Err(QrError::InvalidImage);
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(AXIS_LIMIT);
    limits.max_image_height = Some(AXIS_LIMIT);
    // Codec allocation limits are advisory, not a total worker/RSS bound.
    limits.max_alloc = Some(32 * 1024 * 1024);
    let reader = || {
        let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
        reader.limits(limits.clone());
        reader
    };
    let (width, height) = reader()
        .into_dimensions()
        .map_err(|_| QrError::InvalidImage)?;
    validate_dimensions(width, height)?;
    let mut decoder = reader().into_decoder().map_err(|_| QrError::InvalidImage)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image =
        image::DynamicImage::from_decoder(decoder).map_err(|_| QrError::InvalidImage)?;
    image.apply_orientation(orientation);
    let pixels = image.into_luma8();
    validate_dimensions(pixels.width(), pixels.height())?;
    let mut decoder = quircs::Quirc::default();
    let mut codes = decoder.identify(
        pixels.width() as usize,
        pixels.height() as usize,
        pixels.as_raw(),
    );
    let Some(code) = codes.next() else {
        return Ok(None);
    };
    if codes.next().is_some() {
        return Err(QrError::MultipleCodes);
    }
    let Ok(code) = code else {
        return Ok(None);
    };
    let Ok(data) = code.decode() else {
        return Ok(None);
    };
    if data.payload.len() > PAYLOAD_LIMIT {
        return Err(QrError::InvalidPayload);
    }
    String::from_utf8(data.payload)
        .map(Some)
        .map_err(|_| QrError::InvalidPayload)
}

async fn run(
    state: &QrState,
    bytes: Vec<u8>,
    access: AccessLease,
    worker: impl FnOnce(&[u8]) -> Result<Option<String>, QrError> + Send + 'static,
) -> Protected {
    if bytes.is_empty() || bytes.len() > INPUT_LIMIT {
        return Err(access.error(QrError::ImageLimit));
    }
    let permit = state.reserve(&access)?;
    let original = access.clone();
    // Reservation and dispatch happen without an await. The owned closure keeps
    // capacity/body/lease until synchronous decode finishes even if delivery is
    // cancelled. Never run image work under the access authority's mutex.
    let job = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        original.check().map_err(|_| QrError::Stopped)?;
        worker(&bytes)
    });
    // Unlike delivery-cancelling AccessLease::run, wait for the owned worker.
    // The raw IPC settles only after it exits; guard the result with the original
    // lease afterward so a revoked scan cannot publish its decoded payload.
    match job
        .await
        .map_err(|_| QrError::Stopped)
        .and_then(|value| value)
    {
        Ok(value) => access.guard(value).map_err(Into::into),
        Err(error) => Err(access.error(error)),
    }
}

#[tauri::command]
pub async fn theme_qr_decode(
    state: State<'_, QrState>,
    bytes: Vec<u8>,
    access: AccessLease,
) -> Protected {
    run(&state, bytes, access, decode).await
}

#[cfg(test)]
mod tests;
