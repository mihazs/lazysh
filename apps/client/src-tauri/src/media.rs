//! Bounded, signature-checked reads of video and audio files for the Files preview. The bytes
//! reach only an isolated, non-executing frame in the client; `docs/reference/files-media-viewer.md`
//! records the trust boundary.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::host::Host;
use crate::local::LocalState;
use crate::repository::{check_directory, check_file_path, invalid};
use crate::ssh::{AppState, Result, SshError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;

/// The largest file read for an in-app preview; the client enforces the same bound.
const MEDIA_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
}
#[derive(Debug, Serialize)]
pub struct Media {
    mime: &'static str,
    data: String,
}

/// Visit every sibling box without following opaque payloads; lengths are relative to this slice.
fn boxes(mut bytes: &[u8], mut visit: impl FnMut(&[u8], &[u8]) -> Option<()>) -> Option<()> {
    while !bytes.is_empty() {
        let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
        let name = bytes.get(4..8)?;
        let (header, length) = match size {
            0 => (8, bytes.len()),
            1 => (
                16,
                usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?,
            ),
            n => (8, usize::try_from(n).ok()?),
        };
        if length < header || length > bytes.len() {
            return None;
        }
        visit(name, &bytes[header..length])?;
        bytes = &bytes[length..];
    }
    Some(())
}

/// Conservative classification, not full ISO BMFF validation: all tracks must declare sound and
/// the complete box tree we inspect must be well formed. Fragmented and ambiguous files stay video.
fn mp4_audio_only(data: &[u8]) -> bool {
    let mut movies = 0usize;
    let mut tracks = 0usize;
    let valid = boxes(data, |name, body| {
        if name == b"moof" {
            return None;
        }
        if name != b"moov" {
            return Some(());
        }
        movies += 1;
        if movies != 1 {
            return None;
        }
        boxes(body, |name, body| {
            if name == b"mvex" {
                return None;
            }
            if name != b"trak" {
                return Some(());
            }
            tracks += 1;
            let mut media = 0usize;
            boxes(body, |name, body| {
                if name != b"mdia" {
                    return Some(());
                }
                media += 1;
                if media != 1 {
                    return None;
                }
                let mut handlers = 0usize;
                boxes(body, |name, body| {
                    if name == b"hdlr" {
                        handlers += 1;
                        if handlers != 1
                            || body.len() < 24
                            || body.get(..4) != Some(&[0, 0, 0, 0])
                            || body.get(8..12) != Some(b"soun")
                        {
                            return None;
                        }
                    }
                    Some(())
                })?;
                (handlers == 1).then_some(())
            })?;
            (media == 1).then_some(())
        })
    });
    valid.is_some() && movies == 1 && tracks > 0
}

/// The kind and MIME type the signature at the start of `data` names, whatever the file is called.
fn sniff(data: &[u8]) -> Option<(MediaKind, &'static str)> {
    use MediaKind::{Audio, Video};
    if data.get(4..8) == Some(b"ftyp") {
        // A container brand alone does not tell whether a movie has audio or video tracks.
        return Some(if mp4_audio_only(data) {
            (Audio, "audio/mp4")
        } else {
            (Video, "video/mp4")
        });
    }
    if data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Some((Video, "video/webm"));
    }
    if data.starts_with(b"OggS") {
        return Some((Audio, "audio/ogg"));
    }
    if data.starts_with(b"fLaC") {
        return Some((Audio, "audio/flac"));
    }
    if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WAVE") {
        return Some((Audio, "audio/wav"));
    }
    // An ID3 tag, or an MPEG audio frame header (layer 00 is AAC in ADTS, version 01 is reserved).
    let frame = matches!(data, [0xff, second, ..] if second & 0xe0 == 0xe0 && second & 0x06 != 0 && second & 0x18 != 0x08);
    (data.starts_with(b"ID3") || frame).then_some((Audio, "audio/mpeg"))
}

fn preview(bytes: &[u8], kind: MediaKind) -> Result<Media> {
    if bytes.len() as u64 > MEDIA_LIMIT {
        return Err(SshError::new(
            "media_too_large",
            "Media preview is limited to 8 MiB",
        ));
    }
    match sniff(bytes) {
        // The video element also plays audio-only MP4s named `.mp4`, as it did before track sniffing.
        Some((MediaKind::Audio, "audio/mp4")) if kind == MediaKind::Video => Ok(Media {
            mime: "video/mp4",
            data: STANDARD.encode(bytes),
        }),
        Some((found, mime)) if found == kind => Ok(Media {
            mime,
            data: STANDARD.encode(bytes),
        }),
        _ => Err(SshError::new(
            "media_mislabeled",
            "The file contents do not match its video or audio type",
        )),
    }
}

/// Where GStreamer looks for plugins by default, besides the environment's own directories.
#[cfg(target_os = "linux")]
const PLUGIN_DIRS: [&str; 6] = [
    "/usr/lib/gstreamer-1.0",
    "/usr/lib64/gstreamer-1.0",
    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
    "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
    "/usr/local/lib/gstreamer-1.0",
    "/app/lib/gstreamer-1.0",
];

/// Whether one of `dirs` holds GStreamer's `autoaudiosink` plugin (gst-plugins-good).
#[cfg(target_os = "linux")]
fn has_audio_sink(dirs: impl IntoIterator<Item = std::path::PathBuf>) -> bool {
    dirs.into_iter()
        .any(|dir| dir.join("libgstautodetect.so").is_file())
}

/// Whether this client can load a media element without taking its WebView down. WebKitGTK
/// aborts its web process, and so the window, when media loads on a system without GStreamer's
/// `autoaudiosink` (WebKitGTK 2.54.2 with GStreamer 1.28.9 and no gst-plugins-good). Other
/// platforms play through the operating system. A plugin directory this does not know is not
/// found, so the preview is refused and Open with and Download remain.
#[tauri::command]
pub fn media_playback() -> bool {
    #[cfg(target_os = "linux")]
    {
        let named = [
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_PATH_1_0",
            "GST_PLUGIN_PATH",
        ]
        .into_iter()
        .filter_map(std::env::var_os)
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>());
        has_audio_sink(named.chain(PLUGIN_DIRS.into_iter().map(Into::into)))
    }
    #[cfg(not(target_os = "linux"))]
    true
}

/// One regular file of `path` as sniffed, base64 video or audio of the requested kind.
#[tauri::command]
pub async fn file_media(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    path: String,
    file_name: String,
    kind: MediaKind,
    access: AccessLease,
) -> std::result::Result<Guarded<Media>, GuardedError<SshError>> {
    access
        .run(async {
            check_directory(&path)?;
            check_file_path(&file_name)?;
            let host = Host::resolve_dir(&state, &local, &session_id, &access, &path).await?;
            let target = format!("{}/{}", path.trim_end_matches('/'), file_name);
            let bytes = host
                .read_regular(&access, target, MEDIA_LIMIT)
                .await
                .map_err(|error| match error.kind() {
                    "not_regular_file" => invalid("Media preview requires a regular file"),
                    "timeout" => SshError::new("timeout", "Reading media timed out"),
                    _ => error,
                })?;
            preview(&bytes, kind)
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use MediaKind::{Audio, Video};

    #[cfg(target_os = "linux")]
    #[test]
    fn finds_the_audio_sink_plugin_only_where_it_is_installed() {
        let without = tempfile::tempdir().unwrap();
        let with = tempfile::tempdir().unwrap();
        std::fs::write(with.path().join("libgstautodetect.so"), b"").unwrap();
        // A directory, not a file, of that name is no plugin.
        std::fs::create_dir(without.path().join("libgstautodetect.so")).unwrap();
        assert!(!has_audio_sink([
            without.path().into(),
            "/nonexistent".into()
        ]));
        assert!(has_audio_sink([without.path().into(), with.path().into()]));
        assert!(!has_audio_sink([]));
    }

    fn mp4(brand: &[u8; 4]) -> Vec<u8> {
        [&[0, 0, 0, 0x18][..], b"ftyp", brand, &[0; 8]].concat()
    }
    #[test]
    fn names_each_container_by_its_signature() {
        let cases: [(Vec<u8>, MediaKind, &str); 9] = [
            (mp4(b"isom"), Video, "video/mp4"),
            (
                include_bytes!("../tests/fixtures/media/isom-audio.m4a").to_vec(),
                Audio,
                "audio/mp4",
            ),
            (vec![0x1a, 0x45, 0xdf, 0xa3, 1], Video, "video/webm"),
            (b"OggS\0".to_vec(), Audio, "audio/ogg"),
            (b"fLaC\0".to_vec(), Audio, "audio/flac"),
            (b"RIFF\x24\0\0\0WAVEfmt ".to_vec(), Audio, "audio/wav"),
            (b"ID3\x04\0".to_vec(), Audio, "audio/mpeg"),
            (vec![0xff, 0xfb, 0x90, 0x44], Audio, "audio/mpeg"),
            (vec![0xff, 0xe3, 0x18, 0xc4], Audio, "audio/mpeg"),
        ];
        for (bytes, kind, mime) in cases {
            assert_eq!(sniff(&bytes), Some((kind, mime)), "{mime}");
        }
    }
    #[test]
    fn refuses_active_and_other_formats_and_look_alikes() {
        for bytes in [
            &b"<!doctype html><script>alert(1)</script>"[..],
            b"<svg onload='run()'>",
            b"%PDF-1.7",
            b"\x89PNG\r\n\x1a\n",
            b"RIFF\0\0\0\0WEBPVP8 ",
            // AAC in ADTS (layer 00) and a reserved MPEG version are not MPEG audio.
            &[0xff, 0xf1, 0x50, 0x80],
            &[0xff, 0xeb, 0x90, 0x44],
            b"",
        ] {
            assert_eq!(sniff(bytes), None, "{bytes:?}");
        }
    }
    fn atom(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut value = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        value.extend_from_slice(name);
        value.extend_from_slice(body);
        value
    }
    fn track(handler: &[u8; 4]) -> Vec<u8> {
        let mut body = vec![0; 24];
        body[8..12].copy_from_slice(handler);
        atom(b"trak", &atom(b"mdia", &atom(b"hdlr", &body)))
    }
    fn container(movie: &[u8]) -> Vec<u8> {
        [atom(b"ftyp", b"isom\0\0\0\0"), atom(b"moov", movie)].concat()
    }
    #[test]
    fn audio_classification_checks_every_track_and_box_boundary() {
        let sound = track(b"soun");
        let video = track(b"vide");
        let mut body = [0u8; 24];
        body[8..12].copy_from_slice(b"soun");
        let handler = atom(b"hdlr", &body);
        assert!(mp4_audio_only(&container(&sound)));
        assert!(mp4_audio_only(&container(
            &[sound.clone(), track(b"soun")].concat()
        )));
        for movie in [
            vec![],
            video.clone(),
            [sound.clone(), video].concat(),
            track(b"meta"),
            [sound.clone(), atom(b"mvex", &[])].concat(),
            atom(b"trak", &atom(b"mdia", &[])),
            atom(
                b"trak",
                &atom(b"mdia", &[handler.clone(), handler].concat()),
            ),
        ] {
            assert!(!mp4_audio_only(&container(&movie)));
        }
        for length in 0..24 {
            let mut handler = vec![0; length];
            if length >= 12 {
                handler[8..12].copy_from_slice(b"soun");
            }
            assert!(!mp4_audio_only(&container(&atom(
                b"trak",
                &atom(b"mdia", &atom(b"hdlr", &handler))
            ))));
        }
        let full = container(&sound);
        assert!(!mp4_audio_only(&full[..full.len() - 1]));
        assert!(!mp4_audio_only(
            &[full.clone(), atom(b"moov", &sound)].concat()
        ));
        assert!(!mp4_audio_only(
            &[full.clone(), atom(b"moof", &[])].concat()
        ));
        assert!(!mp4_audio_only(
            &[atom(b"ftyp", b"isom\0\0\0\0"), atom(b"mdat", &sound)].concat()
        ));
        let mut overflow = vec![0, 0, 0, 1, b'm', b'o', b'o', b'v'];
        overflow.extend_from_slice(&u64::MAX.to_be_bytes());
        assert!(!mp4_audio_only(&overflow));
        let mut extended = vec![0, 0, 0, 1, b'm', b'o', b'o', b'v'];
        extended.extend_from_slice(&((sound.len() + 16) as u64).to_be_bytes());
        extended.extend_from_slice(&sound);
        assert!(mp4_audio_only(&extended));
        let mut to_end = vec![0, 0, 0, 0, b'm', b'o', b'o', b'v'];
        to_end.extend_from_slice(&sound);
        assert!(mp4_audio_only(&to_end));
    }

    #[test]
    fn accepts_real_isom_audio_fixture() {
        let audio = include_bytes!("../tests/fixtures/media/isom-audio.m4a");
        let video = include_bytes!("../tests/fixtures/media/isom-video.mp4");
        let mixed = include_bytes!("../tests/fixtures/media/mixed-m4a.mp4");
        assert_eq!(preview(audio, Audio).unwrap().mime, "audio/mp4");
        assert_eq!(preview(audio, Video).unwrap().mime, "video/mp4");
        assert_eq!(
            preview(video, Audio).unwrap_err().kind(),
            "media_mislabeled"
        );
        assert_eq!(
            preview(mixed, Audio).unwrap_err().kind(),
            "media_mislabeled"
        );
    }

    #[test]
    fn returns_the_bytes_only_for_the_requested_kind_within_the_bound() {
        let video = mp4(b"mp42");
        let shown = preview(&video, Video).unwrap();
        assert_eq!(shown.mime, "video/mp4");
        assert_eq!(STANDARD.decode(shown.data).unwrap(), video);
        // A video named like audio, and HTML named like either, are refused.
        assert_eq!(
            preview(&video, Audio).unwrap_err().kind(),
            "media_mislabeled"
        );
        assert_eq!(
            preview(b"<html>", Video).unwrap_err().kind(),
            "media_mislabeled"
        );
        let mut oversized = mp4(b"isom");
        oversized.resize(MEDIA_LIMIT as usize + 1, 0);
        assert_eq!(
            preview(&oversized, Video).unwrap_err().kind(),
            "media_too_large"
        );
        oversized.truncate(MEDIA_LIMIT as usize);
        assert!(preview(&oversized, Video).is_ok());
    }
}
