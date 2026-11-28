//! Opens a sign-in page on this device (the phone or desktop that runs lazysh), not on the host that
//! asked for it (ADR 0004, #1513).
//!
//! A host command (`aws sso login`, `codex login`, `gh auth login --web`) asks for a browser. The page
//! must open here. When its redirect points at the device's own `localhost:PORT`, the browser only
//! reaches the host command if a tunnel already listens on that port, so [`open`] refuses until the
//! port is held: opening first would send the user to a dead page. For a remote session the port must
//! be the one of a live flow of that session (`tunnel_id` of `start_auth_tunnel`), so a program that
//! took the port first does not pass. A local session has no tunnel: the CLI itself holds the port, and
//! a bind probe shows it.
//!
//! Phones open an in-app browser tab (Chrome Custom Tabs, `SFSafariViewController`), so lazysh stays
//! the app in front and its loopback listener stays alive; desktops open the system browser. Android
//! 10 and later refuse to start an activity from the background, and a foreground service is not an
//! exemption, so a request that arrives while another app is in front becomes a notification that
//! opens the page when tapped.
//!
//! On iOS the tab is presented by `tauri-plugin-lazysh-auth-tab`, which can close it again: [`Tab`] remembers
//! which tunnel ports the tab waits on and dismisses it when the tunnel for one of them ends (#1519).
//! Android offers no way to close another app's Custom Tab.
//!
//! Nothing here logs or stores a URL: its query carries the OAuth `state` and a PKCE challenge.
use crate::app_lock::{AccessLease, Guarded, GuardedError};
use crate::auth_tunnel::AuthTunnelState;
use crate::links::web_url;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener},
    sync::{Mutex, PoisonError},
};

type Protected<T> = Result<Guarded<T>, GuardedError<String>>;

/// Query parameters that carry the address the identity provider sends the browser back to.
const REDIRECT_KEYS: [&str; 6] = [
    "redirect_uri",
    "redirect_url",
    "redirecturi",
    "callback",
    "callback_url",
    "redirect",
];

/// Which browser a phone uses. A desktop always uses the system browser.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Browser {
    /// A tab inside lazysh: it keeps the app in front.
    #[default]
    InApp,
    /// The default browser app, which takes the user to another task.
    System,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Opened,
    /// Android with another app in front: a notification opens the page when tapped.
    Notified,
}

/// What the person should see before the page opens (the phishing guard).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    /// Plain `http` to a host that is not this device.
    Insecure,
    /// An internationalized host name (`xn--`), which can imitate another domain.
    Punycode,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    /// The host being opened, never the query.
    host: String,
    warnings: Vec<Warning>,
    /// The device ports a tunnel must listen on before the page can open: its own address and its
    /// redirect, when they are loopback addresses a tunnel serves.
    callback_ports: Vec<u16>,
}

/// The addresses a browser on this device reaches as itself.
fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
        || host
            .trim_matches(['[', ']'])
            .parse::<Ipv6Addr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// The device ports (and whether the address is `[::1]`) a page needs a tunnel on: its own address and
/// the redirect of its query (decoded twice, because some programs encode the redirect twice). A tunnel
/// serves `http` to `localhost`, `127.0.0.1` or `[::1]` on a port from 1024. Any other loopback address
/// (https, a privileged port) is nothing this feature can listen on, so it neither gates nor blocks the
/// page: it opens as any link does.
fn callbacks(url: &reqwest::Url) -> Vec<(bool, u16)> {
    let redirects = url
        .query_pairs()
        .filter(|(key, _)| REDIRECT_KEYS.contains(&key.to_ascii_lowercase().as_str()))
        .filter_map(|(_, value)| {
            reqwest::Url::parse(&percent_decode_str(&value).decode_utf8().ok()?).ok()
        });
    let mut found = Vec::new();
    for target in std::iter::once(url.clone()).chain(redirects) {
        let host = target.host_str().unwrap_or_default();
        let port = target.port().filter(|port| *port >= 1024);
        if let Some(port) = port.filter(|_| {
            target.scheme() == "http" && ["localhost", "127.0.0.1", "[::1]"].contains(&host)
        }) {
            if !found.contains(&(host == "[::1]", port)) {
                found.push((host == "[::1]", port));
            }
        }
    }
    found
}

fn inspect_validated(url: &str) -> Result<(Inspection, Vec<(bool, u16)>), String> {
    let url = reqwest::Url::parse(&web_url(url)?).map_err(|_| "Invalid browser URL")?;
    let host = url.host_str().unwrap_or_default();
    let mut warnings = Vec::new();
    if url.scheme() != "https" && !is_loopback(host) {
        warnings.push(Warning::Insecure);
    }
    if host.split('.').any(|label| label.starts_with("xn--")) {
        warnings.push(Warning::Punycode);
    }
    let callbacks = callbacks(&url);
    let inspection = Inspection {
        host: host.to_owned(),
        warnings,
        callback_ports: callbacks.iter().map(|(_, port)| *port).collect(),
    };
    Ok((inspection, callbacks))
}

/// Whether something on this device already listens on the loopback `port`: binding it fails only when
/// a listener (the tunnel) holds it. The probe closes at once and never connects, so it sends the
/// listener no byte.
fn listening(v6: bool, port: u16) -> bool {
    let address: IpAddr = if v6 {
        Ipv6Addr::LOCALHOST.into()
    } else {
        Ipv4Addr::LOCALHOST.into()
    };
    matches!(TcpListener::bind((address, port)), Err(error) if error.kind() == ErrorKind::AddrInUse)
}

/// Opens `url` through `show` once `holds` accepts every device port its redirect needs. The order is
/// the point: a page opened before the tunnel binds would send the browser to a dead port, or to
/// another program that took it. When a port is not held, nothing opens.
pub(crate) async fn open<F, Fut>(
    url: &str,
    browser: Browser,
    holds: impl Fn(bool, u16) -> bool,
    show: F,
) -> Result<Outcome, String>
where
    F: FnOnce(String, Browser) -> Fut,
    Fut: Future<Output = Result<Outcome, String>>,
{
    let url = web_url(url)?;
    if let Some((_, port)) = inspect_validated(&url)?
        .1
        .into_iter()
        .find(|(v6, port)| !holds(*v6, *port))
    {
        return Err(format!(
            "No sign-in tunnel of this session holds port {port} on this device yet, so the sign-in page was not opened. Start the sign-in tunnel first"
        ));
    }
    show(url, browser).await
}

/// [`open`] for `session_id`: a local session needs a listener on the port, a remote one needs the live
/// flow `tunnel_id` of that session on exactly that port.
pub(crate) async fn open_for<F, Fut>(
    tunnels: &AuthTunnelState,
    session_id: &str,
    tunnel_id: Option<&str>,
    url: &str,
    browser: Browser,
    show: F,
) -> Result<Outcome, String>
where
    F: FnOnce(String, Browser) -> Fut,
    Fut: Future<Output = Result<Outcome, String>>,
{
    let local = session_id.starts_with("local:");
    let flow = match tunnel_id {
        Some(id) if !local => tunnels.port_of(session_id, id).await,
        _ => None,
    };
    open(
        url,
        browser,
        |v6, port| {
            if local {
                listening(v6, port)
            } else {
                flow == Some(port)
            }
        },
        show,
    )
    .await
}

/// Something that can close the tab it presented.
pub(crate) trait Presenter {
    fn dismiss(&self);
}

impl Presenter for tauri::AppHandle {
    fn dismiss(&self) {
        use tauri_plugin_lazysh_auth_tab::AuthTabExt;
        self.auth_tab().dismiss();
    }
}

/// The device ports the presented tab waits on, when one is showing. One tab shows at a time: a new one
/// replaces the old.
#[derive(Default)]
pub struct Tab(Mutex<Option<Vec<u16>>>);

impl Tab {
    #[cfg(any(target_os = "ios", test))]
    fn shown(&self, ports: Vec<u16>) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(ports);
    }

    /// The sign-in tunnel on device `port` ended, whatever the reason: closes the tab that waited on it, once.
    /// A tab presented for another port, or no tab, is left alone.
    pub(crate) fn ended(&self, port: u16, presenter: &impl Presenter) {
        let mut shown = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if shown.as_ref().is_some_and(|ports| ports.contains(&port)) {
            *shown = None;
            drop(shown);
            presenter.dismiss();
        }
    }
}

#[cfg(target_os = "android")]
struct Handle(tauri::plugin::PluginHandle<tauri::Wry>);

/// Shows `url` in the browser of this device and says whether it opened or only notified.
async fn present(app: tauri::AppHandle, url: String, browser: Browser) -> Result<Outcome, String> {
    const FAILED: &str =
        "The browser on this device could not open this page. Copy its URL instead.";
    #[cfg(target_os = "android")]
    {
        use tauri::{plugin::mobile::PluginInvokeError, Manager};
        #[derive(Deserialize)]
        struct Reply {
            outcome: Outcome,
        }
        let host = reqwest::Url::parse(&url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned));
        app.state::<Handle>()
            .0
            .run_mobile_plugin_async::<Reply>(
                "present",
                serde_json::json!({ "url": url, "host": host, "inApp": browser == Browser::InApp }),
            )
            .await
            .map(|reply| reply.outcome)
            .map_err(|error| match error {
                PluginInvokeError::InvokeRejected(rejected)
                    if rejected.code.as_deref() == Some("notifications_blocked") =>
                {
                    "lazysh is not in front and its notifications are off. Open lazysh and try again, or allow notifications for lazysh".into()
                }
                _ => FAILED.into(),
            })
    }
    #[cfg(not(target_os = "android"))]
    {
        #[cfg(not(target_os = "ios"))]
        let _ = browser; // only iOS has an in-app tab here
        #[cfg(target_os = "ios")]
        if browser == Browser::InApp {
            use tauri::Manager;
            use tauri_plugin_lazysh_auth_tab::AuthTabExt;
            app.auth_tab().present(&url).map_err(|_| FAILED)?;
            let ports = inspect_validated(&url)?.1.into_iter().map(|(_, port)| port);
            app.state::<Tab>().shown(ports.collect());
            return Ok(Outcome::Opened);
        }
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map(|()| Outcome::Opened)
            .map_err(|_| FAILED.into())
    }
}

/// What the banner shows before asking: the host, the guard's warnings and the ports a tunnel needs.
#[tauri::command]
pub fn inspect_auth_url(
    access: AccessLease,
    url: String,
) -> std::result::Result<Guarded<Inspection>, GuardedError<String>> {
    access.run_sync(|| inspect_validated(&url).map(|(inspection, _)| inspection))
}

/// Opens a sign-in page on this device once the tunnel (`tunnel_id`, of `session_id`) its redirect needs is listening.
#[tauri::command]
pub async fn open_auth_url(
    app: tauri::AppHandle,
    access: AccessLease,
    tunnels: tauri::State<'_, AuthTunnelState>,
    session_id: String,
    tunnel_id: Option<String>,
    url: String,
    browser: Option<Browser>,
) -> Protected<Outcome> {
    access
        .run(open_for(
            &tunnels,
            &session_id,
            tunnel_id.as_deref(),
            &url,
            browser.unwrap_or_default(),
            |url, browser| present(app, url, browser),
        ))
        .await
}

/// Registers the Android half. The plugin has no renderer command: only `open_auth_url` reaches it.
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("lazysh-auth-browser")
        .invoke_handler(|invoke| {
            invoke.resolver.reject("unavailable");
            true
        })
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                _app.manage(Handle(api.register_android_plugin(
                    "app.lazysh.client",
                    "AuthBrowserPlugin",
                )?));
            }
            #[cfg(not(target_os = "android"))]
            let _ = api;
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests;
