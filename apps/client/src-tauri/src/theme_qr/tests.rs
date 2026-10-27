use super::*;
use crate::app_lock::AccessState;
use image::{DynamicImage, ImageFormat, RgbImage};
use sha2::{Digest, Sha256};
use std::io::Cursor;

const FIXTURE: &[u8] = include_bytes!("../../fixtures/theme-qr.png");
const PAYLOAD: &str = "moshi-theme:eyJ2IjoxLCJuYW1lIjoiUVIgZml4dHVyZSIsIm1vZGUiOiJkYXJrIiwiY29sb3JzIjp7ImJhY2tncm91bmQiOiIjMDAwMDAwIiwiZm9yZWdyb3VuZCI6IiNmZmZmZmYifX0=";
fn encoded(image: DynamicImage, format: ImageFormat) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    image.write_to(&mut output, format).unwrap();
    output.into_inner()
}
fn authority() -> (AccessState, AccessLease) {
    let state = AccessState::default();
    state.initialize(true, true, "fixture".into()).unwrap();
    let generation = state.generation().unwrap();
    state.authorize(generation).unwrap();
    state.ready(state.generation().unwrap()).unwrap();
    let lease = state
        .lease(state.status().unwrap().nonce.as_deref())
        .unwrap();
    (state, lease)
}

#[test]
fn owned_qr_fixture_decodes_png_jpeg_and_blank_pixels_without_url_actions() {
    assert_eq!(decode(FIXTURE).unwrap().as_deref(), Some(PAYLOAD));
    let image = image::load_from_memory(FIXTURE).unwrap();
    assert_eq!(
        decode(&encoded(image.clone(), ImageFormat::Jpeg))
            .unwrap()
            .as_deref(),
        Some(PAYLOAD)
    );
    // quirc's detector expects dark-on-light; unsupported images report no code,
    // rather than guessing a theme or asking an external decoder.
    assert_eq!(
        decode(&encoded(
            DynamicImage::ImageRgb8(RgbImage::new(32, 32)),
            ImageFormat::Png
        ))
        .unwrap(),
        None
    );
}

fn camera_feed_pixels(offset_x: i64) -> RgbImage {
    let original = image::load_from_memory(FIXTURE).unwrap().into_rgb8();
    assert_eq!(original.dimensions(), (212, 212));
    // The retained camera frame matches the converter's top-left 360x480 crop.
    // x74 centers the original pixels there; x214 recreates the previous input.
    let mut canvas = RgbImage::from_pixel(640, 480, image::Rgb([255, 255, 255]));
    image::imageops::replace(&mut canvas, &original, offset_x, 134);
    canvas
}

#[test]
fn camera_feed_fixture_preserves_original_pixels_and_decodes_cropped_preview() {
    let canvas = camera_feed_pixels(74);
    let bytes = include_bytes!("../../fixtures/theme-qr-camera-feed.png");
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        "16df0b90fe352b80ae22dbdd68b7e0289d2c150df279a70231ce016cc940d9ae"
    );
    let feed = image::load_from_memory(bytes).unwrap().into_rgb8();
    assert_eq!(feed.dimensions(), (640, 480));
    for (x, y, pixel) in feed.enumerate_pixels() {
        assert!(
            pixel == canvas.get_pixel(x, y),
            "Camera feed must retain exact symbol pixels and white padding"
        );
    }
    assert!(decode(bytes).unwrap().as_deref() == Some(PAYLOAD));
    for (kind, pixels) in [
        (
            "top-left crop",
            image::imageops::crop_imm(&feed, 0, 0, 360, 480).to_image(),
        ),
        ("rotated", image::imageops::rotate90(&feed)),
    ] {
        let preview = DynamicImage::ImageRgb8(pixels).resize_exact(
            375,
            500,
            image::imageops::FilterType::Triangle,
        );
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            assert!(
                decode(&encoded(preview.clone(), format))
                    .unwrap()
                    .as_deref()
                    == Some(PAYLOAD),
                "Native {kind}/resize control must retain the complete symbol"
            );
        }
    }
}

#[test]
fn captured_owned_emulator_crop_is_not_a_complete_qr_symbol() {
    let captures: &[(&[u8], usize, &str)] = &[
        (
            include_bytes!("../../fixtures/theme-qr-camera-cropped.png"),
            42_949,
            "ae3599cc82aaf2723be4e7657e70ec6b37b52efadaaa8dd15680e22c17c9d76a",
        ),
        (
            include_bytes!("../../fixtures/theme-qr-camera-centered-cropped.png"),
            21_923,
            "d7a3a963cfd01fdfa9da850de14f39f70829bdbe801d4692340f192fd59ac4c8",
        ),
    ];
    for (captured, length, digest) in captures {
        assert_eq!(captured.len(), *length);
        assert_eq!(format!("{:x}", Sha256::digest(captured)), *digest);
        let pixels = image::load_from_memory(captured).unwrap();
        assert_eq!((pixels.width(), pixels.height()), (375, 500));
        let result = decode(captured);
        let classification = match &result {
            Ok(None) => "no_code",
            Ok(Some(_)) => "decoded_payload",
            Err(_) => "decoder_error",
        };
        eprintln!("Owned captured camera crop classification: {classification}");
        assert!(
            matches!(result, Ok(None)),
            "Unexpected captured-frame classification: {classification}"
        );
    }
}

#[test]
fn previously_centered_feed_loses_the_right_finders_in_the_observed_crop() {
    let previous = camera_feed_pixels(214);
    let crop = image::imageops::crop_imm(&previous, 0, 0, 360, 480).to_image();
    let preview =
        DynamicImage::ImageRgb8(crop).resize_exact(375, 500, image::imageops::FilterType::Triangle);
    assert_eq!(decode(&encoded(preview, ImageFormat::Png)).unwrap(), None);
}

#[test]
fn rejects_oversize_unsupported_malformed_images_and_multiple_codes() {
    for bytes in [Vec::new(), vec![0; INPUT_LIMIT + 1]] {
        assert_eq!(decode(&bytes), Err(QrError::ImageLimit));
    }
    for bytes in [
        b"<svg/>".to_vec(),
        b"not an image".to_vec(),
        FIXTURE[..24].to_vec(),
    ] {
        assert_eq!(decode(&bytes), Err(QrError::InvalidImage));
    }
    let large = encoded(
        DynamicImage::ImageRgb8(RgbImage::new(2049, 2049)),
        ImageFormat::Png,
    );
    assert!(large.len() < INPUT_LIMIT);
    assert_eq!(decode(&large), Err(QrError::ImageLimit));
    for (width, height) in [(0, 10), (4097, 1), (2049, 2049)] {
        assert_eq!(validate_dimensions(width, height), Err(QrError::ImageLimit));
    }
    let first = image::load_from_memory(FIXTURE).unwrap().into_rgb8();
    let mut pair = RgbImage::new(first.width() * 2, first.height());
    image::imageops::replace(&mut pair, &first, 0, 0);
    image::imageops::replace(&mut pair, &first, i64::from(first.width()), 0);
    assert_eq!(
        decode(&encoded(DynamicImage::ImageRgb8(pair), ImageFormat::Png)),
        Err(QrError::MultipleCodes)
    );
}

#[test]
fn byte_elements_and_worst_case_android_envelope_stay_bounded() {
    for value in ["[256]", "[-1]", "[1.5]", "[null]", "[true]", "[\"1\"]"] {
        assert!(serde_json::from_str::<Vec<u8>>(value).is_err());
    }
    let envelope = serde_json::json!({"cmd":"theme_qr_decode","payload":{"bytes":vec![255u8;INPUT_LIMIT]},"options":{"headers":{"X-Lazysh-Access":"f".repeat(64)}},"callback":123456789,"error":123456790});
    assert!(serde_json::to_vec(&envelope).unwrap().len() < 1024 * 1024);
}

#[test]
fn invalid_utf8_qr_is_not_lossily_accepted() {
    assert_eq!(
        decode(include_bytes!("../../fixtures/theme-qr-invalid-utf8.png")),
        Err(QrError::InvalidPayload)
    );
}

#[test]
fn upstream_license_notice_is_verbatim() {
    let notice = include_bytes!("../../licenses/quircs-LICENSE");
    assert_eq!(
        format!("{:x}", Sha256::digest(notice)),
        "166760d656f6bfc29dfc76a7f763e529bde0ed22dde2b20cf6b6c4b14a138a9a"
    );
}

#[tokio::test]
async fn oversized_or_stale_requests_do_not_reserve_or_start_a_decoder() {
    let state = QrState::default();
    let (authority, lease) = authority();
    let oversized = run(&state, vec![0; INPUT_LIMIT + 1], lease.clone(), |_| {
        panic!("oversized decoder start")
    })
    .await;
    assert!(matches!(
        oversized.unwrap_err().into_inner(),
        Ok(QrError::ImageLimit)
    ));
    assert!(!state.0.load(Ordering::Acquire));
    authority.background().unwrap();
    assert!(
        run(&state, vec![42], lease, |_| panic!("stale decoder start"))
            .await
            .is_err()
    );
    assert!(!state.0.load(Ordering::Acquire));
}

async fn held_worker(
    state: &QrState,
    lease: &AccessLease,
) -> (
    tokio::task::JoinHandle<Protected>,
    std::sync::mpsc::Sender<()>,
) {
    let (started, wait) = tokio::sync::oneshot::channel();
    let (release, held) = std::sync::mpsc::channel();
    let worker_state = state.clone();
    let worker_lease = lease.clone();
    let pending = tokio::spawn(async move {
        run(&worker_state, vec![42], worker_lease, move |bytes| {
            started.send(()).unwrap();
            held.recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
            assert_eq!(bytes, [42]);
            Ok(Some("discarded".into()))
        })
        .await
    });
    wait.await.unwrap();
    (pending, release)
}

async fn wait_idle(state: &QrState) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while state.0.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancelled_delivery_keeps_worker_capacity_and_original_body_until_finish() {
    let state = QrState::default();
    let (_, lease) = authority();
    let (pending, release) = held_worker(&state, &lease).await;
    pending.abort();
    assert!(pending.await.unwrap_err().is_cancelled());
    assert!(matches!(
        state.reserve(&lease).unwrap_err().into_inner(),
        Ok(QrError::Busy)
    ));
    release.send(()).unwrap();
    wait_idle(&state).await;
    let result = run(&state, FIXTURE.to_vec(), lease, decode)
        .await
        .unwrap()
        .into_inner()
        .unwrap();
    assert_eq!(result.as_deref(), Some(PAYLOAD));
}

#[tokio::test]
async fn original_access_revocation_drops_result_without_releasing_finishing_capacity() {
    let state = QrState::default();
    let (authority, lease) = authority();
    let (pending, release) = held_worker(&state, &lease).await;
    authority.background().unwrap();
    assert!(
        !pending.is_finished(),
        "raw IPC must remain pending through worker completion"
    );
    assert!(state.0.load(Ordering::Acquire));
    assert!(state.reserve(&lease).is_err());
    release.send(()).unwrap();
    let rejected = tokio::time::timeout(std::time::Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap();
    assert!(rejected.is_err());
    wait_idle(&state).await;
}
