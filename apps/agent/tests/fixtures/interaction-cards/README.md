# Plan, question and turn-state fixtures

These records are independently written test data. Their text is synthetic and contains no account data or real conversation. Each file follows record envelopes and tool argument shapes taken from two sources: recorded sessions of the installed agents on the maintainer's machine, read for structure only (field names, nesting, enum values) with no content copied, and the official schemas listed below. Read on 2026-11-04.

## `claude.jsonl` (Claude Code 2.1.317)

- `AskUserQuestion` input `questions[].{question,header,multiSelect,options[].{label,description}}` and its `toolUseResult.answers`. The shape appears in recorded 2.1.317 sessions and matches `AskUserQuestionInput` in the [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript) (Tool Input Types).
- `ExitPlanMode` input `{plan, planFilePath}`. This shape is the recorded 2.1.317 one. The SDK reference marks the input fields as deprecated and lists `plan` on `ExitPlanModeOutput`. The reader accepts only a non-empty string `plan` input. Any other shape keeps the plain tool card.
- `TodoWrite` input `todos[].{content,status,activeForm}`, with `status` one of `pending`, `in_progress` or `completed`, from `TodoWriteInput` in the same reference. Current Claude Code records the separate Task tools by default and records `TodoWrite` only with `CLAUDE_CODE_ENABLE_TASKS=0`. The Task tools are not projected. They need state reduced across records, and no recorded sample was available.
- Turn end: recorded 2.1.317 sessions append `attachment`, then `system` `stop_hook_summary`, then `system` `turn_duration`. These records hang under the final assistant record through `parentUuid`, and the next prompt's `parentUuid` is the `turn_duration` record. Every recorded assistant record carries `stop_reason` (`tool_use` or `end_turn`).

## `codex.jsonl` (Codex CLI 0.166.0, paginated history)

- `request_user_input` is a `response_item` `function_call` whose `arguments` are `questions[].{header,id,question,options[].{label,description}}`. Its `function_call_output` is `{"answers":{"<id>":{"answers":[...]}}}`. This was seen in recorded 0.166.0 rollouts and matches `RequestUserInputArgs` and `RequestUserInputResponse` in [`codex-rs/protocol/src/request_user_input.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/request_user_input.rs).
- `update_plan` arguments `{explanation?, plan[].{step,status}}`, with `status` one of `pending`, `in_progress` or `completed`, come from `UpdatePlanArgs` in [`codex-rs/protocol/src/plan_tool.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs). No recorded 0.166.0 rollout on the maintainer's machine called it, so only the official schema supports it.
- The `item_completed` `Plan` item `{id,text}`, from plan mode, and the `task_started`, `task_complete` and `turn_aborted` (`reason`) events appear in recorded 0.166.0 rollouts.

## `opencode-v1.json` (OpenCode 2.2.5, `message`/`part` tables)

- Tool parts `{type:"tool",tool,callID,state.{status,input,output,metadata,title,time}}`, for:
  - `todowrite`, with `todos[].{content,status,priority}` and `status` one of `pending`, `in_progress`, `completed` or `cancelled`.
  - `question`, with `questions[].{question,header,multiple,options[].{label,description}}` and `metadata.answers`.

  Recorded parts have status `completed`, `error` or `running`.
- Assistant message data `time.{created,completed}`, `finish` (`tool-calls` or `stop`) and `error.name` (`MessageAbortedError` for an interrupted turn). These appear in recorded 2.2.5 sessions.
- No V2 (`session_message`/`session_part`) database was available. Cards use the same tool-part reader for V2, but V2 turn state is not derived and stays unknown.

The tests in `tests/interaction_cards.rs` load these files into temporary directories and databases. They also derive the in-progress, waiting and stopped variants by truncating or editing the recorded sequence. Compatibility with other agent versions has not been verified.
