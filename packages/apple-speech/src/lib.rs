use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub available: bool,
    pub reason: String,
    pub supported_languages: Vec<String>,
    pub installed_languages: Vec<String>,
    pub reserved_languages: Vec<String>,
}
pub struct AppleSpeech<R: Runtime> {
    handle: lazysh_common::IosHandle<tauri::plugin::PluginHandle<R>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    language: String,
    request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    samples: Option<Vec<f32>>,
}
#[cfg(target_os = "ios")]
#[derive(Deserialize)]
struct Transcription {
    text: String,
}

fn validate(language: &str, request_id: &str, samples: Option<&[f32]>) -> Result<(), String> {
    if language.is_empty()
        || language.len() > 64
        || !language
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || request_id.len() != 36
        || uuid::Uuid::parse_str(request_id).is_err()
    {
        return Err("Invalid Apple speech language or request identifier".into());
    }
    if samples.is_some_and(|s| {
        s.len() < 1600 || s.len() > 480000 || s.iter().any(|n| !n.is_finite() || n.abs() > 1.0)
    }) {
        return Err("Audio must contain 0.1–30 seconds of finite mono 16 kHz samples".into());
    }
    Ok(())
}
#[cfg(target_os = "ios")]
fn native_error(error: tauri::plugin::mobile::PluginInvokeError) -> String {
    match error {
        tauri::plugin::mobile::PluginInvokeError::InvokeRejected(error) => error
            .message
            .unwrap_or_else(|| "Apple speech operation failed".into()),
        _ => "Apple speech service is unavailable".into(),
    }
}
impl<R: Runtime> AppleSpeech<R> {
    pub async fn capability(&self) -> Result<Capability, String> {
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async("capability", ())
                .await
                .map_err(native_error)
        }
        #[cfg(not(target_os = "ios"))]
        {
            Ok(Capability {
                available: false,
                reason: "Apple SpeechAnalyzer requires supported iOS 26+ hardware".into(),
                supported_languages: vec![],
                installed_languages: vec![],
                reserved_languages: vec![],
            })
        }
    }
    async fn model(
        &self,
        language: String,
        request_id: String,
        remove: bool,
    ) -> Result<(), String> {
        validate(&language, &request_id, None)?;
        let request = Request {
            language,
            request_id,
            samples: None,
        };
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async(
                    if remove {
                        "releaseModel"
                    } else {
                        "installModel"
                    },
                    request,
                )
                .await
                .map_err(native_error)
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (request, remove);
            Err("Apple SpeechAnalyzer is unavailable on this platform".into())
        }
    }
    pub async fn install(&self, language: String, request_id: String) -> Result<(), String> {
        self.model(language, request_id, false).await
    }
    pub async fn remove(&self, language: String, request_id: String) -> Result<(), String> {
        self.model(language, request_id, true).await
    }
    pub async fn transcribe(
        &self,
        samples: Vec<f32>,
        language: String,
        request_id: String,
    ) -> Result<String, String> {
        validate(&language, &request_id, Some(&samples))?;
        let request = Request {
            language,
            request_id,
            samples: Some(samples),
        };
        #[cfg(target_os = "ios")]
        {
            let value: Transcription = self
                .handle
                .run_mobile_plugin_async("transcribe", request)
                .await
                .map_err(native_error)?;
            if value.text.len() > 65536 {
                return Err("Apple transcription exceeds the text limit".into());
            }
            Ok(value.text)
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = request;
            Err("Apple SpeechAnalyzer is unavailable on this platform".into())
        }
    }
    pub async fn cancel(&self, request_id: String) -> Result<(), String> {
        validate("en", &request_id, None)?;
        #[cfg(target_os = "ios")]
        {
            self.handle
                .run_mobile_plugin_async(
                    "cancel",
                    Request {
                        language: "en".into(),
                        request_id,
                        samples: None,
                    },
                )
                .await
                .map_err(native_error)
        }
        #[cfg(not(target_os = "ios"))]
        {
            Ok(())
        }
    }
}
pub trait AppleSpeechExt<R: Runtime>: Manager<R> {
    fn apple_speech(&self) -> &AppleSpeech<R> {
        self.state::<AppleSpeech<R>>().inner()
    }
}
impl<R: Runtime, T: Manager<R>> AppleSpeechExt<R> for T {}
#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_lazysh_apple_speech);
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lazysh-apple-speech")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let speech = AppleSpeech {
                handle: api.register_ios_plugin(init_plugin_lazysh_apple_speech)?,
            };
            #[cfg(not(target_os = "ios"))]
            let speech = {
                let _ = api;
                AppleSpeech::<R> {
                    handle: std::marker::PhantomData,
                }
            };
            app.manage(speech);
            Ok(())
        })
        .build()
}
#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "b11c6ca6-e4f7-4f63-859c-d08e66df2239";
    #[test]
    fn boundaries_reject_invalid_audio_identifiers_and_languages() {
        assert!(validate("en-US", ID, Some(&vec![0.0; 1600])).is_ok());
        assert!(validate("en-US", "not-a-request", None).is_err());
        assert!(validate("en-US;cmd", ID, None).is_err());
        assert!(validate("en_US", ID, None).is_err());
        assert!(validate("en-US", ID, Some(&vec![f32::NAN; 1600])).is_err());
        assert!(validate("en-US", ID, Some(&vec![0.0; 480001])).is_err());
    }
}
