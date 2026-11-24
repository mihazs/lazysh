//! Fonts the user imported in Preferences, for the native renderer (#2223). The WebView keeps them in IndexedDB, which the
//! renderer cannot read, so the page hands the bytes of each font it selected to the app once
//! (`native_terminal_font_import`), under the CSS family name it also puts first in the preferences' `font-family` list
//! (`fonts.ts`: `lazysh-font-<id>-primary` and `-cjk`). A renderer host registers the ones that list names before the machine's
//! fonts, so they draw ahead of everything else, and a CJK font only for the ranges `fonts.ts` gives it, as in xterm.js.
//! The bytes are the user's own and unchecked until here: they must read as a font, and at most [`MAX_HELD`] are kept.
#![cfg_attr(not(native_terminal_core), allow(dead_code))]

use crate::app_lock::{AccessLease, Guarded, GuardedError};
use std::sync::{Arc, Mutex, PoisonError};

type AccessResult<T> = Result<Guarded<T>, GuardedError<String>>;

/// `fonts.ts`: one font file is at most 24 MiB, and four are kept (a primary and a CJK font are selected at a time).
pub(crate) const MAX_FONT_BYTES: usize = 24 * 1024 * 1024;
const MAX_HELD: usize = 4;
const MAX_FAMILY: usize = 128;
/// The scalars `fonts.ts` gives an imported CJK font as its `unicodeRange`, so Latin text never leaves the primary font.
pub(crate) const CJK_RANGES: [(u32, u32); 7] = [
    (0x1100, 0x11FF),
    (0x2E80, 0x9FFF),
    (0xA960, 0xA97F),
    (0xAC00, 0xD7FF),
    (0xF900, 0xFAFF),
    (0xFF00, 0xFFEF),
    (0x20000, 0x3FFFF),
];

#[derive(Clone)]
pub(crate) struct ImportedFont {
    pub(crate) family: String,
    /// Draws only [`CJK_RANGES`].
    pub(crate) cjk: bool,
    /// The font file, owned once and shared by every library that registers it.
    pub(crate) bytes: Arc<[u8]>,
}

impl std::fmt::Debug for ImportedFont {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "ImportedFont({}, {} bytes)",
            self.family,
            self.bytes.len()
        )
    }
}

/// The same font under the same name: a renderer whose look names it has nothing to rebuild.
impl PartialEq for ImportedFont {
    fn eq(&self, other: &Self) -> bool {
        self.family == other.family
            && self.cjk == other.cjk
            && Arc::ptr_eq(&self.bytes, &other.bytes)
    }
}

/// The fonts kept, oldest first.
#[derive(Default)]
struct Held(Vec<ImportedFont>);

impl Held {
    /// Keeps `font`, replacing the one of its family and the oldest beyond [`MAX_HELD`].
    fn hold(&mut self, font: ImportedFont) {
        self.0
            .retain(|known| normal(&known.family) != normal(&font.family));
        self.0.push(font);
        let extra = self.0.len().saturating_sub(MAX_HELD);
        self.0.drain(..extra);
    }

    fn forget(&mut self, family: &str) {
        self.0
            .retain(|known| normal(&known.family) != normal(family));
    }

    /// The fonts kept that `families` (a CSS `font-family` list, split) names, in the order it names them.
    fn named(&self, families: &[String]) -> Vec<ImportedFont> {
        let mut found: Vec<ImportedFont> = Vec::new();
        for family in families.iter().map(|family| normal(family)) {
            let known = self.0.iter().find(|known| normal(&known.family) == family);
            if let Some(known) = known.filter(|known| !found.contains(known)) {
                found.push(known.clone());
            }
        }
        found
    }
}

static HELD: Mutex<Held> = Mutex::new(Held(Vec::new()));

fn held() -> std::sync::MutexGuard<'static, Held> {
    HELD.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How a family list names a family: no quotes or outer spaces, and no case, as the renderer compares them.
fn normal(name: &str) -> String {
    name.trim().trim_matches(['\'', '"']).trim().to_lowercase()
}

pub(crate) fn hold(font: ImportedFont) {
    held().hold(font);
}

pub(crate) fn forget(family: &str) {
    held().forget(family);
}

pub(crate) fn named(families: &[String]) -> Vec<ImportedFont> {
    held().named(families)
}

/// What a page may name a font: one CSS family, which can neither end the list nor inject another.
fn valid_family(family: &str) -> bool {
    !normal(family).is_empty()
        && family.len() <= MAX_FAMILY
        && !family
            .chars()
            .any(|c| c.is_control() || matches!(c, ',' | '\'' | '"' | ';' | '\\'))
}

#[cfg(any(native_terminal_core, test))]
fn font_bytes(body: &tauri::ipc::InvokeBody) -> Result<Arc<[u8]>, String> {
    use tauri::ipc::InvokeBody;

    let byte_count = match body {
        InvokeBody::Raw(bytes) => bytes.len(),
        InvokeBody::Json(serde_json::Value::Array(bytes)) => bytes.len(),
        _ => return Err("The font must be sent as bytes".into()),
    };
    if !(12..=MAX_FONT_BYTES).contains(&byte_count) {
        return Err("A font file is 12 bytes to 24 MiB".into());
    }
    // Android's Tauri postMessage transport serializes Uint8Array as a JSON array.
    match body {
        InvokeBody::Raw(bytes) => Ok(bytes.as_slice().into()),
        InvokeBody::Json(serde_json::Value::Array(bytes)) => bytes
            .iter()
            .map(|byte| byte.as_u64().and_then(|value| u8::try_from(value).ok()))
            .collect::<Option<Vec<_>>>()
            .map(Arc::from)
            .ok_or_else(|| "The font must be sent as bytes".into()),
        _ => unreachable!("the body type was checked above"),
    }
}

/// Takes a font from the page: the family in `x-lazysh-font-family`, `x-lazysh-font-role` (`primary` or `cjk`) and the
/// font file as the body. Refused unless the bytes read as a font.
#[cfg(native_terminal_core)]
fn import(request: &tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
    };
    let family = header("x-lazysh-font-family").ok_or("The font has no family name")?;
    let cjk = match header("x-lazysh-font-role") {
        Some("primary") => false,
        Some("cjk") => true,
        _ => return Err("The font's role is primary or cjk".into()),
    };
    if !valid_family(family) {
        return Err("The font's family name is not one CSS family".into());
    }
    let font = ImportedFont {
        family: family.into(),
        cjk,
        bytes: font_bytes(request.body())?,
    };
    // The bytes are the user's: refuse what the renderer cannot read, so no host meets it.
    font.register(&mut lazysh_terminal_renderer_wgpu::FontLibrary::new())
        .map_err(|error| format!("The font cannot be read: {error:?}"))?;
    hold(font);
    Ok(())
}

#[cfg(native_terminal_core)]
impl ImportedFont {
    /// Registers the font in `library` under its family name, restricted to the CJK ranges for a CJK font.
    pub(crate) fn register(
        &self,
        library: &mut lazysh_terminal_renderer_wgpu::FontLibrary,
    ) -> Result<(), lazysh_terminal_renderer_wgpu::FontError> {
        library.add(&self.family, false, false, self.bytes.clone(), 0)?;
        if self.cjk {
            library.restrict(&self.family, CJK_RANGES.map(|(first, last)| first..=last))?;
        }
        Ok(())
    }
}

/// The page hands over a font it selected, as the bytes of its file (`Uint8Array`) with its family and role in headers.
#[tauri::command]
pub async fn native_terminal_font_import(
    lease: AccessLease,
    request: tauri::ipc::Request<'_>,
) -> AccessResult<()> {
    lease
        .run(async {
            #[cfg(native_terminal_core)]
            {
                crate::native_fonts::import(&request)
            }
            #[cfg(not(native_terminal_core))]
            {
                let _ = &request;
                Err("This build has no native terminal renderer.".to_string())
            }
        })
        .await
}

/// The page no longer uses a font: the app lets go of its bytes. A renderer that has the font keeps drawing with it until its
/// look changes.
#[tauri::command]
pub async fn native_terminal_font_forget(lease: AccessLease, family: String) -> AccessResult<()> {
    lease
        .run(async {
            forget(&family);
            Ok(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn font(family: &str, cjk: bool) -> ImportedFont {
        ImportedFont {
            family: family.into(),
            cjk,
            bytes: Arc::from(vec![0; 16]),
        }
    }

    #[test]
    fn android_json_font_bytes_match_the_raw_body_and_reject_invalid_values() {
        use tauri::ipc::InvokeBody;

        let bytes = vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 128, 255];
        let raw = font_bytes(&InvokeBody::Raw(bytes.clone())).unwrap();
        let json = font_bytes(&InvokeBody::Json(serde_json::json!(bytes))).unwrap();
        assert_eq!(raw, json);

        for invalid in [
            serde_json::json!(null),
            serde_json::json!([]),
            serde_json::json!([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 128, 256]),
        ] {
            assert!(font_bytes(&InvokeBody::Json(invalid)).is_err());
        }
    }

    #[test]
    fn a_family_list_names_the_fonts_it_wants_in_its_order_and_a_font_replaces_its_family() {
        let (a, b) = (font("font-a", false), font("font-b", true));
        let mut fonts = Held::default();
        fonts.hold(a.clone());
        fonts.hold(b.clone());
        let list = |names: &[&str]| {
            names
                .iter()
                .map(|name| name.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fonts.named(&list(&["monospace", "'FONT-b'", " \"font-a\" ", "font-b"])),
            [b.clone(), a.clone()],
            "in the list's order, each once, whatever the quoting and case"
        );
        let newer = font("font-a", false);
        fonts.hold(newer.clone());
        assert_eq!(
            fonts.named(&list(&["font-a"])),
            std::slice::from_ref(&newer)
        );
        assert_ne!(newer, a, "the same name but other bytes is another font");
        fonts.forget("font-a");
        fonts.forget("FONT-b");
        assert!(fonts.named(&list(&["font-a", "font-b"])).is_empty());
    }

    #[test]
    fn only_the_newest_fonts_are_kept() {
        let mut fonts = Held::default();
        let all: Vec<String> = (0..MAX_HELD + 2).map(|n| format!("font-{n}")).collect();
        all.iter()
            .for_each(|family| fonts.hold(font(family, false)));
        let kept = fonts.named(&all);
        assert_eq!(kept.len(), MAX_HELD);
        assert_eq!(kept[0].family, "font-2");
        assert_eq!(
            kept.last().unwrap().family,
            format!("font-{}", MAX_HELD + 1)
        );
    }

    #[test]
    fn the_process_wide_store_hands_a_font_to_whoever_names_it() {
        let family = "lazysh-test-process-wide";
        hold(font(family, true));
        assert_eq!(named(&[family.to_string()]).len(), 1);
        forget(family);
        assert!(named(&[family.to_string()]).is_empty());
    }

    #[test]
    fn a_page_may_name_one_css_family_and_nothing_else() {
        for good in [
            "lazysh-font-0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9-primary",
            "Some Mono",
        ] {
            assert!(valid_family(good), "{good}");
        }
        for bad in [
            "",
            "  ",
            "''",
            "a, b",
            "a;b",
            "a\"b",
            "a\\b",
            "a\nb",
            &"x".repeat(MAX_FAMILY + 1),
        ] {
            assert!(!valid_family(bad), "{bad:?}");
        }
    }
}
