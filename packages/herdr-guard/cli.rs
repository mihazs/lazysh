// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Explicit private stdin API. Neither capability secrets nor text enter argv.

use crate::api::schema::Request;
use crate::guarded_input::protocol::{decode, MAX_ENVELOPE};
use std::io::{self, Read};

pub(super) fn run(args: &[String]) -> io::Result<i32> {
    if !args.is_empty() || crate::cli::target::is_remote() {
        eprintln!("guard_unavailable");
        return Ok(2);
    }
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take((MAX_ENVELOPE + 1) as u64)
        .read_to_end(&mut bytes)?;
    let mut request = match decode::<Request>(&bytes) {
        Ok(request) => request,
        Err(_) => {
            eprintln!("guard_invalid");
            return Ok(2);
        }
    };
    if !crate::guarded_input::protocol::is_guard_method(&request.method) {
        eprintln!("guard_invalid");
        return Ok(2);
    }
    // Caller correlation must not accidentally turn a ticket into a log field.
    request.id = "guard".into();
    match crate::cli::send_request(&request) {
        Ok(response) => crate::cli::print_response(&response),
        Err(_) => {
            eprintln!("guard_unavailable");
            Ok(1)
        }
    }
}
