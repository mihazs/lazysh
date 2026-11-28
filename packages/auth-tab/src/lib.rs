//! The iOS sign-in tab: an `SFSafariViewController` that lazysh presents itself, so it can dismiss it
//! when the sign-in tunnel closes (#1519). Only iOS can close such a tab; elsewhere nothing presents
//! one, so [`AuthTab::present`] refuses and [`AuthTab::dismiss`] does nothing.
use tauri::{plugin::TauriPlugin, Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_auth_tab);

pub struct AuthTab<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: tauri::plugin::PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> AuthTab<R> {
    /// Presents `url` in a tab over lazysh, replacing a tab this plugin presented before.
    pub fn present(&self, url: &str) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        return self
            .handle
            .run_mobile_plugin::<()>("present", serde_json::json!({ "url": url }))
            .map_err(|error| error.to_string());
        #[cfg(not(target_os = "ios"))]
        {
            let _ = url;
            Err("The in-app sign-in tab exists only on iOS".into())
        }
    }

    /// Dismisses the tab this plugin presented, if one is still showing.
    pub fn dismiss(&self) {
        #[cfg(target_os = "ios")]
        let _ = self.handle.run_mobile_plugin::<()>("dismiss", ());
    }
}

pub trait AuthTabExt<R: Runtime> {
    fn auth_tab(&self) -> &AuthTab<R>;
}

impl<R: Runtime, T: Manager<R>> AuthTabExt<R> for T {
    fn auth_tab(&self) -> &AuthTab<R> {
        self.state::<AuthTab<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("lazysh-auth-tab")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let tab = AuthTab::<R> {
                handle: api.register_ios_plugin(init_plugin_auth_tab)?,
            };
            #[cfg(not(target_os = "ios"))]
            let tab = {
                let _ = api;
                AuthTab::<R> {
                    _runtime: std::marker::PhantomData,
                }
            };
            app.manage(tab);
            Ok(())
        })
        .build()
}
