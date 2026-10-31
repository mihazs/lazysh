// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
// One closed navigation target contract for the native adapter and optional host.
macro_rules! navigation_target {
    ($(#[$attribute:meta])*) => {
        $(#[$attribute])*
        pub enum NavigationTarget {
            Workspace { workspace: String },
            Tab { workspace: String, tab: String },
            Pane { workspace: String, tab: String, pane: String, terminal: String },
        }
        impl NavigationTarget {
            pub(crate) fn valid(&self) -> bool {
                let (workspace, tab, pane, terminal) = match self {
                    Self::Workspace { workspace } => (workspace, None, None, None),
                    Self::Tab { workspace, tab } => (workspace, Some(tab), None, None),
                    Self::Pane { workspace, tab, pane, terminal } =>
                        (workspace, Some(tab), Some(pane), Some(terminal)),
                };
                [Some(workspace), tab, pane, terminal].into_iter().flatten().all(|value|
                    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control))
            }
        }
    };
}
pub(crate) use navigation_target;
