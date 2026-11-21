//! Bounded turn and item locations for an exact Codex conversation projection.
use super::super::{Error, Result, TranscriptAgent};
use super::{canonical, legacy, pending_question, required, Projection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

const MAX_RECORDS: usize = 100_000;
const MAX_METADATA: usize = 32 * 1024 * 1024;
const MAX_DERIVED_METADATA: usize = 16 * 1024 * 1024;
type GoalDigest = (Option<[u8; 32]>, Option<[u8; 32]>);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Compacted,
    Goal,
    Canonical,
    Legacy,
}

#[derive(Clone, Debug)]
pub(crate) struct IndexedMessage {
    pub id: String,
    pub key: String,
    pub turn_id: String,
    pub kind: Kind,
    pub record_hash: [u8; 32],
}

pub(crate) struct IndexResult {
    pub messages: Vec<IndexedMessage>,
    pub activity: Option<&'static str>,
    pub work: Option<Vec<Value>>,
    pub session: Option<Value>,
}

struct Item {
    id: String,
    key: String,
    kind: Kind,
    record_hash: [u8; 32],
}

#[derive(Default)]
struct Turn {
    id: String,
    explicit: bool,
    compacted: bool,
    items: Vec<Item>,
    positions: HashMap<String, usize>,
}

impl Turn {
    fn cost(&self) -> usize {
        2 * self.id.len()
            + self
                .items
                .iter()
                .map(|item| 2 * item.id.len() + item.key.len() + self.id.len() + 32)
                .sum::<usize>()
    }
}

#[derive(Default)]
pub(crate) struct Index {
    turns: Vec<Turn>,
    first: HashMap<String, usize>,
    current: Option<Turn>,
    bytes: usize,
    records: usize,
    goal: Option<GoalDigest>,
    activity: Option<&'static str>,
    asked: HashSet<String>,
    asked_bytes: usize,
    task_bytes: usize,
    session: super::super::session_info::Session,
    agents: super::super::work::CodexAgents,
}

impl Index {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self.bytes.checked_add(bytes).ok_or(Error::TooLarge)?;
        if self.bytes > MAX_METADATA {
            return Err(Error::TooLarge);
        }
        Ok(())
    }

    fn charge_derived(&mut self, bytes: usize) -> Result<()> {
        self.task_bytes = self.task_bytes.checked_add(bytes).ok_or(Error::TooLarge)?;
        if self.task_bytes.saturating_add(self.asked_bytes) > MAX_DERIVED_METADATA {
            return Err(Error::TooLarge);
        }
        Ok(())
    }

    fn question(&mut self, payload: &Value) -> Result<()> {
        let Some(id) = payload["call_id"].as_str() else {
            return Ok(());
        };
        if payload["type"] == "function_call"
            && payload["name"].as_str().is_some_and(|name| {
                super::super::interaction::awaits_answer(TranscriptAgent::Codex, name)
            })
            && !self.asked.contains(id)
        {
            self.asked_bytes = self
                .asked_bytes
                .checked_add(id.len() + 64)
                .ok_or(Error::TooLarge)?;
            if self.task_bytes.saturating_add(self.asked_bytes) > MAX_DERIVED_METADATA {
                return Err(Error::TooLarge);
            }
        } else if payload["type"] == "function_call_output" && self.asked.contains(id) {
            self.asked_bytes -= id.len() + 64;
        }
        pending_question(payload, &mut self.asked);
        Ok(())
    }

    fn clear_questions(&mut self) {
        self.asked.clear();
        self.asked_bytes = 0;
    }

    fn finish_turn(&mut self) {
        if let Some(turn) = self.current.take() {
            if turn.explicit || turn.compacted || !turn.items.is_empty() {
                self.first
                    .entry(turn.id.clone())
                    .or_insert(self.turns.len());
                self.turns.push(turn);
            } else {
                self.bytes -= turn.cost();
            }
        }
    }

    fn create(&mut self, id: &str, explicit: bool) -> Result<()> {
        self.charge(2 * id.len())?;
        self.current = Some(Turn {
            id: id.to_owned(),
            explicit,
            ..Turn::default()
        });
        Ok(())
    }

    fn target(&mut self, id: Option<&str>) -> Result<&mut Turn> {
        if let Some(id) = id {
            if self.current.as_ref().is_some_and(|turn| turn.id == id) {
                return Ok(self.current.as_mut().unwrap());
            }
            if let Some(&index) = self.first.get(id) {
                return Ok(&mut self.turns[index]);
            }
            if self.current.is_some() {
                self.finish_turn();
            }
        }
        if self.current.is_none() {
            self.create(id.unwrap_or(""), false)?;
        }
        Ok(self.current.as_mut().unwrap())
    }

    fn put(
        &mut self,
        turn_id: Option<&str>,
        message: Value,
        key: &str,
        kind: Kind,
        record_hash: [u8; 32],
    ) -> Result<()> {
        let turn = self.target(turn_id)?.id.clone();
        let id = scoped(message, &turn)?["id"]
            .as_str()
            .ok_or(Error::InvalidEvent)?
            .to_owned();
        let existing = self.target(turn_id)?.positions.get(&id).copied();
        if let Some(index) = existing {
            let old = self.target(turn_id)?.items[index].key.len();
            self.bytes -= old;
            self.charge(key.len())?;
            let item = &mut self.target(turn_id)?.items[index];
            item.key = key.to_owned();
            item.kind = kind;
            item.record_hash = record_hash;
        } else {
            self.charge(2 * id.len() + key.len() + turn.len() + 32)?;
            let turn = self.target(turn_id)?;
            turn.positions.insert(id.clone(), turn.items.len());
            turn.items.push(Item {
                id,
                key: key.to_owned(),
                kind,
                record_hash,
            });
        }
        Ok(())
    }

    pub(crate) fn observe(
        &mut self,
        value: &Value,
        thread: &str,
        paginated: bool,
        key: &str,
        images: bool,
        record_hash: [u8; 32],
    ) -> Result<()> {
        self.records += 1;
        if self.records > MAX_RECORDS {
            return Err(Error::TooLarge);
        }
        self.session.codex(value);
        if value["type"] == "response_item" {
            let payload = &value["payload"];
            self.question(payload)?;
            if payload["type"] == "agent_message" {
                if payload["author"].is_string()
                    && payload["content"][0]["text"]
                        .as_str()
                        .is_some_and(|text| text.contains("Message Type: FINAL_ANSWER"))
                {
                    self.charge_derived(value["timestamp"].as_str().map_or(0, str::len) + 864)?;
                }
                self.agents.message(payload, value["timestamp"].as_str());
            }
        }
        if value["type"] == "compacted" {
            self.target(None)?.compacted = true;
            let id = format!("compacted-{key}");
            return self.put(
                None,
                super::super::events::compacted(&id, &value["timestamp"]),
                key,
                Kind::Compacted,
                record_hash,
            );
        }
        if value["type"] != "event_msg" {
            return Ok(());
        }
        let event = &value["payload"];
        if event["type"] == "item_completed" && event["item"]["type"] == "SubAgentActivity" {
            let item = &event["item"];
            if let (Some(thread), Some(path)) = (
                item["agent_thread_id"].as_str(),
                item["agent_path"].as_str(),
            ) {
                if matches!(item["kind"].as_str(), Some("started" | "completed")) {
                    self.charge_derived(
                        2 * thread.len()
                            + path.len()
                            + value["timestamp"].as_str().map_or(0, str::len)
                            + 1024,
                    )?;
                }
            }
            self.agents.observe(item, value["timestamp"].as_str());
        }
        let kind = required(event, "type")?;
        match kind {
            "task_started" | "turn_started" => {
                self.activity = Some("working");
                self.finish_turn();
                self.create(required(event, "turn_id")?, true)?;
                return Ok(());
            }
            "turn_aborted" => {
                self.activity = Some("stopped");
                self.clear_questions();
                return Ok(());
            }
            "task_complete" | "turn_complete" => {
                self.activity = Some("idle");
                self.clear_questions();
                if event["turn_id"]
                    .as_str()
                    .is_some_and(|id| self.first.contains_key(id))
                {
                    return Ok(());
                }
                self.finish_turn();
                return Ok(());
            }
            "thread_rolled_back" => {
                let count = event["num_turns"].as_u64().ok_or(Error::InvalidEvent)?;
                self.finish_turn();
                let keep = self
                    .turns
                    .len()
                    .saturating_sub(usize::try_from(count).unwrap_or(usize::MAX));
                for (offset, turn) in self.turns.drain(keep..).enumerate() {
                    self.bytes -= turn.cost();
                    if self.first.get(&turn.id) == Some(&(keep + offset)) {
                        self.first.remove(&turn.id);
                    }
                }
                return Ok(());
            }
            "thread_goal_updated" => {
                let goal = &event["goal"];
                let digest = |v: &Value| v.as_str().map(|s| Sha256::digest(s.as_bytes()).into());
                let state = (digest(&goal["objective"]), digest(&goal["status"]));
                if self.goal != Some(state) {
                    self.goal = Some(state);
                    let id = format!("goal-{key}");
                    if let Some(message) =
                        super::super::events::codex_goal(&id, goal, &value["timestamp"])
                    {
                        self.put(
                            event["turn_id"].as_str(),
                            message,
                            key,
                            Kind::Goal,
                            record_hash,
                        )?;
                    }
                }
                return Ok(());
            }
            "user_message"
                if !paginated
                    && self.current.as_ref().is_some_and(|turn| {
                        !turn.explicit && !(turn.compacted && turn.items.is_empty())
                    }) =>
            {
                self.finish_turn()
            }
            _ => {}
        }
        let (message, item_kind) = if paginated {
            if !matches!(kind, "item_started" | "item_completed") {
                return Ok(());
            }
            required(event, "turn_id")?;
            if required(event, "thread_id")? != thread {
                return Err(Error::InvalidEvent);
            }
            (
                canonical(&event["item"], &value["timestamp"], images)?,
                Kind::Canonical,
            )
        } else {
            if kind == "item_completed"
                && matches!(
                    event["item"]["type"].as_str(),
                    Some("UserMessage" | "AgentMessage" | "Reasoning")
                )
            {
                return Ok(());
            }
            (
                legacy(event, key, &value["timestamp"], images)?,
                Kind::Legacy,
            )
        };
        if let Some(message) = message {
            self.put(
                event["turn_id"].as_str().filter(|id| !id.is_empty()),
                message,
                key,
                item_kind,
                record_hash,
            )?;
        }
        Ok(())
    }

    pub(crate) fn finish(mut self) -> IndexResult {
        self.finish_turn();
        let activity = match self.activity {
            Some("working") if !self.asked.is_empty() => Some("waiting"),
            other => other,
        };
        let messages = self
            .turns
            .into_iter()
            .flat_map(|turn| {
                turn.items.into_iter().map(move |item| IndexedMessage {
                    id: item.id,
                    key: item.key,
                    turn_id: turn.id.clone(),
                    kind: item.kind,
                    record_hash: item.record_hash,
                })
            })
            .collect();
        IndexResult {
            messages,
            activity,
            work: self.agents.into_work(),
            session: self.session.into_value(),
        }
    }
}

fn scoped(message: Value, turn_id: &str) -> Result<Value> {
    let mut projection = Projection::default();
    projection.put(Some(turn_id), message)?;
    projection
        .current
        .and_then(|mut turn| turn.messages.pop())
        .ok_or(Error::InvalidEvent)
}

pub(crate) fn materialize(
    value: &Value,
    key: &str,
    turn_id: &str,
    kind: Kind,
    images: bool,
) -> Result<Value> {
    let message = match kind {
        Kind::Compacted => Some(super::super::events::compacted(
            &format!("compacted-{key}"),
            &value["timestamp"],
        )),
        Kind::Goal => super::super::events::codex_goal(
            &format!("goal-{key}"),
            &value["payload"]["goal"],
            &value["timestamp"],
        ),
        Kind::Canonical => canonical(&value["payload"]["item"], &value["timestamp"], images)?,
        Kind::Legacy => legacy(&value["payload"], key, &value["timestamp"], images)?,
    }
    .ok_or(Error::InvalidEvent)?;
    scoped(message, turn_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, mut body: Value) -> Value {
        body["type"] = json!(kind);
        json!({"type":"event_msg", "payload":body})
    }

    fn index_records(records: &[Value], paginated: bool) -> Index {
        let mut index = Index::default();
        for (n, record) in records.iter().enumerate() {
            index
                .observe(
                    record,
                    "thread",
                    paginated,
                    &n.to_string(),
                    false,
                    [n as u8; 32],
                )
                .unwrap();
        }
        index
    }

    #[test]
    fn derived_state_matches_recorded_session_question_and_subagent() {
        let records = [
            json!({"type":"turn_context", "payload":{"model":"owned-model"}}),
            event("task_started", json!({"turn_id":"turn"})),
            json!({"type":"response_item", "payload":{"type":"function_call", "name":"request_user_input", "call_id":"call"}}),
            event(
                "item_completed",
                json!({"item":{"type":"SubAgentActivity", "id":"item", "kind":"started", "agent_thread_id":"child", "agent_path":"/parent/child"}}),
            ),
        ];
        let index = index_records(&records, false);
        let result = index.finish();
        assert_eq!(result.activity, Some("waiting"));
        assert_eq!(result.session.unwrap()["model"], "owned-model");
        let work = result.work.unwrap();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0]["state"], "running");
    }

    #[test]
    fn derived_state_budget_rejects_new_question_and_task_before_retaining_them() {
        let mut index = Index {
            task_bytes: MAX_DERIVED_METADATA,
            ..Index::default()
        };
        let question = json!({"type":"response_item", "payload":{"type":"function_call", "name":"request_user_input", "call_id":"owned"}});
        assert!(matches!(
            index.observe(&question, "thread", false, "q", false, [0; 32]),
            Err(Error::TooLarge)
        ));
        let task = event(
            "item_completed",
            json!({"item":{"type":"SubAgentActivity", "id":"item", "kind":"started", "agent_thread_id":"child", "agent_path":"/parent/child"}}),
        );
        assert!(matches!(
            index.observe(&task, "thread", false, "t", false, [0; 32]),
            Err(Error::TooLarge)
        ));
    }

    fn keys(items: &[IndexedMessage]) -> Vec<&str> {
        items.iter().map(|item| item.key.as_str()).collect()
    }

    #[test]
    fn late_update_keeps_position_and_rollback_recovers_older_turn() {
        let records = [
            event("task_started", json!({"turn_id":"old"})),
            event("user_message", json!({"message":"old question"})),
            event(
                "exec_command_begin",
                json!({"call_id":"c","command":["run"]}),
            ),
            event("task_started", json!({"turn_id":"new"})),
            event("user_message", json!({"message":"removed"})),
            event(
                "exec_command_end",
                json!({"turn_id":"old","call_id":"c","command":["run"],"aggregated_output":"done"}),
            ),
            event("thread_rolled_back", json!({"num_turns":1})),
        ];
        let index = index_records(&records, false);
        let items = index.finish().messages;
        assert_eq!(keys(&items), ["1", "5"]);
        assert_eq!(items[1].record_hash, [5; 32]);
        let message = materialize(
            &records[5],
            &items[1].key,
            &items[1].turn_id,
            items[1].kind,
            false,
        )
        .unwrap();
        assert_eq!(message["id"], items[1].id);
        assert_eq!(message["blocks"][1]["text"], "done");
    }

    #[test]
    fn repeated_goals_stay_deduplicated_and_oversized_metadata_fails_closed() {
        let mut index = Index::default();
        let goal = event(
            "thread_goal_updated",
            json!({"goal":{"objective":"owned", "status":"active"}}),
        );
        index
            .observe(&goal, "thread", false, "1", false, [1; 32])
            .unwrap();
        index
            .observe(&goal, "thread", false, "2", false, [2; 32])
            .unwrap();
        assert_eq!(index.finish().messages.len(), 1);
        let mut limited = Index {
            bytes: MAX_METADATA,
            ..Index::default()
        };
        assert!(matches!(
            limited.observe(
                &event("task_started", json!({"turn_id":"t"})),
                "thread",
                false,
                "3",
                false,
                [3; 32]
            ),
            Err(Error::TooLarge)
        ));
    }

    #[test]
    fn rollback_removes_duplicate_turn_but_later_update_targets_first_survivor() {
        let mut index = Index::default();
        for (n, id) in ["a", "b", "a"].iter().enumerate() {
            index
                .observe(
                    &event("task_started", json!({"turn_id":id})),
                    "thread",
                    false,
                    &n.to_string(),
                    false,
                    [0; 32],
                )
                .unwrap();
            index
                .observe(
                    &event("user_message", json!({"message":id})),
                    "thread",
                    false,
                    &format!("m{n}"),
                    false,
                    [0; 32],
                )
                .unwrap();
        }
        index
            .observe(
                &event("thread_rolled_back", json!({"num_turns":1})),
                "thread",
                false,
                "rollback",
                false,
                [0; 32],
            )
            .unwrap();
        index
            .observe(
                &event("agent_message", json!({"turn_id":"a", "message":"late"})),
                "thread",
                false,
                "late",
                false,
                [0; 32],
            )
            .unwrap();
        let items = index.finish().messages;
        assert_eq!(keys(&items), ["m0", "late", "m1"]);
    }

    #[test]
    fn paginated_updates_keep_first_position_and_materialize_the_latest_record() {
        let item = |id: &str, text: &str| {
            event(
                "item_completed",
                json!({
                    "thread_id":"thread", "turn_id":"turn", "item":{
                        "type":"AgentMessage", "id":id, "content":[{"type":"text", "text":text}]
                    }
                }),
            )
        };
        let records = [
            item("one", "first"),
            item("two", "middle"),
            item("one", "updated"),
        ];
        let mut index = Index::default();
        for (n, record) in records.iter().enumerate() {
            index
                .observe(record, "thread", true, &n.to_string(), false, [n as u8; 32])
                .unwrap();
        }
        let items = index.finish().messages;
        assert_eq!(keys(&items), ["2", "1"]);
        assert_eq!(items[0].record_hash, [2; 32]);
        let message = materialize(
            &records[2],
            &items[0].key,
            &items[0].turn_id,
            items[0].kind,
            false,
        )
        .unwrap();
        assert_eq!(message["id"], items[0].id);
        assert_eq!(message["blocks"][0]["text"], "updated");
    }
}
