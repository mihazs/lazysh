// lazysh patch: full URLs never cross a frontend event boundary.
// See LAZYSH_PATCH.md for upstream provenance and the compatibility boundary.
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

pub(crate) fn parse_bounded(value: &str) -> Option<url::Url> {
    (value.len() <= 16 * 1024)
        .then(|| value.parse().ok())
        .flatten()
}

#[derive(Default)]
pub(crate) struct NativeEvents(Mutex<(u64, Vec<url::Url>)>);
impl NativeEvents {
    pub(crate) fn generation(&self) -> u64 {
        self.0.lock().unwrap().0
    }
    pub(crate) fn publish<R: Runtime>(&self, app: &AppHandle<R>, urls: Vec<url::Url>) {
        let bounded: Vec<_> = urls
            .into_iter()
            .filter(|url| url.as_str().len() <= 16 * 1024)
            .take(8)
            .collect();
        if bounded.is_empty() {
            return;
        }
        {
            let mut state = self.0.lock().unwrap();
            state.0 = state
                .0
                .checked_add(1)
                .expect("deep-link generation exhausted");
            state.1 = bounded;
        }
        let _ = app.emit("deep-link://new-url", ());
    }
    pub(crate) fn after(&self, seen: u64) -> Option<(u64, Vec<url::Url>)> {
        let state = self.0.lock().unwrap();
        (state.0 > seen).then(|| (state.0, state.1.clone()))
    }
}
