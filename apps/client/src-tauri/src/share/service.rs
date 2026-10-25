use reqwest::Url;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Enrollment {
    pub(crate) version: u8,
    pub(crate) origin: String,
    pub(crate) token: String,
}
impl Drop for Enrollment {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
pub(crate) fn origin(value: &str, parse_error: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| parse_error)?;
    let authority = value
        .split_once("://")
        .map(|(_, address)| address.split(['/', '?', '#']).next().unwrap_or_default())
        .unwrap_or_default();
    if value.len() > 2048
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
        || authority.is_empty()
        || authority.contains('@')
        || url.scheme() != "https"
        || !url.has_host()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use an HTTPS origin without credentials, path, query or fragment".into());
    }
    Ok(url)
}
pub(crate) fn valid_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
