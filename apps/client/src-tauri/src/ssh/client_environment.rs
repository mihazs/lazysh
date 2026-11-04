//! Opt-in client marker on interactive SSH terminal channels.
//!
//! A host with `clientEnvironment` enabled asks the server to set one fixed,
//! non-secret variable before the shell or multiplexer command starts. The
//! request is sent without `want_reply`: a server whose `AcceptEnv` omits the
//! name silently ignores it, so the marker can never block or fail a terminal.
use super::{client, Result, SshHandle};

/// The name follows the established `LC_TERMINAL` convention so that the
/// common distribution default `AcceptEnv LANG LC_*` admits it unchanged.
pub(crate) const NAME: &str = "LC_TERMINAL";
pub(crate) const VALUE: &str = "lazysh";

impl SshHandle {
    /// The flag is read from the host as verified for this connection, so an
    /// edited host applies on its next connection only.
    fn sends_client_environment(&self) -> bool {
        self.origin
            .as_ref()
            .is_some_and(|host| host.client_environment)
    }
}

pub(super) async fn request(
    handle: &SshHandle,
    channel: &russh::Channel<client::Msg>,
) -> Result<()> {
    if handle.sends_client_environment() {
        channel.set_env(false, NAME, VALUE).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::Host;

    fn stored(extra: serde_json::Value) -> serde_json::Value {
        let mut host = serde_json::json!({
            "id": "h", "name": "Host", "hostname": "example.test", "port": 22, "username": "me"
        });
        host.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        host
    }

    #[test]
    fn hosts_saved_before_the_flag_load_with_it_off_and_save_unchanged() {
        let legacy = stored(serde_json::json!({}));
        let host: Host = serde_json::from_value(legacy.clone()).unwrap();
        assert!(!host.client_environment);
        let saved = serde_json::to_value(&host).unwrap();
        assert!(saved.get("clientEnvironment").is_none());
        assert_eq!(serde_json::from_value::<Host>(saved).unwrap().id, "h");
    }

    #[test]
    fn enabled_flag_round_trips_and_rejects_non_boolean_values() {
        let host: Host =
            serde_json::from_value(stored(serde_json::json!({"clientEnvironment": true}))).unwrap();
        assert!(host.client_environment);
        assert_eq!(
            serde_json::to_value(&host).unwrap()["clientEnvironment"],
            true
        );
        assert!(serde_json::from_value::<Host>(stored(
            serde_json::json!({"clientEnvironment": "yes"})
        ))
        .is_err());
    }
}
