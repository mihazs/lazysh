//! Cosmetic app locale, independent of credential or resume authority.
use crate::ui_locale::{UiLocaleChoice, UiLocaleStatus};
use objc2_foundation::{NSBundle, NSLocale, NSString, NSUserDefaults};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

const KEY: &str = "lazysh.uiLocale.v1";
static MUTATIONS: Mutex<()> = Mutex::new(());
#[derive(Serialize, Deserialize)]
struct Stored {
    choice: UiLocaleChoice,
    revision: String,
}
fn load(defaults: &NSUserDefaults) -> Result<Stored, String> {
    let Some(value) = defaults.objectForKey(&NSString::from_str(KEY)) else {
        return Ok(Stored {
            choice: UiLocaleChoice::System,
            revision: "0".into(),
        });
    };
    let value = value
        .downcast::<NSString>()
        .map_err(|_| "Invalid native UI language")?
        .to_string();
    if value.len() > 256 {
        return Err("Invalid native UI language".into());
    }
    let stored: Stored = serde_json::from_str(&value).map_err(|_| "Invalid native UI language")?;
    if stored.revision.len() != 36
        || stored.revision != stored.revision.to_ascii_lowercase()
        || uuid::Uuid::parse_str(&stored.revision).is_err()
    {
        return Err("Invalid native UI language revision".into());
    }
    Ok(stored)
}
fn resolve(choice: UiLocaleChoice, languages: impl IntoIterator<Item = String>) -> String {
    match choice {
        UiLocaleChoice::En => return "en".into(),
        UiLocaleChoice::PtBr => return "pt-BR".into(),
        UiLocaleChoice::Es => return "es".into(),
        UiLocaleChoice::System => {}
    }
    for tag in languages.into_iter().take(16) {
        if tag.len() > 80
            || tag.is_empty()
            || !tag.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || tag.split('-').any(|part| part.is_empty() || part.len() > 8)
        {
            continue;
        }
        let tag =
            NSLocale::canonicalLanguageIdentifierFromString(&NSString::from_str(&tag)).to_string();
        match tag
            .split('-')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "pt" => return "pt-BR".into(),
            "en" | "es" => return tag,
            _ => {}
        }
    }
    "en".into()
}
fn snapshot(stored: Stored) -> UiLocaleStatus {
    let languages = NSLocale::preferredLanguages();
    UiLocaleStatus {
        native_authority: true,
        resolved_locale: resolve(stored.choice, languages.iter().map(|tag| tag.to_string())),
        choice: stored.choice,
        revision: stored.revision,
    }
}
pub fn status() -> Result<UiLocaleStatus, String> {
    let _guard = MUTATIONS
        .lock()
        .map_err(|_| "Native UI language unavailable")?;
    Ok(snapshot(load(&NSUserDefaults::standardUserDefaults())?))
}
fn set_in(
    defaults: &NSUserDefaults,
    choice: UiLocaleChoice,
    expected: &str,
) -> Result<UiLocaleStatus, String> {
    let current = load(defaults)?;
    if expected.len() > 36 || current.revision != expected {
        return Err("Native UI language changed; retry".into());
    }
    if current.choice == choice {
        return Ok(snapshot(current));
    }
    let next = Stored {
        choice,
        revision: uuid::Uuid::new_v4().to_string(),
    };
    let value = NSString::from_str(
        &serde_json::to_string(&next).map_err(|_| "Invalid native UI language")?,
    );
    // NSString is a supported property-list value; UserDefaults owns persistence.
    unsafe { defaults.setObject_forKey(Some(&value), &NSString::from_str(KEY)) };
    Ok(snapshot(next))
}
pub fn set(choice: UiLocaleChoice, expected_revision: &str) -> Result<UiLocaleStatus, String> {
    let _guard = MUTATIONS
        .lock()
        .map_err(|_| "Native UI language unavailable")?;
    set_in(
        &NSUserDefaults::standardUserDefaults(),
        choice,
        expected_revision,
    )
}
pub fn text(key: &str) -> String {
    let fallback = match key {
        "resume.title" => "lazysh is locked",
        "resume.message" => "Unlock with this device's biometrics to continue.",
        "resume.unlock" => "Unlock lazysh",
        "resume.failure" => "Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry.",
        "auth.unlock" => "Unlock lazysh credentials",
        "auth.protect" => "Protect lazysh credentials",
        "action.cancel" => "Cancel",
        _ => key,
    };
    let tag = status()
        .map(|value| value.resolved_locale)
        .unwrap_or_else(|_| "en".into());
    let language = if tag.starts_with("pt") {
        "pt-BR"
    } else if tag.starts_with("es") {
        "es"
    } else {
        "en"
    };
    let Some(path) = NSBundle::mainBundle().pathForResource_ofType(
        Some(&NSString::from_str(language)),
        Some(&NSString::from_str("lproj")),
    ) else {
        return fallback.into();
    };
    let Some(bundle) = NSBundle::bundleWithPath(&path) else {
        return fallback.into();
    };
    bundle
        .localizedStringForKey_value_table(
            &NSString::from_str(key),
            Some(&NSString::from_str(fallback)),
            Some(&NSString::from_str("NativeUI")),
        )
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::AllocAnyThread;
    #[test]
    fn isolated_defaults_preserve_choice_and_reject_stale_or_corrupt_state() {
        let name = NSString::from_str(&format!("app.lazysh.locale-test.{}", uuid::Uuid::new_v4()));
        let defaults =
            NSUserDefaults::initWithSuiteName(NSUserDefaults::alloc(), Some(&name)).unwrap();
        assert_eq!(load(&defaults).unwrap().revision, "0");
        let next = set_in(&defaults, UiLocaleChoice::PtBr, "0").unwrap();
        assert_eq!(next.resolved_locale, "pt-BR");
        assert!(set_in(&defaults, UiLocaleChoice::Es, "0").is_err());
        assert_eq!(load(&defaults).unwrap().choice, UiLocaleChoice::PtBr);
        unsafe {
            defaults.setObject_forKey(
                Some(&NSString::from_str("invalid")),
                &NSString::from_str(KEY),
            )
        };
        assert!(load(&defaults).is_err());
        defaults.removePersistentDomainForName(&name);
    }
    #[test]
    fn system_choice_retains_supported_regions_and_maps_portuguese() {
        for (tags, expected) in [
            (vec!["fr", "es-MX"], "es-MX"),
            (vec!["pt-PT"], "pt-BR"),
            (vec!["en-GB"], "en-GB"),
            (vec!["ja"], "en"),
        ] {
            assert_eq!(
                resolve(UiLocaleChoice::System, tags.into_iter().map(str::to_owned)),
                expected
            );
        }
    }
}
