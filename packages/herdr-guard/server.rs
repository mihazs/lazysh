// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Runs inside the actual HeadlessServer actor; never resolves global fallback.

use super::HeadlessServer;
use crate::guarded_input::protocol::{Secret, REGISTERED_KIND};
use crate::protocol::ServerMessage;

impl HeadlessServer {
    fn guard_navigation_method(
        &self,
        target: &crate::guarded_input::protocol::NavigationTarget,
    ) -> Result<Method, &'static str> {
        use crate::api::schema::{PaneTarget, TabTarget, WorkspaceTarget};
        use crate::guarded_input::protocol::NavigationTarget;
        let workspace = match target {
            NavigationTarget::Workspace { workspace }
            | NavigationTarget::Tab { workspace, .. }
            | NavigationTarget::Pane { workspace, .. } => workspace,
        };
        let workspace_index = self
            .app
            .parse_workspace_id(workspace)
            .ok_or("guard_stale")?;
        match target {
            NavigationTarget::Workspace { workspace } => {
                Ok(Method::WorkspaceFocus(WorkspaceTarget {
                    workspace_id: workspace.clone(),
                }))
            }
            NavigationTarget::Tab { tab, .. } | NavigationTarget::Pane { tab, .. } => {
                let (actual_workspace, tab_index) =
                    self.app.parse_tab_id(tab).ok_or("guard_stale")?;
                if actual_workspace != workspace_index {
                    return Err("guard_stale");
                }
                if let NavigationTarget::Pane { pane, terminal, .. } = target {
                    let (actual_workspace, pane_id) =
                        self.app.parse_pane_id(pane).ok_or("guard_stale")?;
                    let workspace = &self.app.state.workspaces[workspace_index];
                    if actual_workspace != workspace_index
                        || workspace.find_tab_index_for_pane(pane_id) != Some(tab_index)
                        || workspace.tabs[tab_index]
                            .terminal_id(pane_id)
                            .as_ref()
                            .map(ToString::to_string)
                            .as_ref()
                            != Some(terminal)
                    {
                        return Err("guard_stale");
                    }
                    Ok(Method::PaneFocus(PaneTarget {
                        pane_id: pane.clone(),
                    }))
                } else {
                    Ok(Method::TabFocus(TabTarget {
                        tab_id: tab.clone(),
                    }))
                }
            }
        }
    }

    fn guard_navigate(
        &mut self,
        params: crate::guarded_input::protocol::NavigateParams,
    ) -> Result<ResponseResult, &'static str> {
        use crate::guarded_input::protocol::NavigationSelection;
        if !params.valid() || params.cancellation.cancelled() {
            return Err("guard_invalid");
        }
        let client = self
            .guarded_input
            .as_mut()
            .ok_or("guard_unavailable")?
            .navigate(
                &params.boot,
                &params.ownership,
                params.operation,
                Instant::now(),
            )?;
        // An explicit navigation attempt retires old input even if its target vanished.
        self.guard_finish(client, Err("guard_stale"));
        if self.shutting_down
            || self.handoff_in_progress
            || params.cancellation.cancelled()
            || !self.clients.get(&client).is_some_and(|value| {
                value.is_active_shell_client()
                    && value.writer.is_some()
                    && !value.shell_endpoint_command_in_flight
            })
        {
            return Err("guard_stale");
        }
        let method = self.guard_navigation_method(&params.target)?;
        let (respond_to, receive) = std::sync::mpsc::channel();
        self.handle_client_shell_api_request(
            client,
            crate::api::ApiRequestMessage {
                request: crate::api::schema::Request {
                    id: "guard:navigate".into(),
                    method,
                },
                respond_to,
                response_write_complete: None,
            },
        );
        let reply = receive.try_recv().map_err(|_| "guard_unavailable")?;
        let _: crate::api::schema::SuccessResponse =
            serde_json::from_str(&reply).map_err(|_| "guard_stale")?;
        let focused = self.shell_focus_target(client).ok_or("guard_stale")?;
        let workspace = &self.app.state.workspaces[focused.workspace_index];
        let tab_index = workspace
            .find_tab_index_for_pane(focused.pane_id)
            .ok_or("guard_stale")?;
        let terminal = workspace.tabs[tab_index]
            .terminal_id(focused.pane_id)
            .ok_or("guard_stale")?;
        let selection = NavigationSelection {
            workspace: self.app.public_workspace_id(focused.workspace_index),
            tab: focused.tab_id,
            pane: self
                .app
                .public_pane_id(focused.workspace_index, focused.pane_id)
                .ok_or("guard_stale")?,
            terminal: terminal.to_string(),
        };
        Ok(ResponseResult::GuardNavigated { selection })
    }

    pub(super) fn guard_register(&mut self, client: u64, nonce: Secret) {
        if let Some(registry) = &mut self.guarded_input {
            let _ = registry.register(client, nonce, std::time::Instant::now());
        }
    }

    pub(super) fn guard_startup_ack(&mut self, client: u64) -> bool {
        let Some(ack) = self
            .guarded_input
            .as_mut()
            .and_then(|registry| registry.take_ack(client, std::time::Instant::now()))
        else {
            return true; // Ordinary client, or guarded startup will reject its missing acknowledgement.
        };
        let Ok(data) = serde_json::to_string(&ack) else {
            return false;
        };
        self.send_to_client(
            client,
            ServerMessage::EndpointControl {
                kind: REGISTERED_KIND.into(),
                data,
            },
        )
    }
}

impl HeadlessServer {
    pub(super) fn guard_target(
        &self,
        client_id: u64,
    ) -> Option<crate::guarded_input::protocol::Target> {
        use crate::guarded_input::protocol::{Target, Viewport};
        if self.shutting_down || self.handoff_in_progress {
            return None;
        }
        let client = self.clients.get(&client_id)?;
        if !client.is_active_shell_client()
            || client.writer.is_none()
            || client.shell_endpoint_command_in_flight
        {
            return None;
        }
        let location = client.shell_location.as_ref()?;
        let workspace = location.focused_workspace_id.as_ref()?;
        let tab_id = location.focused_tab_id()?;
        let (workspace_index, tab_index) = self.app.parse_tab_id(tab_id)?;
        if &self.app.public_workspace_id(workspace_index) != workspace {
            return None;
        }
        let tab = self
            .app
            .state
            .workspaces
            .get(workspace_index)?
            .tabs
            .get(tab_index)?;
        let pane = tab.layout.focused();
        let pane_id = self.app.public_pane_id(workspace_index, pane)?;
        let terminal_id = tab.terminal_id(pane)?;
        let terminal = terminal_id.to_string();
        let runtime_generation = self.app.terminal_runtimes.generation(terminal_id)?;
        if self.popup_owner_tab_id.as_deref() == Some(tab_id) && self.app.state.popup_pane.is_some()
        {
            return None;
        }
        let runtime = self.app.state.runtime_for_pane_in_workspace(
            &self.app.terminal_runtimes,
            workspace_index,
            pane,
        )?;
        if runtime.synchronized_output_active()
            || runtime
                .scroll_metrics()
                .is_some_and(|scroll| scroll.offset_from_bottom != 0)
        {
            return None;
        }
        let snapshot = client.shell_snapshot.as_ref()?;
        let surface = client.render_state.last_pane_surface()?;
        if snapshot.boot_id != surface.boot_id
            || snapshot.revision != surface.projection_revision
            || snapshot.focused_workspace_id.as_ref() != Some(workspace)
            || snapshot.focused_tab_id.as_deref() != Some(tab_id)
            || snapshot.focused_pane_id.as_ref() != Some(&pane_id)
            || surface.popup.is_some()
        {
            return None;
        }
        let layout = crate::ui::compute_tab_surface_for(
            &self.app.state,
            &self.app.terminal_runtimes,
            Some(crate::ui::TabSurfaceTarget {
                workspace_index,
                tab_index,
            }),
            ratatui::layout::Rect::new(0, 0, client.terminal_size.0, client.terminal_size.1),
            false,
            client.cell_size,
        );
        let info = layout
            .pane_infos
            .iter()
            .find(|info| info.id == pane && info.is_focused)?;
        let mut rendered = surface
            .panes
            .iter()
            .filter(|entry| entry.pane_id == pane_id);
        let visible = rendered.next()?;
        if rendered.next().is_some()
            || !visible.focused
            || visible.inner_rect.x != info.inner_rect.x
            || visible.inner_rect.y != info.inner_rect.y
            || visible.inner_rect.width != info.inner_rect.width
            || visible.inner_rect.height != info.inner_rect.height
        {
            return None;
        }
        let target = Target {
            workspace: workspace.clone(),
            tab: tab_id.into(),
            pane: pane_id,
            terminal,
            runtime_generation,
            viewport: Viewport {
                x: info.inner_rect.x,
                y: info.inner_rect.y,
                width: info.inner_rect.width,
                height: info.inner_rect.height,
            },
        };
        target.valid().then_some(target)
    }
}

use crate::api::schema::{ErrorBody, ErrorResponse, Method, ResponseResult, SuccessResponse};
use crate::guarded_input::protocol::{
    Cancellation, ClientChallenge, Commit, Input, PreparedReply, CHALLENGE_KIND, CHALLENGE_TTL,
};
use std::time::Instant;

pub(super) struct PendingReply {
    sender: std::sync::mpsc::Sender<String>,
    id: String,
    cancellation: Cancellation,
    admitted: Instant,
    boot: Secret,
    receipt: Secret,
    challenge: Secret,
}

fn response(id: String, outcome: Result<ResponseResult, &'static str>) -> String {
    match outcome {
        Ok(result) => serde_json::to_string(&SuccessResponse { id, result }),
        Err(code) => serde_json::to_string(&ErrorResponse {
            id,
            error: ErrorBody {
                code: code.into(),
                message: code.into(),
            },
        }),
    }
    .unwrap_or_else(|_| {
        "{\"id\":\"\",\"error\":{\"code\":\"guard_unavailable\",\"message\":\"guard_unavailable\"}}"
            .into()
    })
}

impl HeadlessServer {
    pub(super) fn guard_finish(&mut self, client: u64, outcome: Result<(), &'static str>) {
        if let Some(pending) = self.guard_replies.remove(&client) {
            if outcome.is_err() {
                if let Some(registry) = &mut self.guarded_input {
                    registry.release(&pending.boot, &pending.receipt, Instant::now());
                }
            }
            let _ = pending.sender.send(response(
                pending.id,
                outcome.map(|()| ResponseResult::Ok {}),
            ));
        }
    }

    pub(super) fn guard_expire(&mut self) {
        let now = Instant::now();
        if let Some(registry) = &mut self.guarded_input {
            registry.expire(now);
        }
        let registry = &mut self.guarded_input;
        let expired = self
            .guard_replies
            .iter()
            .filter_map(|(&client, pending)| {
                (pending.cancellation.cancelled()
                    || now.saturating_duration_since(pending.admitted) >= CHALLENGE_TTL
                    || !registry.as_mut().is_some_and(|registry| {
                        registry.pending_matches(client, &pending.boot, &pending.challenge, now)
                    }))
                .then_some(client)
            })
            .collect::<Vec<_>>();
        for client in expired {
            self.guard_finish(client, Err("guard_stale"));
        }
    }

    pub(super) fn guard_api(&mut self, message: crate::api::ApiRequestMessage) {
        self.guard_expire();
        let mut publication: Option<Cancellation> = None;
        let outcome = match message.request.method {
            Method::GuardNavigationCapabilities(params) => self
                .guarded_input
                .as_mut()
                .and_then(|registry| {
                    registry.current_owner_id(&params.boot, &params.ownership, Instant::now())
                })
                .ok_or("guard_stale")
                .map(|_| ResponseResult::GuardNavigationCapabilities {
                    schema_version: 1,
                    isolated: true,
                }),
            Method::GuardNavigate(params) => self.guard_navigate(params),
            Method::GuardClaim(params) => {
                publication = Some(params.cancellation.clone());
                self.guarded_input
                    .as_mut()
                    .ok_or("guard_unavailable")
                    .and_then(|registry| {
                        registry.claim(
                            &params.boot,
                            &params.ticket,
                            params.cancellation,
                            Instant::now(),
                        )
                    })
                    .map(|owner| ResponseResult::GuardClaimed { owner })
            }
            Method::GuardPrepare(params) => {
                publication = Some(params.cancellation.clone());
                let now = Instant::now();
                self.guarded_input
                    .as_mut()
                    .ok_or("guard_unavailable")
                    .and_then(|registry| {
                        registry.begin_preparation(
                            &params.boot,
                            &params.ownership,
                            params.preparation,
                            params.source,
                            params.cancellation,
                            now,
                        )
                    })
                    .and_then(|client| {
                        // Spending the number and retiring the prior B precedes
                        // lookup, so a failed explicit preparation cannot replay it.
                        let target = self.guard_target(client);
                        self.guarded_input
                            .as_mut()
                            .ok_or("guard_unavailable")?
                            .complete_preparation(client, target, now)
                    })
                    .map(|prepared| ResponseResult::GuardPrepared {
                        guard: PreparedReply {
                            boot: prepared.boot,
                            receipt: prepared.receipt,
                            target: prepared.target,
                            preparation: prepared.preparation,
                            source: prepared.source,
                        },
                    })
            }
            Method::GuardRelease(params) => {
                let retired = self.guarded_input.as_mut().and_then(|registry| {
                    registry.release(&params.boot, &params.receipt, Instant::now())
                });
                if let Some(client) = retired {
                    self.guard_finish(client, Err("guard_stale"));
                }
                Ok(ResponseResult::Ok {})
            }
            Method::GuardCancelPreparation(params) => {
                let retired = self.guarded_input.as_mut().and_then(|registry| {
                    registry.cancel_preparation(
                        &params.boot,
                        &params.ownership,
                        params.preparation,
                        Instant::now(),
                    )
                });
                if let Some(client) = retired {
                    self.guard_finish(client, Err("guard_stale"));
                }
                Ok(ResponseResult::Ok {})
            }
            Method::GuardRevoke(params) => {
                let retired = self.guarded_input.as_mut().and_then(|registry| {
                    registry.revoke_ownership(&params.boot, &params.ownership, Instant::now())
                });
                if let Some(client) = retired {
                    self.guard_finish(client, Err("guard_stale"));
                }
                Ok(ResponseResult::Ok {})
            }
            Method::GuardInput(params) => {
                let now = Instant::now();
                let admitted = self
                    .guarded_input
                    .as_mut()
                    .ok_or("guard_unavailable")
                    .and_then(|registry| {
                        registry.admit(
                            &params.boot,
                            &params.receipt,
                            &params.source,
                            params.operation,
                            params.input,
                            now,
                        )
                    });
                match admitted {
                    Ok(challenge) => {
                        let client = challenge.client;
                        if self.guard_replies.contains_key(&client) {
                            self.guard_finish(client, Err("guard_stale"));
                        }
                        self.guard_replies.insert(
                            client,
                            PendingReply {
                                sender: message.respond_to,
                                id: message.request.id,
                                cancellation: params.cancellation.clone(),
                                admitted: now,
                                boot: challenge.boot.clone(),
                                receipt: params.receipt,
                                challenge: challenge.nonce.clone(),
                            },
                        );
                        if params.cancellation.cancelled()
                            || self.guard_target(client).as_ref() != Some(&challenge.target)
                        {
                            self.guard_finish(client, Err("guard_stale"));
                        } else {
                            let data = serde_json::to_string(&ClientChallenge {
                                boot: challenge.boot,
                                nonce: challenge.nonce,
                                target: challenge.target,
                            });
                            let sent = match data {
                                Ok(data) => self.send_to_client(
                                    client,
                                    ServerMessage::EndpointControl {
                                        kind: CHALLENGE_KIND.into(),
                                        data,
                                    },
                                ),
                                Err(_) => false,
                            };
                            if !sent {
                                self.guard_finish(client, Err("guard_stale"));
                            }
                        }
                        return;
                    }
                    Err(code) => Err(code),
                }
            }
            _ => Err("guard_unavailable"),
        };
        if message
            .respond_to
            .send(response(message.request.id, outcome))
            .is_err()
        {
            if let Some(cancellation) = publication {
                cancellation.cancel();
            }
        }
        self.guard_expire();
    }

    pub(super) fn guard_commit(&mut self, client: u64, commit: Commit) {
        let now = Instant::now();
        // A delayed old commit must never retire a newer B or its pending input.
        if !self.guard_replies.get(&client).is_some_and(|pending| {
            pending.boot == commit.boot && pending.challenge == commit.challenge
        }) {
            return;
        }
        if !commit.accepted
            || self.guard_replies.get(&client).is_none_or(|pending| {
                pending.cancellation.cancelled()
                    || now.saturating_duration_since(pending.admitted) >= CHALLENGE_TTL
            })
        {
            self.guard_finish(client, Err("guard_stale"));
            return;
        }
        let Some(target) = self.guard_target(client) else {
            self.guard_finish(client, Err("guard_stale"));
            return;
        };
        let input = self
            .guarded_input
            .as_mut()
            .ok_or("guard_unavailable")
            .and_then(|registry| {
                registry.commit(client, &commit.boot, &commit.challenge, &target, now)
            });
        // No await/callback between live target/runtime validation, taking
        // pending authority and the single exact-runtime queue admission.
        let outcome = input.and_then(|input| {
            let (workspace, pane) = self.app.parse_pane_id(&target.pane).ok_or("guard_stale")?;
            let runtime = self
                .app
                .state
                .runtime_for_pane_in_workspace(&self.app.terminal_runtimes, workspace, pane)
                .ok_or("guard_stale")?;
            let bytes = match input {
                Input::Send { text } => {
                    let mut text = if text.contains(['\n', '\t']) {
                        crate::server::terminal_attach::paste_payload_for_runtime(runtime, &text)
                    } else {
                        text
                    };
                    text.push('\r');
                    text.into_bytes()
                }
                Input::RequestStop => vec![0x1b],
            };
            runtime
                .try_send_bytes(bytes::Bytes::from(bytes))
                .map_err(|_| "guard_uncertain")
        });
        self.guard_finish(client, outcome);
    }
}
