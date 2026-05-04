# pi-backtask — Reviewer Handoff Summary

**Repo:** https://github.com/lhl/pi-backtask  
**Fork of:** [artiombell/pi-backtask](https://github.com/artiombell/pi-backtask)  
**Single-file extension:** `pi-backtask.ts` (1467 lines)  
**Commit history:** 9 commits, ~1000 lines added over upstream

---

## What This Is

A pi-coding-agent extension that provides:

1. **Human-controlled background agent delegation** — `/bg agent` spawns full pi agent sessions via gob (an external process manager). The LLM cannot autonomously spawn agents.
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

The LLM can manage shell processes (dev servers, test watchers) freely, but cannot spawn autonomous agents unless explicitly permitted in settings.

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

Settings read from `.pi/settings.json` (project) then `~/.pi/agent/settings.json` (global). Project overrides global.

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

Results are capped at 12K chars and injected with `triggerTurn: true` so the parent LLM processes them.

### 5. Prompt injection prevention in RPC handler

The RPC spawn handler builds pi CLI args directly rather than going through `parseBgAgentArgs` (which splits on whitespace). This prevents a malicious prompt like `"--full do bad things"` from being interpreted as flags.

### 6. Background command interception

When the `bg_process` tool is enabled, we also block bash background patterns (`&`, `nohup`, `disown`, `setsid`) via a `tool_call` hook, redirecting the LLM to use the managed `bg_process` tool instead.

---

## pi-tasks Protocol Compatibility

Verified against `@tintinweb/pi-tasks` source and test suite:

| Protocol Event | pi-tasks sends/expects | pi-backtask provides | ✓ |
|---|---|---|---|
| `subagents:rpc:ping` | Expects `{ success: true, data: { version: 2 } }` | Returns exactly this | ✓ |
| `subagents:rpc:spawn` | Sends `{ requestId, type, prompt, options: { description, isBackground, maxTurns?, model? } }` | Handles all fields, maps type to capabilities | ✓ |
| `subagents:rpc:spawn` reply | Expects `{ success: true, data: { id: string } }` | Returns `backtask-agent-<N>` ID | ✓ |
| `subagents:rpc:stop` | Sends `{ requestId, agentId }` | Routes to `gob stop`, replies success/failure | ✓ |
| `subagents:completed` | Listens for `{ id, result }` | Emitted on successful completion | ✓ |
| `subagents:failed` | Listens for `{ id, error, result, status }` | Emitted on failure/kill | ✓ |
| `status: "stopped"` | pi-tasks marks task completed (intentional) | Mapped from our "killed" state | ✓ |
| `subagents:ready` | pi-tasks calls `checkSubagentsVersion()` | Emitted at load + session_start | ✓ |
| Load order independence | pi-tasks handles either loading first | Dual-emit handles both orderings | ✓ |

**To enable:** Set `"agent": "allow"` in policy settings. Without this, pi-tasks' `TaskExecute` will receive `"Denied by policy"` errors (safe default).

---

## Feature Summary

### Shell Background (`/bg run` + `bg_process` tool)

- Start any shell command in background via gob
- `--watch` flag: reactive output monitoring (wakes LLM on new output)
- `--pattern` flag: filter notifications by substring or `/regex/flags`
- Debounced notifications (2s) to batch rapid output
- Completion always notifies parent LLM
- Background command interception (blocks `&`/`nohup` in bash)

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

- On completion: reads full result from session file (last assistant message)
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
| Session resume | gob jobs survive but pi sessions don't carry over context. |

---

## File Map

```
pi-backtask/
├── pi-backtask.ts    # Everything — single-file extension (1467 lines)
├── README.md         # Full documentation (446 lines)
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
6. **TypeScript** — `npx tsc --noEmit --allowImportingTsExtensions --moduleResolution bundler --module esnext --target esnext pi-backtask.ts` passes clean

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
