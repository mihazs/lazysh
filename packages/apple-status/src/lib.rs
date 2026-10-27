use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "ios")]
use tauri::Emitter;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub live_activities: bool,
    pub watch_paired: bool,
    pub watch_installed: bool,
    pub watch_reachable: bool,
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Approval {
    pub id: String,
    pub expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordedUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub recorded_at: Option<i64>,
    pub freshness: Freshness,
    pub fresh_until: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    Fresh,
    Stale,
    Unknown,
}
impl RecordedUsage {
    fn valid(&self, observed_at: u64) -> bool {
        let counters = [
            self.input_tokens,
            self.output_tokens,
            self.cache_read_tokens,
            self.cache_write_tokens,
        ];
        counters.iter().any(Option::is_some)
            && counters
                .iter()
                .flatten()
                .all(|n| *n <= 9_007_199_254_740_991)
            && self
                .recorded_at
                .is_none_or(|n| (-62_135_596_800..=253_402_300_799).contains(&n))
            && self
                .fresh_until
                .is_none_or(|n| n <= observed_at.saturating_add(900))
            && (self.recorded_at.is_some()
                || (self.freshness == Freshness::Unknown && self.fresh_until.is_none()))
            && (self.freshness != Freshness::Fresh || self.fresh_until.is_some())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub subscription_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub observed_at: u64,
    pub expires_at: u64,
    pub running: u16,
    pub waiting: u16,
    pub usage: Option<RecordedUsage>,
    pub approvals: Vec<Approval>,
}
fn valid_id(value: &str) -> bool {
    value.len() == 36 && uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
#[cfg(any(target_os = "ios", test))]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    subscription_id: String,
    session_id: String,
    expires_at: u64,
    approval_id: Option<String>,
}
#[cfg(any(target_os = "ios", test))]
impl Review {
    fn valid(&self, now: u64) -> bool {
        valid_id(&self.subscription_id)
            && valid_id(&self.session_id)
            && self.expires_at > now
            && self.expires_at <= now.saturating_add(65)
            && self.approval_id.as_deref().is_none_or(valid_id)
    }
}
#[cfg(any(target_os = "ios", test))]
fn review_subscription(url: &tauri::Url) -> Option<String> {
    if url.as_str().len() > 128
        || url.scheme() != "lazysh"
        || url.host_str() != Some("agents")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let id = url.path().strip_prefix('/')?;
    valid_id(id).then(|| id.to_owned())
}
fn validate(snapshot: &Snapshot, now: u64) -> Result<(), String> {
    if !valid_id(&snapshot.subscription_id)
        || !valid_id(&snapshot.session_id)
        || snapshot.sequence == 0
        || snapshot.sequence > 9_007_199_254_740_991
        || snapshot.observed_at > now.saturating_add(5)
        || snapshot.observed_at.saturating_add(60) < now
        || snapshot.expires_at <= now
        || snapshot.expires_at <= snapshot.observed_at
        || snapshot.expires_at > snapshot.observed_at.saturating_add(60)
        || snapshot.approvals.len() > 8
        || snapshot.running > 1000
        || snapshot.waiting > 1000
        || snapshot
            .usage
            .as_ref()
            .is_some_and(|usage| !usage.valid(snapshot.observed_at))
        || snapshot
            .approvals
            .iter()
            .any(|a| !valid_id(&a.id) || a.expires_at <= now)
        || snapshot
            .approvals
            .iter()
            .enumerate()
            .any(|(i, a)| snapshot.approvals[..i].iter().any(|b| a.id == b.id))
        || serde_json::to_vec(snapshot)
            .map_err(|_| "Invalid status snapshot")?
            .len()
            > 3500
    {
        return Err("Invalid or stale Apple status snapshot".into());
    }
    Ok(())
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIconStatus {
    pub available: bool,
    pub current: String,
    pub reason: String,
}
pub struct AppleStatus<R: Runtime> {
    handle: lazysh_common::IosHandle<tauri::plugin::PluginHandle<R>>,
}
impl<R: Runtime> AppleStatus<R> {
    pub async fn app_icon_status(&self) -> Result<AppIconStatus, String> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async("appIconStatus", ())
                .await
                .map_err(|_| "Cannot read the iOS app icon".into())
        }
        #[cfg(not(target_os = "ios"))]
        {
            Ok(AppIconStatus {
                available: false,
                current: "unknown".into(),
                reason: "Alternate Home Screen icons require iOS. The app icon is unchanged."
                    .into(),
            })
        }
    }
    pub async fn set_app_icon(&self, icon: String) -> Result<AppIconStatus, String> {
        if !matches!(icon.as_str(), "default" | "amber") {
            return Err("Choose a bundled lazysh app icon".into());
        }
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async("setAppIcon", serde_json::json!({"icon": icon}))
                .await
                .map_err(|error| match error {
                    tauri::plugin::mobile::PluginInvokeError::InvokeRejected(error) => error
                        .message
                        .unwrap_or_else(|| "iOS could not change the Home Screen icon".into()),
                    _ => "iOS app icon service is unavailable".into(),
                })
        }
        #[cfg(not(target_os = "ios"))]
        {
            Err("Alternate Home Screen icons require iOS".into())
        }
    }

    pub async fn capability(&self) -> Result<Capability, String> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async("capability", ())
                .await
                .map_err(|_| "Apple status capability unavailable".into())
        }
        #[cfg(not(target_os = "ios"))]
        {
            Ok(Capability {
                live_activities: false,
                watch_paired: false,
                watch_installed: false,
                watch_reachable: false,
                reason: "Live Activities and Watch connectivity require iOS".into(),
            })
        }
    }
    pub async fn configure(&self, subscription_id: String, enabled: bool) -> Result<(), String> {
        if !valid_id(&subscription_id) {
            return Err("Invalid status subscription".into());
        }
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async(
                    "configure",
                    serde_json::json!({ "subscriptionId": subscription_id, "enabled": enabled }),
                )
                .await
                .map_err(|_| "Apple status configuration failed".into())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (subscription_id, enabled);
            Err("Apple status requires iOS".into())
        }
    }
    pub async fn publish(&self, snapshot: Snapshot, start_activity: bool) -> Result<(), String> {
        validate(
            &snapshot,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "Invalid device clock")?
                .as_secs(),
        )?;
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async(
                    "publish",
                    serde_json::json!({ "snapshot": snapshot, "startActivity": start_activity }),
                )
                .await
                .map_err(|_| "Apple status update failed or subscription expired".into())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = start_activity;
            Err("Apple status requires iOS".into())
        }
    }
}
pub trait AppleStatusExt<R: Runtime>: Manager<R> {
    fn apple_status(&self) -> &AppleStatus<R> {
        self.state::<AppleStatus<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> AppleStatusExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lazysh_apple_status);
fn register_review<R: Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "ios")]
    {
        let handle = app.state::<AppleStatus<R>>().handle.clone();
        let app = app.clone();
        let review = tauri::ipc::Channel::<serde_json::Value>::new(move |response| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = response {
                if let Ok(value) = serde_json::from_str::<Review>(&json) {
                    if SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .is_ok_and(|now| value.valid(now.as_secs()))
                    {
                        let _ = app.emit("lazysh-apple-review", value);
                    }
                }
            }
            Ok(())
        });
        let registration = handle.clone();
        tauri::async_runtime::spawn(async move {
            let _ = registration
                .run_mobile_plugin_async::<()>(
                    "registerReview",
                    serde_json::json!({"review": review}),
                )
                .await;
        });
    }
    #[cfg(not(target_os = "ios"))]
    let _ = app;
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    init_with_review_registration(register_review)
}

fn init_with_review_registration<R: Runtime>(
    register: impl Fn(&tauri::AppHandle<R>) + Send + Sync + 'static,
) -> TauriPlugin<R> {
    Builder::new("lazysh-apple-status")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let status = {
                let handle = api.register_ios_plugin(init_plugin_lazysh_apple_status)?;
                AppleStatus { handle }
            };
            #[cfg(not(target_os = "ios"))]
            let status = {
                let _ = api;
                AppleStatus::<R> {
                    handle: std::marker::PhantomData,
                }
            };
            app.manage(status);
            Ok(())
        })
        .on_event(move |app, event| {
            // Tauri's iOS bridge looks up its mutable plugin registry on the calling
            // thread before dispatching commands. Wait until plugin setup is complete.
            if matches!(event, tauri::RunEvent::Ready) {
                register(app);
            }
            #[cfg(target_os = "ios")]
            if let tauri::RunEvent::Opened { urls } = event {
                if let Some(subscription_id) = urls.iter().find_map(review_subscription) {
                    if let Some(status) = app.try_state::<AppleStatus<R>>() {
                        let handle = status.handle.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = handle
                                .run_mobile_plugin_async::<()>(
                                    "openReview",
                                    serde_json::json!({"subscriptionId": subscription_id}),
                                )
                                .await;
                        });
                    }
                }
            }
            #[cfg(not(target_os = "ios"))]
            let _ = (app, event);
        })
        .build()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(desktop)]
    fn review_registration_waits_for_all_plugin_and_app_setup() {
        use std::sync::{Arc, Mutex};
        let phases = Arc::new(Mutex::new(Vec::new()));
        let registration = phases.clone();
        let later = phases.clone();
        let setup = phases.clone();
        let app = tauri::test::mock_builder()
            .plugin(init_with_review_registration(move |_| {
                registration.lock().unwrap().push("registerReview");
            }))
            .plugin(
                Builder::<_, ()>::new("later-plugin")
                    .setup(move |_, _| {
                        assert_eq!(*later.lock().unwrap(), Vec::<&str>::new());
                        later.lock().unwrap().push("later-plugin");
                        Ok(())
                    })
                    .build(),
            )
            .setup(move |app| {
                tauri::WebviewWindowBuilder::new(app, "lifecycle", tauri::WebviewUrl::default())
                    .build()?;
                assert_eq!(*setup.lock().unwrap(), vec!["later-plugin"]);
                setup.lock().unwrap().push("app-setup");
                Ok(())
            })
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        assert_eq!(*phases.lock().unwrap(), vec!["later-plugin"]);
        let ready = phases.clone();
        let exit = app.run_return(move |app, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                assert_eq!(
                    *ready.lock().unwrap(),
                    vec!["later-plugin", "app-setup", "registerReview"]
                );
                app.get_webview_window("lifecycle")
                    .unwrap()
                    .close()
                    .unwrap();
            }
        });
        assert_eq!(exit, 0);
        assert_eq!(
            *phases.lock().unwrap(),
            vec!["later-plugin", "app-setup", "registerReview"]
        );
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            subscription_id: "b11c6ca6-e4f7-4f63-859c-d08e66df2239".into(),
            session_id: "b11c6ca6-e4f7-4f63-859c-d08e66df2239".into(),
            sequence: 1,
            observed_at: 1000,
            expires_at: 1060,
            running: 1,
            waiting: 1,
            usage: None,
            approvals: vec![],
        }
    }
    #[test]
    fn activity_urls_carry_only_canonical_subscription_ids() {
        let id = "b11c6ca6-e4f7-4f63-859c-d08e66df2239";
        assert_eq!(
            review_subscription(&format!("lazysh://agents/{id}").parse().unwrap()).as_deref(),
            Some(id)
        );
        for url in [
            format!("https://agents/{id}"),
            "lazysh://agents".into(),
            format!("lazysh://agents/{id}/"),
            format!("lazysh://agents/{id}?approve=true"),
            format!("lazysh://agents/{id}#fragment"),
            format!("lazysh://user@agents/{id}"),
            format!("lazysh://agents:123/{id}"),
            format!("lazysh://agents/{}", id.to_uppercase()),
            "lazysh://agents/%2f".into(),
        ] {
            assert!(
                review_subscription(&url.parse().unwrap()).is_none(),
                "{url}"
            );
        }
    }
    #[test]
    fn review_payloads_require_matching_identity_shape_and_bounded_deadline() {
        let id = "b11c6ca6-e4f7-4f63-859c-d08e66df2239";
        let mut review = Review {
            subscription_id: id.into(),
            session_id: id.into(),
            expires_at: 1060,
            approval_id: None,
        };
        assert!(review.valid(1001));
        assert!(!review.valid(1060));
        assert!(!review.valid(900));
        review.approval_id = Some("allow".into());
        assert!(!review.valid(1001));
    }
    #[test]
    fn rejects_stale_oversized_and_unbound_snapshots() {
        assert!(validate(&snapshot(), 1001).is_ok());
        assert!(validate(&snapshot(), 1061).is_err());
        let mut value = snapshot();
        value.session_id = "session;cmd".into();
        assert!(validate(&value, 1001).is_err());
        let mut value = snapshot();
        value.expires_at = 1061;
        assert!(validate(&value, 1001).is_err());
        let mut value = snapshot();
        value.sequence = 0;
        assert!(validate(&value, 1001).is_err());
        let mut value = snapshot();
        value.approvals = vec![
            Approval {
                id: value.session_id.clone(),
                expires_at: 1100
            };
            2
        ];
        assert!(validate(&value, 1001).is_err());
    }
    #[test]
    fn inspected_reports_preserve_missing_counters_and_require_honest_freshness() {
        let mut usage = RecordedUsage {
            input_tokens: Some(120),
            output_tokens: Some(0),
            cache_read_tokens: None,
            cache_write_tokens: None,
            recorded_at: Some(900),
            freshness: Freshness::Stale,
            fresh_until: Some(1000),
        };
        assert!(usage.valid(1001));
        let encoded = serde_json::to_value(&usage).unwrap();
        assert_eq!(encoded["recordedAt"], 900);
        assert!(encoded["cacheReadTokens"].is_null());
        assert_eq!(encoded["outputTokens"], 0);
        assert!(encoded.get("totalTokens").is_none());
        usage.input_tokens = Some(u64::MAX);
        assert!(!usage.valid(1001));
        usage.input_tokens = Some(120);
        usage.freshness = Freshness::Fresh;
        usage.recorded_at = None;
        assert!(!usage.valid(1001));
        usage.recorded_at = Some(900);
        usage.fresh_until = Some(1902);
        assert!(!usage.valid(1001));
        usage.fresh_until = Some(1800);
        assert!(usage.valid(1001));
    }
}
