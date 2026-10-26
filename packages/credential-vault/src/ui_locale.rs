//! Cosmetic native UI preferences, independent of foreground access authority.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum UiLocaleChoice {
    #[serde(rename = "system")]
    System,
    #[serde(rename = "en")]
    En,
    #[serde(rename = "pt-BR")]
    PtBr,
    #[serde(rename = "es")]
    Es,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLocaleStatus {
    pub native_authority: bool,
    pub choice: UiLocaleChoice,
    pub resolved_locale: String,
    pub revision: String,
}
impl UiLocaleStatus {
    #[cfg(any(all(desktop, not(target_os = "macos")), test))]
    pub(crate) fn frontend_authority() -> Self {
        Self {
            native_authority: false,
            choice: UiLocaleChoice::System,
            resolved_locale: "en".into(),
            revision: "0".into(),
        }
    }
    #[cfg(any(mobile, target_os = "macos", test))]
    pub(crate) fn validate(self) -> Result<Self, String> {
        let locale = &self.resolved_locale;
        if !self.native_authority
            || locale.is_empty()
            || locale.len() > 80
            || !locale
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || !(locale == "pt-BR"
                || locale == "en"
                || locale.starts_with("en-")
                || locale == "es"
                || locale.starts_with("es-"))
            || !valid_revision(&self.revision)
        {
            return Err("Native interface language is unavailable".into());
        }
        Ok(self)
    }
}
pub fn valid_revision(value: &str) -> bool {
    value == "0" || (value.len() == 36 && uuid::Uuid::parse_str(value).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosmetic_choices_and_status_are_bounded() {
        for choice in ["system", "en", "pt-BR", "es"] {
            assert!(serde_json::from_value::<UiLocaleChoice>(serde_json::json!(choice)).is_ok());
        }
        for choice in [
            serde_json::json!("pt-PT"),
            serde_json::json!({}),
            serde_json::json!("../es"),
        ] {
            assert!(serde_json::from_value::<UiLocaleChoice>(choice).is_err());
        }
        let mut status = UiLocaleStatus::frontend_authority();
        status.native_authority = true;
        status.resolved_locale = "es-MX".into();
        assert!(status.clone().validate().is_ok());
        status.revision = "unbounded user input".into();
        assert!(status.validate().is_err());
    }
}
