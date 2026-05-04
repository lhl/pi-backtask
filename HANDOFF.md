# pi-backtask — Reviewer Handoff Summary

**Repo:** https://github.com/lhl/pi-backtask  
**Fork of:** [artiombell/pi-backtask](https://github.com/artiombell/pi-backtask)  
**Single-file extension:** `pi-backtask.ts` (1676 lines)

**Commit history:** 9 commits over upstream; latest bugfix commit `0e3fcea`

---

## What This Is

A pi-coding-agent extension that provides:

1. **Human-controlled background agent delegation** — `/bg agent` spawns full pi agent sessions via gob (an external process manager). There is no direct LLM-callable agent-spawn tool; pi-tasks RPC spawns are policy-gated and default-denied.
2. **LLM-callable background shell processes** — `bg_process` tool lets the LLM start dev servers, test watchers, builds, etc. in the background with reactive output monitoring.
3. **@tintinweb/pi-tasks compatibility** — Implements the `@tintinweb/pi-subagents` RPC protocol v2, so pi-tasks' `TaskExecute` can route task execution through our gob backend.
4. **Persistent task list** — `/task add|start|done` for tracking work.
5. **Fine-grained policy system** — Per-action allow/confirm/deny controls in settings.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ pi-backtask.ts                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Entry Points:                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ /bg run (human)  │  │ /bg agent (human)│  │ bg_process   │ │
│  │ /bg kill, list   │  │ --rw --think etc │  │ tool (LLM)   │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘ │
│           │                      │                    │         │
│           │         ┌────────────┴──────┐    ┌───────┴───────┐ │
│           │         │ parseBgAgentArgs  │    │ Policy Check  │ │
│           │         │ (flags → pi args) │    │ allow/confirm │ │
│           │         └────────┬──────────┘    │ /deny         │ │
│           │                  │               └───────┬───────┘ │
│           ▼                  ▼                       ▼         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              spawnGobBackground()                        │   │
│  │  → gob add -- <command>                                 │   │
│  │  → tracks in backgroundTasks Map                        │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                   │
│  ┌──────────────────────────┴──────────────────────────────┐   │
│  │              Poll Loop (every 2-3s)                       │   │
│  │  → gob list --json (check status)                        │   │
│  │  → gob stdout <id> (read output)                         │   │
│  │  → Reactive output: pattern match → notify LLM           │   │
│  └──────────────────────────┬──────────────────────────────┘   │
│                             │                                   │
│                             ▼ (on completion)                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │           completeBackgroundTask()                        │   │
│  │  → readFullResult() (session file → gob stdout → tail)   │   │
│  │  → Branch:                                               │   │
│  │    • RPC-spawned? → emit subagents:completed/failed      │   │
│  │    • Normal?      → pi.sendMessage(triggerTurn: true)     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  @tintinweb/pi-subagents RPC Protocol v2                 │   │
│  │  • subagents:rpc:ping → version handshake                │   │
│  │  • subagents:rpc:spawn → policy check → spawnGob         │   │
│  │  • subagents:rpc:stop → gob stop                         │   │
│  │  • subagents:ready → emitted at load + session_start     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│        gob           │  ← External Go binary (process manager)
│  • Daemon-managed    │     Jobs survive pi crashes
│  • SQLite-backed     │     Per-directory scoping
│  • CLI: add/list/    │     Real-time log streaming
│    stop/stdout       │
└─────────────────────┘
```

---

## Key Design Decisions

### 1. Two-tier control model

| Actor | Shell commands | Agent spawning |
|-------|---------------|----------------|
| **Human** | ✅ `/bg run` (always) | ✅ `/bg agent` (always) |
| **LLM** | ✅ `bg_process` tool (policy-gated) | ❌ No tool (denied by default) |
| **pi-tasks** | N/A | ✅ RPC spawn (policy-gated, default: deny) |

Through pi-backtask APIs, the LLM can manage shell processes (dev servers, test watchers) under policy, but cannot spawn autonomous agents unless explicitly permitted in settings. This is not a sandbox for arbitrary `bash`; see caveats below.

### 2. Policy system

```json
{
  "backtask": {
    "tool": true,
    "policy": {
      "shell": "allow",
      "shellWatch": "confirm",
      "agent": "deny",
      "agentRw": "deny",
      "agentFull": "deny",
      "kill": "allow"
    }
  }
}
```

- **`allow`** — executes immediately, no gate
- **`confirm`** — hard gate: returns a message telling the LLM to ask the user, provides the `/bg` command they'd need to run
- **`deny`** — blocked, error returned

Settings load global first (`~/.pi/agent/settings.json`), then project (`.pi/settings.json`) overrides only the keys it defines. Explicit invalid policy values fail closed as `deny`; an explicit invalid `tool` value fails closed as disabled.

### 3. External process management (gob)

Unlike most pi extensions that use in-process `spawn()`, we delegate to **gob** — an external daemon that manages processes independently. This means:
- Jobs survive pi crashes and session restarts
- You can inspect jobs outside pi via `gob list`, `gob stdout`, `gob tui`
- Pairs with `@juanibiapina/pi-gob` extension for native pi TUI integration

Trade-off: 3-5s latency on status updates (poll-based) vs instant (in-process pipe).

### 4. Full result reading on completion

When an agent completes, we don't just use the polled output tail. We read the **full result** via:
1. Session file (`.jsonl`) — parse the last assistant message for complete response
2. `gob stdout` — full process output
3. Polled tail (last 50 lines) — fallback

Results are capped at 12K chars. Normal `/bg` completions are injected with `triggerTurn: true`; RPC-spawned agents emit pi-tasks lifecycle events instead, so pi-tasks owns result routing.

### 5. Prompt injection prevention in RPC handler

The RPC spawn handler builds pi CLI args directly rather than going through `parseBgAgentArgs` (which interprets slash-command flags). This prevents a malicious prompt like `"--full do bad things"` from being interpreted as flags.

### 6. Background command interception

When the `bg_process` tool is enabled, we also block bash background patterns (`&`, `nohup`, `disown`, `setsid`) via a `tool_call` hook, redirecting the LLM to use the managed `bg_process` tool instead.

---

## Design / Security Caveats

pi-backtask is a coordination tool, not a sandbox.

- If the LLM has arbitrary shell access, it can potentially invoke `pi`, `gob`, other agent CLIs, network tools, or local scripts. The `agent*` policies gate pi-backtask's RPC path; they do not sandbox `bash` or the OS.
- Human slash commands are intentionally outside LLM policy. `/bg run`, `/bg agent`, and `/bg kill` remain human-controlled escape hatches.
- Bash background interception is best effort. It blocks common patterns, but it is not a full shell parser or security boundary.
- Gob jobs survive parent Pi crashes, but pi-backtask currently does not reattach old gob jobs into its in-memory task map after restart. Inspect old jobs with `gob list`/`gob stdout`.
- Completion and reactive-output boomerangs inject untrusted child process/agent output into the parent conversation. Treat it as evidence, not instructions.
- Agents share the current working tree unless the user launches Pi from a separate worktree/container.
- Polling currently reads accumulated gob stdout; very noisy long-running jobs can make polling/result capture expensive.

---

## Latest Bugfix Pass (`0e3fcea`)

This handoff includes the post-review bugfix commit. Key fixes:

- Policy settings now merge global → project overrides and fail closed on invalid explicit policy/tool values.
- RPC `confirm` now hard-gates pi-tasks spawns instead of notifying and continuing.
- RPC stop now marks the tracked background task as killed and emits the `status: "stopped"` lifecycle path for pi-tasks.
- Agent session-result parsing now handles Pi v3 JSONL `message` envelopes as well as the older top-level role/content shape.
- Reactive output debounce now batches actual pending output, checks new output before last-line de-dupe, resets regex state, and clears timers on completion/shutdown.
- `/bg run` and `/bg agent` slash parsing now handles quoted leading arguments used in the README examples.
- RPC spawn startup failures no longer return success IDs, and fast RPC jobs register their subagent mapping before polling can complete them.
- Bash background-pattern interception remains active when shell policy is denied.

---

## pi-tasks Protocol Compatibility

Implemented against `@tintinweb/pi-tasks` source/protocol expectations:

| Protocol Event | pi-tasks sends/expects | pi-backtask provides | ✓ |
|---|---|---|---|
| `subagents:rpc:ping` | Expects `{ success: true, data: { version: 2 } }` | Returns exactly this | ✓ |
| `subagents:rpc:spawn` | Sends `{ requestId, type, prompt, options: { description, isBackground, maxTurns?, model? } }` | Handles all fields, maps type to capabilities | ✓ |
| `subagents:rpc:spawn` reply | Expects `{ success: true, data: { id: string } }` | Returns `backtask-agent-<N>` ID | ✓ |
| `subagents:rpc:stop` | Sends `{ requestId, agentId }` | Routes to `gob stop`, marks task killed, emits stopped lifecycle, replies success/failure | ✓ |
| `subagents:completed` | Listens for `{ id, result }` | Emitted on successful completion | ✓ |
| `subagents:failed` | Listens for `{ id, error, result, status }` | Emitted on failure/kill | ✓ |
| `status: "stopped"` | pi-tasks marks task completed (intentional) | Mapped from our "killed" state | ✓ |
| `subagents:ready` | pi-tasks calls `checkSubagentsVersion()` | Emitted at load + session_start | ✓ |
| Load order independence | pi-tasks handles either loading first | Dual-emit handles both orderings | ✓ |

**To enable:** Set `"agent": "allow"` in policy settings. Without this, pi-tasks' `TaskExecute` will receive `"Denied by policy"` errors (safe default). `"confirm"` is a hard gate/rejection path, not an interactive approval flow.

---

## Feature Summary

### Shell Background (`/bg run` + `bg_process` tool)

- Start any shell command in background via gob
- `--watch` flag: reactive output monitoring (wakes LLM on new output)
- `--pattern` flag: filter notifications by substring or `/regex/flags`
- Debounced notifications (2s) to batch rapid output
- Completion always notifies parent LLM
- Background command interception (best-effort block for `&`/`nohup`/`disown`/`setsid` in bash)

### Agent Delegation (`/bg agent` — human only)

- Spawns full `pi` sessions as gob-managed background processes
- `--rw` — adds edit+write tools
- `--think` — enables extended thinking (high)
- `--model <m>` — override model
- `--full` — all tools + extensions + thinking
- Default: read-only, no thinking, no extensions (safe for analysis)
- Inherits parent session's model when no `--model` specified
- Session files logged to `~/.pi/agent/sessions/pi-backtask/`

### Result Injection (the "boomerang")

- On completion: reads full result from session file (last assistant message, including Pi v3 JSONL message envelopes)
- Injects into conversation via `pi.sendMessage({ triggerTurn: true })`
- Parent LLM wakes up and processes the result
- 12K char cap to prevent context overflow

### Task List (`/task`)

- Persistent across sessions (file-backed per project/env)
- `/task add|start|done|pending|remove|clear|list`
- Footer widget (Ctrl+T)

### TUI

- Background widget (Ctrl+B) — shows task status, last output line, elapsed time
- Footer widget (Ctrl+T) — task list
- Status bar integration

---

## What's NOT Implemented (intentional gaps)

| Feature | Why not |
|---|---|
| In-process subagents (`createAgentSession`) | We use gob for crash survival. Trade-off: latency vs reliability. |
| Mid-run steering / intercom | Out of scope. Use nicobailon or tintinweb extensions for that. |
| Git worktree isolation | Would add complexity. Agents run in cwd by default. |
| Persistent agent memory | Not needed for fire-and-forget delegation. |
| Full TUI log viewer | `gob tui` or `@juanibiapina/pi-gob` extension covers this. |
| Agent-to-agent communication | Not supported. Each agent is independent. |
| Extension reattachment after restart | gob jobs survive, but pi-backtask does not currently rebuild its in-memory task map or boomerang old results after a parent Pi restart. |

---

## File Map

```
pi-backtask/
├── pi-backtask.ts    # Everything — single-file extension (1676 lines)
├── README.md         # Full documentation (466 lines)
├── .gitignore
└── (no dependencies beyond pi-coding-agent peer)
```

---

## How to Review

1. **Commit log** — each commit is a logical unit: `git log --oneline`
2. **Policy enforcement** — grep for `settings.policy` to trace all gates
3. **RPC protocol** — search for `subagents:rpc` to see the full compatibility layer
4. **Result flow** — trace `completeBackgroundTask` → `readFullResult` → branch (RPC emit vs sendMessage)
5. **Prompt injection** — verify RPC spawn builds args directly (no `parseBgAgentArgs`)
6. **Syntax/static checks** — latest pass used `npx -y esbuild pi-backtask.ts --bundle --platform=node --format=cjs --outfile=/tmp/pi-backtask.js --external:@mariozechner/pi-coding-agent --external:@mariozechner/pi-tui` plus `git diff --check`. A full `tsc` pass needs a Pi dev environment or explicit TypeScript/node/Pi type dependencies because this repo intentionally has no local `package.json`.

---

## Recommended Settings for Different Use Cases

### Conservative (default) — LLM handles shell, humans handle agents

```json
{ "backtask": { "tool": true, "policy": { "shell": "allow", "shellWatch": "confirm", "agent": "deny", "agentRw": "deny", "agentFull": "deny", "kill": "allow" } } }
```

### With pi-tasks — allow task-driven agent execution

```json
{ "backtask": { "tool": true, "policy": { "shell": "allow", "shellWatch": "allow", "agent": "allow", "agentRw": "deny", "agentFull": "deny", "kill": "allow" } } }
```

### Locked down — pure human-only

```json
{ "backtask": { "tool": false } }
```

### Wide open — full autonomy (not recommended)

```json
{ "backtask": { "tool": true, "policy": { "shell": "allow", "shellWatch": "allow", "agent": "allow", "agentRw": "allow", "agentFull": "allow", "kill": "allow" } } }
```
