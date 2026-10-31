// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Private bounded JSON socket lane. It never logs caller correlation, secrets
//! or payloads. Cancellation is observed, not instantaneous socket atomicity.

use super::*;
use crate::guarded_input::protocol::{
    valid_operation, CancelPreparationParams, Cancellation, ReleaseParams, CHALLENGE_TTL,
    MAX_ENVELOPE,
};

struct Abandon {
    cancellation: Cancellation,
    cleanup: Option<Method>,
    api: ApiRequestSender,
    completed: bool,
}
impl Drop for Abandon {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        self.cancellation.cancel();
        if let Some(method) = self.cleanup.take() {
            // Wake the existing actor for cleanup; never resend an operation.
            let (respond_to, _receive) = std::sync::mpsc::channel();
            let _ = self.api.send(ApiRequestMessage {
                request: Request {
                    id: "guard:abandon".into(),
                    method,
                },
                respond_to,
                response_write_complete: None,
            });
        }
    }
}

pub(super) fn serve(
    mut stream: LocalStream,
    request: Request,
    envelope_len: usize,
    api: &ApiRequestSender,
    running: &Arc<AtomicBool>,
) -> io::Result<()> {
    let valid = envelope_len <= MAX_ENVELOPE
        && match &request.method {
            Method::GuardClaim(_)
            | Method::GuardRelease(_)
            | Method::GuardRevoke(_)
            | Method::GuardNavigationCapabilities(_) => true,
            Method::GuardNavigate(params) => params.valid(),
            Method::GuardCancelPreparation(params) => valid_operation(params.preparation),
            Method::GuardPrepare(params) => params.valid(),
            Method::GuardInput(params) => params.valid(),
            _ => false,
        };
    if !valid {
        return write_text_line_allow_disconnect(
            &mut stream,
            &error_response_json(request.id, "guard_invalid", "guard_invalid".into()),
        );
    }
    let id = request.id.clone();
    let method = api_method_name(&request.method);
    let (cancellation, cleanup) = match &request.method {
        Method::GuardClaim(params) => (params.cancellation.clone(), None),
        Method::GuardNavigate(params) => (params.cancellation.clone(), None),
        Method::GuardPrepare(params) => (
            params.cancellation.clone(),
            Some(Method::GuardCancelPreparation(CancelPreparationParams {
                boot: params.boot.clone(),
                ownership: params.ownership.clone(),
                preparation: params.preparation,
            })),
        ),
        Method::GuardInput(params) => (
            params.cancellation.clone(),
            Some(Method::GuardRelease(ReleaseParams {
                boot: params.boot.clone(),
                receipt: params.receipt.clone(),
            })),
        ),
        _ => (Cancellation::default(), None),
    };
    let mut abandon = Abandon {
        cancellation,
        cleanup,
        api: api.clone(),
        completed: false,
    };
    crate::logging::api_request_started("guard", method, false);
    set_local_stream_polling(&mut stream, true)?;
    let (respond_to, receive) = std::sync::mpsc::channel();
    if api
        .send(ApiRequestMessage {
            request,
            respond_to,
            response_write_complete: None,
        })
        .is_err()
    {
        return finish(&mut stream, &id, method, Err("guard_unavailable"));
    }
    let deadline = std::time::Instant::now() + CHALLENGE_TTL + Duration::from_millis(100);
    loop {
        match receive.try_recv() {
            Ok(response) => {
                let result = finish(&mut stream, &id, method, Ok(response));
                abandon.completed = result.is_ok();
                return result;
            }
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                return finish(&mut stream, &id, method, Err("guard_unavailable"));
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
        }
        if should_stop_connection(&mut stream, running)? {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return finish(&mut stream, &id, method, Err("guard_stale"));
        }
        std::thread::sleep(CONNECTION_POLL_INTERVAL);
    }
}

fn finish(
    stream: &mut LocalStream,
    id: &str,
    method: &'static str,
    response: Result<String, &'static str>,
) -> io::Result<()> {
    set_local_stream_polling(stream, false)?;
    let response =
        response.unwrap_or_else(|code| error_response_json(id.into(), code, code.into()));
    let result = write_text_line(stream, &response);
    if result.is_ok() {
        crate::logging::api_request_completed(
            "guard",
            method,
            api_response_outcome(&response),
            false,
        );
    } else {
        crate::logging::api_request_failed("guard", method, "guard_transport_closed");
    }
    result
}

#[cfg(all(test, unix))]
#[path = "api_tests.rs"]
mod tests;
