//! What a Claude Code session has loaded, as its attachment records say: MCP servers (and whether they
//! connected), skills, agent types and instruction files, for the Agent view's info sheet.
//!
//! Only bounded names are copied: never an instruction text, a skill description, an error message
//! or a full path. Absent means not recorded; a list that is empty is left out.
use super::session_info::name;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_SERVERS: usize = 50;
const MAX_SKILLS: usize = 200;
const MAX_AGENTS: usize = 100;
const MAX_FILES: usize = 32;

/// The strings of `list[key]`, or the `name` of its objects (a server may be listed either way).
fn names<'a>(list: &'a Value, key: &str) -> impl Iterator<Item = &'a str> {
    list[key]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| name(item).or_else(|| name(&item["name"])))
}

/// Tool names put a server in the form `mcp__<server>__<tool>`, with every character outside
/// letters, digits, `_` and `-` of the server's name replaced by `_`.
fn mcp_server_key(tool: &str) -> Option<&str> {
    tool.strip_prefix("mcp__")?.split_once("__").map(|(s, _)| s)
}
fn tool_key(server: &str) -> String {
    server
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// An instruction file as its folder and file name (`app/CLAUDE.md`) and its kind (`User`, `Project`).
fn file_entry(path: &Value, kind: &Value) -> Option<(String, String)> {
    let mut parts = path
        .as_str()?
        .rsplit(['/', '\\'])
        .filter(|part| !part.is_empty());
    let file = parts.next()?;
    let shown = parts
        .next()
        .map_or(file.to_owned(), |dir| format!("{dir}/{file}"));
    Some((
        name(&json!(shown))?.to_owned(),
        name(kind).unwrap_or_default().to_owned(),
    ))
}

#[derive(Default)]
pub(super) struct Roster {
    servers: BTreeSet<String>,
    tools: BTreeMap<String, BTreeSet<String>>,
    failed: BTreeSet<String>,
    pending: BTreeSet<String>,
    skills: BTreeSet<String>,
    agents: BTreeSet<String>,
    files: Vec<(String, String)>,
}

impl Roster {
    /// Feed every record in order; a later attachment replaces or extends what an earlier one said.
    pub(super) fn apply(&mut self, record: &Value) {
        if record["type"] != "attachment" || record["isSidechain"] == true {
            return;
        }
        let attachment = &record["attachment"];
        match attachment["type"].as_str() {
            Some("mcp_instructions_delta") => {
                self.servers
                    .extend(names(attachment, "addedNames").map(str::to_owned));
                for removed in names(attachment, "removedNames") {
                    self.servers.remove(removed);
                }
            }
            Some("deferred_tools_delta") => {
                for tool in names(attachment, "addedNames").chain(names(attachment, "readdedNames"))
                {
                    self.add_tool(tool);
                }
                for tool in names(attachment, "removedNames") {
                    if let Some(set) = mcp_server_key(tool).and_then(|s| self.tools.get_mut(s)) {
                        set.remove(tool);
                    }
                }
                // Each delta that carries the lists restates which servers are failing or starting.
                for (key, set) in [
                    ("failedMcpServers", &mut self.failed),
                    ("pendingMcpServers", &mut self.pending),
                ] {
                    if attachment[key].is_array() {
                        *set = names(attachment, key).map(str::to_owned).collect();
                    }
                }
            }
            Some("deferred_tools_record") => {
                for tool in names(attachment, "entries") {
                    self.add_tool(tool);
                }
            }
            Some("skill_listing") => {
                if attachment["isInitial"] == true {
                    self.skills.clear();
                }
                self.skills
                    .extend(names(attachment, "names").map(str::to_owned));
            }
            Some("invoked_skills") => {
                self.skills
                    .extend(names(attachment, "skills").map(str::to_owned));
            }
            Some("agent_listing_delta") => {
                if attachment["isInitial"] == true {
                    self.agents.clear();
                }
                self.agents
                    .extend(names(attachment, "addedTypes").map(str::to_owned));
                for removed in names(attachment, "removedTypes") {
                    self.agents.remove(removed);
                }
            }
            Some("instructions") => {
                self.files = attachment["files"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|file| file_entry(&file["path"], &file["type"]))
                    .take(MAX_FILES)
                    .collect();
            }
            // A memory file the agent read on demand; the reader may open it again.
            Some("nested_memory") => {
                if let Some(entry) = file_entry(&attachment["path"], &attachment["content"]["type"])
                {
                    if self.files.len() < MAX_FILES && !self.files.contains(&entry) {
                        self.files.push(entry);
                    }
                }
            }
            _ => {}
        }
    }

    fn add_tool(&mut self, tool: &str) {
        if let Some(server) = mcp_server_key(tool) {
            self.tools
                .entry(server.to_owned())
                .or_default()
                .insert(tool.to_owned());
        }
    }

    pub(super) fn into_value(self) -> Option<Value> {
        let mut known: BTreeSet<String> = self
            .servers
            .iter()
            .chain(&self.failed)
            .chain(&self.pending)
            .cloned()
            .collect();
        // A server that only its tools name (no instruction block) is listed under the form tools use.
        let keys: BTreeSet<String> = known.iter().map(|server| tool_key(server)).collect();
        known.extend(
            self.tools
                .keys()
                .filter(|key| !keys.contains(*key))
                .cloned(),
        );
        let mcp: Vec<Value> = known
            .iter()
            .take(MAX_SERVERS)
            .map(|server| {
                let state = if self.failed.contains(server) {
                    "failed"
                } else if self.pending.contains(server) {
                    "pending"
                } else {
                    "connected"
                };
                let count = self.tools.get(&tool_key(server)).map_or(0, BTreeSet::len);
                let mut entry = json!({"name":server,"state":state});
                if count > 0 && state == "connected" {
                    entry["toolCount"] = json!(count);
                }
                entry
            })
            .collect();
        let mut info = Map::new();
        if !mcp.is_empty() {
            info.insert("mcp".into(), json!(mcp));
        }
        for (key, set, max) in [
            ("skills", &self.skills, MAX_SKILLS),
            ("agents", &self.agents, MAX_AGENTS),
        ] {
            if !set.is_empty() {
                info.insert(key.into(), json!(set.iter().take(max).collect::<Vec<_>>()));
            }
        }
        if !self.files.is_empty() {
            info.insert(
                "instructionFiles".into(),
                json!(self
                    .files
                    .iter()
                    .map(|(file, kind)| if kind.is_empty() {
                        json!({"name":file})
                    } else {
                        json!({"name":file,"kind":kind})
                    })
                    .collect::<Vec<_>>()),
            );
        }
        (!info.is_empty()).then_some(Value::Object(info))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attachment(value: Value) -> Value {
        json!({"type":"attachment","attachment":value})
    }

    #[test]
    fn lists_what_was_loaded_and_how_each_server_fared() {
        let mut roster = Roster::default();
        for record in [
            attachment(
                json!({"type":"mcp_instructions_delta","addedNames":["ai-memory","claude.ai Claude Docs"],"removedNames":[],"addedBlocks":["instruction text must not be copied"]}),
            ),
            attachment(json!({"type":"deferred_tools_delta",
                "addedNames":["mcp__ai-memory__memory_query","mcp__ai-memory__memory_status","mcp__claude_ai_Claude_Docs__read","mcp__codegraph__explore","Monitor"],
                "failedMcpServers":[{"name":"plugin:github:github","errorCode":"400","error":"Authorization header is badly formatted"}],
                "pendingMcpServers":["codegraph"]})),
            attachment(
                json!({"type":"skill_listing","isInitial":true,"names":["old-skill"],"content":"- long descriptions are not copied"}),
            ),
            attachment(
                json!({"type":"skill_listing","isInitial":true,"names":["handoff","retrieval"]}),
            ),
            attachment(
                json!({"type":"invoked_skills","skills":[{"name":"retrieval","content":"x"},{"name":"rea"}]}),
            ),
            attachment(
                json!({"type":"agent_listing_delta","isInitial":true,"addedTypes":["Explore","Plan"],"removedTypes":[]}),
            ),
            attachment(
                json!({"type":"agent_listing_delta","addedTypes":["rivool:review"],"removedTypes":["Plan"]}),
            ),
            attachment(json!({"type":"instructions","files":[
                {"path":"/home/me/.claude/CLAUDE.md","type":"User","content":"secret rules"},
                {"path":"/work/app/CLAUDE.md","type":"Project","content":"more"}]})),
            attachment(
                json!({"type":"nested_memory","path":"/work/app/apps/web/CLAUDE.md","content":{"type":"Project","content":"rules"},"displayPath":"CLAUDE.md"}),
            ),
            attachment(
                json!({"type":"nested_memory","path":"/work/app/apps/web/CLAUDE.md","content":{"type":"Project"}}),
            ),
        ] {
            roster.apply(&record);
        }
        assert_eq!(
            roster.into_value().unwrap(),
            json!({
                "mcp":[
                    {"name":"ai-memory","state":"connected","toolCount":2},
                    {"name":"claude.ai Claude Docs","state":"connected","toolCount":1},
                    {"name":"codegraph","state":"pending"},
                    {"name":"plugin:github:github","state":"failed"},
                ],
                "skills":["handoff","rea","retrieval"],
                "agents":["Explore","rivool:review"],
                "instructionFiles":[{"name":".claude/CLAUDE.md","kind":"User"},{"name":"app/CLAUDE.md","kind":"Project"},{"name":"web/CLAUDE.md","kind":"Project"}],
            })
        );
    }

    #[test]
    fn a_recovered_server_and_a_removed_one_leave_the_list_and_sidechains_are_ignored() {
        let mut roster = Roster::default();
        roster.apply(&attachment(
            json!({"type":"mcp_instructions_delta","addedNames":["a","b"]}),
        ));
        roster.apply(&attachment(
            json!({"type":"deferred_tools_delta","failedMcpServers":[{"name":"a"}]}),
        ));
        roster.apply(&attachment(
            json!({"type":"deferred_tools_delta","failedMcpServers":[]}),
        ));
        roster.apply(&attachment(
            json!({"type":"mcp_instructions_delta","removedNames":["b"]}),
        ));
        let mut side = attachment(json!({"type":"skill_listing","names":["not-mine"]}));
        side["isSidechain"] = json!(true);
        roster.apply(&side);
        assert_eq!(
            roster.into_value().unwrap(),
            json!({"mcp":[{"name":"a","state":"connected"}]})
        );
    }

    #[test]
    fn nothing_recorded_or_only_unusable_names_is_absent_not_empty() {
        let mut roster = Roster::default();
        roster.apply(&json!({"type":"user"}));
        roster.apply(&attachment(
            json!({"type":"skill_listing","names":["","bad\u{1b}name",42,"x".repeat(129)]}),
        ));
        roster.apply(&attachment(
            json!({"type":"instructions","files":[{"path":"/","type":"User"}]}),
        ));
        assert!(roster.into_value().is_none());
    }
}
