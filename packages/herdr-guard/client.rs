// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Local eligibility is checked only in the owning event-loop turn. It is not
//! server-side atomic state and must not be described as true after commit.

use super::state::{ClientShellMode, ClientShellState};
use crate::client::endpoint::ClientEndpointId;
use crate::guarded_input::protocol::Target;

impl ClientShellState {
    pub(crate) fn guarded_input_eligible(
        &self,
        endpoint: &ClientEndpointId,
        generation: u64,
        target: &Target,
    ) -> bool {
        if &self.active_endpoint_id != endpoint
            || self.active_snapshot_generation != Some(generation)
            || self.pane_surface_generation != Some(generation)
            || !matches!(self.mode, ClientShellMode::Terminal)
            || self.overlay.is_some()
            || self.copy_mode.is_some()
            || self.selection.is_some()
            || self.selection_autoscroll.is_some()
            || self.word_selection_gesture.is_some()
            || self.pane_mouse_gesture.is_some()
            || self.chrome_drag.is_some()
            || self.workspace_press.is_some()
            || self.tab_press.is_some()
            || self.popup_terminal_id.is_some()
            || self.popup_pending
            || self.pending_pane_surface.is_some()
            || self.pending_workspace_highlight.is_some()
            || self.pending_agent_reveal.is_some()
            || !self.pending_requests.is_empty()
            || self.copy_operation_in_flight
            || !self.copy_operation_queue.is_empty()
            || !self.copy_input_queue.is_empty()
            || !self.pane_scroll_in_flight.is_empty()
            || !self.pane_scroll_queued.is_empty()
            || !self.pane_scroll_targets.is_empty()
            || self.visible_notification.is_some()
            || self.visible_endpoint_notice.is_some()
        {
            return false;
        }
        let (Some(snapshot), Some(surface)) = (&self.snapshot, &self.pane_surface) else {
            return false;
        };
        if snapshot.boot_id != surface.boot_id
            || snapshot.revision != surface.projection_revision
            || snapshot.focused_workspace_id.as_deref() != Some(target.workspace.as_str())
            || snapshot.focused_tab_id.as_deref() != Some(target.tab.as_str())
            || snapshot.focused_pane_id.as_deref() != Some(target.pane.as_str())
            || surface.popup.is_some()
        {
            return false;
        }
        let mut projected = snapshot
            .panes
            .iter()
            .filter(|pane| pane.pane_id == target.pane);
        let Some(pane) = projected.next() else {
            return false;
        };
        if projected.next().is_some()
            || !pane.focused
            || pane.workspace_id != target.workspace
            || pane.tab_id != target.tab
        {
            return false;
        }
        let mut rendered = surface
            .panes
            .iter()
            .filter(|pane| pane.pane_id == target.pane);
        let Some(pane) = rendered.next() else {
            return false;
        };
        rendered.next().is_none()
            && pane.focused
            && pane.inner_rect.x == target.viewport.x
            && pane.inner_rect.y == target.viewport.y
            && pane.inner_rect.width == target.viewport.width
            && pane.inner_rect.height == target.viewport.height
            && pane
                .scroll
                .as_ref()
                .is_none_or(|scroll| scroll.offset_from_bottom == 0)
    }
}
