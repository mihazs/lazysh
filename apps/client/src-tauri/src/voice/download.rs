use reqwest::{redirect::Policy, Client, Url};
use std::time::Duration;

pub(super) fn https_without_credentials(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none_or(|port| port == 443)
}

pub(super) fn client(
    publisher_url: fn(&Url) -> bool,
    redirect_error: &'static str,
) -> reqwest::Result<Client> {
    Client::builder()
        .no_proxy()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .redirect(Policy::custom(move |attempt| {
            if attempt.previous().len() > 5 || !publisher_url(attempt.url()) {
                attempt.error(redirect_error)
            } else {
                attempt.follow()
            }
        }))
        .build()
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn model_client_rejects_plain_http_before_network_io() {
        let client = super::client(|_| true, "Unexpected redirect").unwrap();
        let error = client
            .get("http://127.0.0.1:1/model")
            .send()
            .await
            .unwrap_err();
        assert!(error.is_builder());
    }
}
