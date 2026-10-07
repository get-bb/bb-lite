# Claude Code stdio protocol, as used by the bb runner

Recorded 2026-10-07 against `claude` 2.1.292, driven by `@anthropic-ai/claude-agent-sdk` 0.3.268 through the real TypeScript runner (`packages/runner/src/providers/claude*.ts`). Model: `claude-haiku-4-5`.

Recordings live in `tests/fixtures/raw/<scenario>/`. Each scenario has these files:
- `argv.txt`, `env.txt`
- `stdin.ndjson` (SDK to CLI) and `stdout.ndjson` (CLI to SDK)
- `interleaved.ndjson`, where each line is `{dir:"in"|"out", t:<ms>, line}`
- `exit.json`
- `events.json`, holding the RunnerEvents the TS runner emitted
- `meta.json`

A second process spawned in the same scenario is recorded in `spawn-N/`.

To regenerate, run `node --conditions=source --import tsx crates/bb-claude/tests/fixtures/raw/record.ts <scenario>` from the repo root. Each run is a real session on your login, so clear CLAUDE_*/ANTHROPIC_* variables from the environment first. The recorder wrapper is `tests/fixtures/raw/claude-recorder`.

Every section below is marked with how its information was obtained:
- **[observed]**: seen in the recordings.
- **[source]**: read from the SDK's `sdk.mjs`/`sdk.d.ts` only, not triggered.

## 1. Process

The CLI is spawned directly when it is a native binary. The SDK only runs it through `node` or `bun` when the path ends in `.js/.mjs/.ts/.tsx/.jsx`. Its cwd is `spec.cwd`, and stdio is all pipes. stderr is not part of the protocol; the SDK keeps a tail of it for error messages.

### argv [observed, `simple/argv.txt`]

| argument | origin / purpose |
|---|---|
| `--output-format stream-json --verbose --input-format stream-json` | always; NDJSON both ways |
| `--thinking adaptive` | `thinking:{type:"adaptive"}` |
| `--thinking-display summarized` | `thinking.display` |
| `--effort low` | `effort` (from reasoningLevel: none to low, ultra to max, ultracode to xhigh) |
| `--model claude-haiku-4-5` | `model` |
| `--permission-prompt-tool stdio` | present because `canUseTool` is set. Permission prompts arrive as `can_use_tool` control requests |
| `--allowedTools mcp__bb-bridge__lookup` | the adapter auto-allows its own dynamic tools (`dynamic-tool` scenario only). This is why no `can_use_tool` is sent for them |
| `--disallowedTools EnterPlanMode,ExitPlanMode` | `disallowedTools` |
| `--setting-sources=user,project,local` | `settingSources` (equals form) |
| `--permission-mode acceptEdits` | permissionMode: accept-edits to acceptEdits, auto to auto, full to bypassPermissions (forced to `default` when running as root) |
| `--include-partial-messages` | `includePartialMessages`, which enables `stream_event` lines |
| `--add-dir <dataDir>/thread-storage` | `additionalDirectories`: host writable roots plus `providerOptions.additionalWorkspaceWriteRoots`. Omitted in bypass mode |
| `--session-id=<uuid>` | new session. The runner picks the uuid, and it becomes `providerThreadId` |
| `--resume=<uuid>` | instead of `--session-id` when `SessionSpec.providerThreadId` is set (`resume`) |
| `--replay-user-messages` | `extraArgs`. The CLI echoes each user message (with `isReplay`) and each received `control_response` |
| `--chrome` | `extraArgs`, only when `providerOptions.chromeEnabled` is set (not observed) |
| `--settings <json>` | `settings` (flags) merged with `sandbox`. Observed value: `{"autoMemoryEnabled":true,"enableWorkflows":true,"ultracode":false,"fastMode":false,"sandbox":{"enabled":true,"failIfUnavailable":false,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":true,"network":{"allowLocalBinding":true},"filesystem":{"allowWrite":[...roots]}}}`. `sandbox` is omitted in bypass mode |
| `--plugin-dir <path>` | one per entry in `spec.skillDirs`: a generated plugin wrapping the skills (not observed; skillDirs was empty) |
| `--allow-dangerously-skip-permissions` | only for bypass mode when not running as root (not observed) |

The following do not appear on argv. They are carried by `initialize` instead:
- `systemPrompt` preset with `append`
- hooks
- the SDK MCP server

### env [observed, `env.txt`]

The adapter passes the host env plus `SessionSpec.env`, with these changes:
- sets `CLAUDE_CODE_ENTRYPOINT=cli`
- sets `CLAUDE_CODE_DISABLE_1M_CONTEXT=0|1`
- deletes `CLAUDE_AGENT_SDK_CLIENT_APP` and `ELECTRON_RUN_AS_NODE`

The SDK then adds the following [source]:
- `CLAUDE_AGENT_SDK_VERSION=0.3.268`
- `CLAUDE_CODE_ENTRYPOINT` only when it is absent; the SDK default is `sdk-ts`
- `DEBUG` is deleted, and set to `1` only when `DEBUG_CLAUDE_AGENT_SDK` is set
- `NODE_OPTIONS` is deleted

The runner also sets `BB_THREAD_ID`, `BB_SERVER_URL` and `BB_CLI` (not recorded by the filter).

## 2. Framing

- One JSON object per line, in both directions.
- Blank lines are ignored.
- The SDK logs and skips non-JSON stdout lines [source].

## 3. Messages, SDK to CLI (stdin) [observed]

### `user`
Observed (`simple/stdin.ndjson` line 2):
```json
{"type":"user","message":{"role":"user","content":"Reply with exactly: ok"},"session_id":"ff329a00-62a7-487d-8ca5-79d3b2bb6eea","uuid":"ea93f9c9-3af7-4208-be80-95c68d4e22ea","parent_tool_use_id":null}
```
- `content` is the plain prompt string.
- `uuid` is chosen by the sender and comes back in `command_lifecycle.command_uuid`, `status.user_message_uuids` and `result.user_message_uuid(s)`.
- Optional fields [source]: `priority` (`now|next|later`), `isSynthetic`, `shouldQuery`, `timestamp`.

### `control_request`
Shape: `{"request_id":"<random base36>","type":"control_request","request":{"subtype":...}}`.

### `control_response`
Answers a CLI `control_request`, either:
- `{"type":"control_response","response":{"subtype":"success","request_id":"<same id>","response":{...}}}`
- or `{"subtype":"error","request_id","error":"msg"}`

### `control_cancel_request`
`{"type":"control_cancel_request","request_id"}` [source]. The SDK sends it if a request it issued is aborted. Not observed.

## 4. Messages, CLI to SDK (stdout) [observed unless marked]

| type / subtype | notes |
|---|---|
| `system/hook_started`, `system/hook_response` | `SessionStart:startup` hook from user settings. Emitted before the initialize response |
| `control_response` | Answers SDK requests. **It also echoes every control_response the SDK sent** (same body), because of `--replay-user-messages`. Rust must ignore echoes whose `request_id` it did not issue |
| `control_request` | `hook_callback`, `can_use_tool`, `mcp_message` (see §6–8) |
| `command_lifecycle` | `{command_uuid:<user uuid>, state:"queued"|"started"|..., uuid, session_id}`, emitted for each submitted user message |
| `system/init` | Fields: agents, apiKeySource, capabilities, claude_code_version, cwd, mcp_servers[{name,status,source}], memory_paths, model, permissionMode, plugins, session_id, skills, slash_commands, tools, ... Emitted **once per turn**, not once per process |
| `system/status` | `{status:"requesting", user_message_uuids:[...]}` before each API request |
| `rate_limit_event` | `rate_limit_info{status,resetsAt,rateLimitType,...}` |
| `user` | Replays of the user's input (`isReplay:true`) and tool results (`message.content[].type=="tool_result"`) |
| `stream_event` | `event` is a raw Anthropic streaming event: `message_start`, `content_block_start/delta/stop` (`thinking_delta`, `text_delta`, `input_json_delta`), `message_delta`, `message_stop`. Also `parent_tool_use_id`, `session_id`, `uuid` |
| `system/thinking_tokens` | `{estimated_tokens, estimated_tokens_delta, user_message_uuid}`, interleaved with thinking deltas |
| `assistant` | A complete content block. **One `assistant` line per content block** (thinking, text, tool_use), each with the same `message.id` |
| `result` | End of a turn. subtype `success` or `error_during_execution` (with `errors[]`). Fields: `result`, `is_error`, `num_turns`, `duration_ms`, `usage`, `modelUsage`, `total_cost_usd`, `permission_denials`, `stop_reason`, `terminal_reason`, `user_message_uuid(s)`, `queued_turn_count`, ... |

Read from source but not observed:
- `keep_alive`, `transcript_mirror` (both swallowed by the SDK)
- `tool_progress`, `auth_status`, `tool_use_summary`, `prompt_suggestion`
- system `api_retry`, `compact_boundary`, `task_*`, `notification`, `permission_denied`, `informational`, ...
- result subtypes `error_max_turns`, `error_max_budget_usd`

## 5. Startup handshake [observed]

1. The SDK writes the `initialize` control_request **immediately**. The adapter then writes the first `user` message right after it, without waiting (`t=3ms` for both in `simple`).
2. The CLI runs the SessionStart hooks (`system/hook_started` / `hook_response`).
3. If an SDK MCP server is declared, the CLI performs the MCP handshake over `mcp_message` before answering initialize (`dynamic-tool`, §8).
4. The CLI sends the `control_response` to initialize, then `command_lifecycle`, `system/init`, `system/status`, and the turn starts.

initialize request (`dynamic-tool`):
```json
{"request_id":"4zcg0knrxsf","type":"control_request","request":{"subtype":"initialize","hooks":{"PreToolUse":[{"hookCallbackIds":["hook_0"]}]},"sdkMcpServers":["bb-bridge"],"appendSystemPrompt":"You are being recorded for a protocol test. Be brief."}}
```
- `sdkMcpServers` is present only when there are dynamic tools.
- `appendSystemPrompt` is `SessionSpec.instructions`.

The initialize response has these fields (`response.response`):
- `account` {email,organization,subscriptionType,apiProvider}; email redacted in the fixtures
- `agents`, `commands`, `models` [{value,displayName,...}]
- `output_style`, `available_output_styles`
- `current_permission_mode`, `fast_mode_state`, `capabilities`, `pid`, `session_state`, `hooks_applied`
- `remote_control_*`

The adapter's `listModels` reads `models`. Haiku appears there as `haiku` / `claude-haiku-4-5`.

Further details [source]:
- The response may also carry `pending_permission_requests` / `pending_user_dialog_requests`, which the SDK re-dispatches.
- Optional initialize fields are listed in the SDK types: `systemPrompt`, `jsonSchema`, `agents`, `skills`, `plugins`, `title`, ...

## 6. Hooks [observed]

The adapter registers one PreToolUse hook. It denies `Agent`/`Task` when subagents are disabled and `Workflow` when workflows are disabled. The CLI calls the hook before **every** tool use:
```json
{"type":"control_request","request_id":"dad5485b-d540-4a27-be06-3e440c5978a2","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"session_id":"f624f0c5-...","transcript_path":"/home/sawyer/.claude/projects/-tmp-bb-claude-rec-cwd-jAjGjB/f624f0c5-....jsonl","cwd":"/tmp/bb-claude-rec-cwd-jAjGjB","prompt_id":"77b40a24-...","permission_mode":"acceptEdits","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"python3 -c 'print(1+1)'","description":"Run simple Python arithmetic"},"tool_use_id":"toolu_01DSyXcrzF4mnfavMR3EUuKi"},"tool_use_id":"toolu_01DSyXcrzF4mnfavMR3EUuKi"}}
```
- Response to continue: `{"type":"control_response","response":{"subtype":"success","request_id":"dad5485b-...","response":{"continue":true}}}`.
- Response to block [source + adapter]: `{"continue":true,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.

## 7. Permission prompts (can_use_tool) [observed: `approval-allow`, `approval-deny`]

Order per tool use:
1. `hook_callback` arrives and is answered.
2. Only then does `can_use_tool` arrive, if the CLI's own rules do not already decide.

Read-only commands such as `echo hi` are auto-allowed by the CLI and **never prompt** (`tool-auto-approved`). The first attempt with `echo hi` showed this. `python3 -c ...` prompts.
```json
{"type":"control_request","request_id":"f5faefed-1cdb-4cad-ad97-c7c9381e8c23","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"python3 -c 'print(1+1)'","description":"Run simple Python arithmetic"},"description":"Run simple Python arithmetic","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"python3 -c 'print(1+1)'"}],"behavior":"allow","destination":"localSettings"}],"decision_reason":"This command requires approval","decision_reason_type":"other","tool_use_id":"toolu_01DSyXcrzF4mnfavMR3EUuKi"}}
```

Allow (allow_once). The adapter always sends `updatedInput`, which is the original input or the edited input (allow with updated input uses the same shape):
```json
{"type":"control_response","response":{"subtype":"success","request_id":"f5faefed-1cdb-4cad-ad97-c7c9381e8c23","response":{"behavior":"allow","updatedInput":{"command":"python3 -c 'print(1+1)'","description":"Run simple Python arithmetic"},"decisionClassification":"user_temporary","toolUseID":"toolu_01DSyXcrzF4mnfavMR3EUuKi"}}}
```

Deny:
```json
{"behavior":"deny","message":"Permission request denied","decisionClassification":"user_reject","toolUseID":"toolu_01ThwHBJB8DhExhEXcAAzeie"}
```
After a deny, the CLI emits a `user` tool_result with `is_error`, and the model continues the turn; the turn is not interrupted.

The SDK adds `toolUseID` from the request's `tool_use_id`. The following are [source] and were not observed:
- allow can carry `updatedPermissions:[PermissionUpdate]`; allow_for_session uses `destination:"session"`
- deny can carry `interrupt:true`
- `PermissionUpdate` is one of:
  - `addRules|replaceRules|removeRules{rules,behavior,destination}`
  - `setMode{mode,destination}`
  - `add/removeDirectories{directories,destination}`
- if the CLI sends `control_cancel_request{request_id}` for a pending prompt, the SDK aborts it and writes no response

AskUserQuestion is also delivered through `can_use_tool` (`tool_name:"AskUserQuestion"`). The adapter answers with `behavior:"allow"` and `updatedInput` that carries the answers (`claude-interactions.ts answeredInput`): `answers: {<question text>: "<label>[; free text]"}` plus annotations. **Not recorded**; the session budget ran out.

## 8. In-process MCP server (dynamic tools) [observed: `dynamic-tool`]

Declaration: `initialize.sdkMcpServers:["bb-bridge"]`. Nothing is added to `--mcp-config`. The tools are added to `--allowedTools` as `mcp__bb-bridge__<name>`. The CLI relays JSON-RPC through `control_request{subtype:"mcp_message", server_name:"bb-bridge", message}`, and the host answers with `response:{mcp_response:<JSON-RPC>}`. Observed sequence, all before the initialize response:
```
out {"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"claude-code",...,"version":"2.1.292"}},"jsonrpc":"2.0","id":0}
in  {"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"bb-bridge","version":"1.0.0"}},"jsonrpc":"2.0","id":0}
out {"jsonrpc":"2.0","method":"notifications/initialized"}
in  {"jsonrpc":"2.0","result":{},"id":0}          <- SDK acks notifications with a dummy result
out {"method":"tools/list","jsonrpc":"2.0","id":1}
in  {"result":{"tools":[{"name":"lookup","description":"Look up a value","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}]},"jsonrpc":"2.0","id":1}
```

Full envelope of a call during the turn (after the PreToolUse hook_callback):
```json
{"type":"control_request","request_id":"8b838a30-...","request":{"subtype":"mcp_message","server_name":"bb-bridge","message":{"method":"tools/call","params":{"name":"lookup","arguments":{"key":"a"},"_meta":{"claudecode/toolUseId":"toolu_01AukqUYauTUMFMFZT87FdZk","progressToken":2}},"jsonrpc":"2.0","id":2}}}
{"type":"control_response","response":{"subtype":"success","request_id":"8b838a30-...","response":{"mcp_response":{"result":{"content":[{"type":"text","text":"value-of-a=42"}]},"jsonrpc":"2.0","id":2}}}}
```
- Failure results add `"isError":true`.
- The runner emits `toolCall.requested` and waits for `resolveToolCall` before replying. The model can therefore wait indefinitely; there is no CLI timeout at this layer.
- The SDK ignores `_meta.progressToken`.
- `system/init.mcp_servers` lists `{"name":"bb-bridge","status":"connected","source":"sdk"}`. It also lists the user's claude.ai connectors, because user settings are loaded.

## 9. Streaming [observed]

With `--include-partial-messages`, each content block arrives in this order:
1. `stream_event` with `content_block_start`
2. many `content_block_delta` (and, for thinking, interleaved `system/thinking_tokens`)
3. one `assistant` line with the finished block
4. `content_block_stop`

`message_delta` (stop_reason, usage) and `message_stop` follow. `result` comes last.

## 10. Turn submission and steering [observed: `steer`]

- A turn is one `user` line.
- A "steer" is just another `user` line written while a turn runs. The CLI answers it with `command_lifecycle{state:"queued"}`. It does **not** inject the message into the running generation: the first turn ran to its own `result` (about 10 s later), and then the CLI started a new turn for the queued message, with new `system/init`, `status`, the replayed `user`, `assistant` and a second `result`.
- One `result` arrives per user message, so the Rust side must count results against queued uuids (`result.user_message_uuid`).
- The SDK never closes stdin between turns.

## 11. Interrupt [observed: `interrupt`]

```json
{"request_id":"6qcy7gkk3ca","type":"control_request","request":{"subtype":"interrupt"}}
{"type":"control_response","response":{"subtype":"success","request_id":"6qcy7gkk3ca","response":{"still_queued":[]}}}
```
Within about 10 ms the CLI then emits:
1. the partial `assistant` text block, cut mid-sentence
2. `user` with content `[{"type":"text","text":"[Request interrupted by user]"}]`
3. `result` with `subtype:"error_during_execution"`, `errors:["[ede_diagnostic] result_type=user ..."]`
4. `command_lifecycle`

In the recording, stdin was closed about 0.7 s after that, and the CLI **exited with status 1**. The runner then served the next turn from a **fresh process with a new `--session-id`, not `--resume`** (`interrupt/spawn-2`). So the follow-up turn did not see the earlier conversation. This looks like a TS runner behaviour or bug worth checking before copying it.

When an interrupt is sent while no turn is running, the reply is `{"still_queued":[]}`. `releaseSession` does exactly this before closing stdin (see the end of every scenario). [source] `interrupt` may also carry `cancel_queued:true` and return `cancelled:[...]`.

## 12. Resume [observed: `resume`]

- argv carries `--resume=<previous session id>` in place of `--session-id`. Everything else is unchanged.
- The first messages are identical to a new session: initialize, then the user message.
- The CLI does not replay old history on stdout.
- `system/init.session_id` and `result.session_id` keep the resumed id.

## 13. Mid-session model and settings changes [source; not recorded]

The `settings-change` scenario was not run because the 12-session budget was used up. From `claude.ts applySettings` and the SDK:
- Model change: `{"type":"control_request","request_id":"..","request":{"subtype":"set_model","model":"claude-sonnet-4-6"}}`. `model` is omitted to mean the default.
- Flag change (`reasoningLevel` to `effortLevel`, `serviceTier` to `fastMode`, `ultracode`, memory, workflows): `{"subtype":"apply_flag_settings","settings":{"autoMemoryEnabled":true,"enableWorkflows":true,"effortLevel":"high","ultracode":false,"fastMode":false}}`. The adapter sends the whole `flags` object, including `effortLevel`.
- Both are sent before the next `user` line, and only when the value changed.
- `permissionMode`, `disable1MContext`, `chromeEnabled`, writable roots, cwd, instructions, dynamicTools and skillDirs are part of the adapter's session signature. A change to any of them **closes the process and respawns** with `--resume=<id>` and the new argv. The adapter never sends `set_permission_mode`. The SDK supports `{"subtype":"set_permission_mode","mode":...}`.
- Other subtypes are SDK-only and unused by the adapter: `set_max_thinking_tokens`, `mcp_status`, `get_settings`, `rewind_files`, `stop_task`, `get_context_usage`, and others.

## 14. Session end [observed]

`releaseSession` works like this:
1. Send `interrupt`, which is answered with `still_queued:[]`.
2. End stdin.
3. The CLI exits 0.

SDK close [source]: end stdin; if the child is still alive after 2 s, send SIGTERM, then SIGKILL after another 5 s. A non-zero exit becomes the error `Claude Code process exited with code N. stderr: <tail>`.

## 15. What the Rust port must reimplement (SDK-side behaviour)

- argv and `--settings` construction (§1). Note that `sandbox` is merged into the settings JSON, and that `failIfUnavailable` defaults to true when it is not given.
- Request id generation and pending-request maps. Ignore echoed `control_response`s.
- Dispatch of `hook_callback` by `callback_id`, `can_use_tool` (adding `toolUseID`), and `mcp_message`.
- The MCP bridge: answer `initialize`, `tools/list` and `tools/call` yourself. Ack notifications with `{"jsonrpc":"2.0","result":{},"id":0}`. Server-initiated messages go out as new `control_request mcp_message` [source].
- `control_cancel_request` handling: abort the pending prompt and send no response.
- Error responses: `{"subtype":"error","request_id","error":"..."}` for unknown subtypes or callbacks.
- The shutdown sequence and timeouts (§14).
- The env adjustments (§1).

## 16. SDK `Options` set by the adapter, and what each became

| Option (claude-options.ts) | became |
|---|---|
| `cwd` | child process cwd |
| `systemPrompt {preset:"claude_code", append}` | `initialize.appendSystemPrompt` (nothing on argv) |
| `allowDangerouslySkipPermissions` (bypass only) | `--allow-dangerously-skip-permissions` |
| `includePartialMessages: true` | `--include-partial-messages` |
| `disallowedTools` | `--disallowedTools EnterPlanMode,ExitPlanMode` |
| `settingSources` | `--setting-sources=user,project,local` |
| `persistSession: true` | nothing (only `false` adds `--no-session-persistence`) |
| `env` | child env (§1) |
| `sandbox` | the `sandbox` key inside `--settings` |
| `additionalDirectories` | `--add-dir <dir>` for each entry |
| `model` | `--model` |
| `effort` | `--effort` |
| `thinking {adaptive, summarized}` | `--thinking adaptive --thinking-display summarized` |
| `settings` (flags) | `--settings <json>` |
| `pathToClaudeCodeExecutable` | the spawned binary (`BB_CLAUDE_CODE_EXECUTABLE`, else `claude` on PATH) |
| `plugins` | `--plugin-dir <path>` for each entry |
| `extraArgs {replay-user-messages, chrome?}` | `--replay-user-messages`, `--chrome` |
| `canUseTool` (claude.ts) | `--permission-prompt-tool stdio`, plus `can_use_tool` requests |
| `hooks.PreToolUse` (claude.ts) | `initialize.hooks`, plus `hook_callback` requests |
| `mcpServers {bb-bridge: sdk}` (claude.ts, only with dynamic tools) | `initialize.sdkMcpServers`, plus `mcp_message` requests |
| `allowedTools` (claude.ts, only with dynamic tools) | `--allowedTools mcp__bb-bridge__<tool>` |
| `permissionMode` | `--permission-mode` |
| `sessionId` / `resume` (claude.ts) | `--session-id=<uuid>` / `--resume=<uuid>` |
| `Query.interrupt()` / `setModel()` / `applyFlagSettings()` | control requests `interrupt` / `set_model` / `apply_flag_settings` |
