use crate::{policy::Policy, Request, Status};
use std::{cell::RefCell, sync::mpsc};
use tauri::{Manager, Runtime};
mod platform;
thread_local! { static OWNERSHIP: RefCell<Policy<platform::Hold>> = RefCell::new(Policy::default()); }

fn clear(policy: &mut Policy<platform::Hold>) -> Result<(), String> {
    if let Some((ticket, mut hold)) = policy.active.take() {
        if let Err(error) = hold.release() {
            policy.active = Some((ticket, hold));
            return Err(error);
        }
    }
    Ok(())
}
fn reset(state: &mut Policy<platform::Hold>) -> Result<(), String> {
    let result = clear(state);
    // Keep a failed native release visible; a later operation retries it.
    let held = state.active.take();
    state.invalidate();
    state.active = held;
    result
}
pub(super) fn command<R: Runtime>(
    app: &tauri::AppHandle<R>,
    operation: &str,
    request: Option<Request>,
) -> Result<Status, String> {
    let (sent, received) = mpsc::sync_channel(1);
    let handle = app.clone();
    let operation = operation.to_owned();
    app.run_on_main_thread(move || {
        let result = OWNERSHIP.with(|cell| {
            let mut state = cell.borrow_mut();
            if operation == "invalidate" {
                reset(&mut state)?;
                return state.status(platform::supported(), platform::description().into());
            }
            if operation == "status" {
                return state.status(platform::supported(), platform::description().into());
            }
            let request = request.ok_or("Missing display ownership.")?;
            match operation.as_str() {
                "acquire" => {
                    state.admit(&request)?;
                    clear(&mut state)?;
                    let window = handle
                        .get_webview_window("main")
                        .ok_or("The display owner no longer exists.")?;
                    if !window.is_visible().map_err(|e| e.to_string())?
                        || !window.is_focused().map_err(|e| e.to_string())?
                        || window.is_minimized().map_err(|e| e.to_string())?
                    {
                        return Err("Keep awake requires a visible, focused board.".into());
                    }
                    state.active = Some((request.ticket, platform::Hold::acquire(&window)?));
                }
                "release" => {
                    if let Some(mut hold) = state.release(&request)? {
                        if let Err(error) = hold.release() {
                            state.active = Some((request.ticket, hold));
                            return Err(error);
                        }
                    }
                }
                _ => return Err("Unknown display operation.".into()),
            }
            Ok(Status {
                available: platform::supported(),
                reason: platform::description().into(),
                active: state.active.is_some(),
                epoch: request.epoch,
                ticket: request.ticket,
            })
        });
        let _ = sent.send(result);
    })
    .map_err(|e| e.to_string())?;
    received
        .recv()
        .map_err(|_| "Native display owner stopped.".to_owned())?
}
