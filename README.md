# pi-backtask

`pi-backtask` is a Pi Coding Agent extension that adds two Claude Code style workflows:

1. Persistent task list management (`/task ...`)
2. Background jobs for shell commands and Pi agents (`/bg ...`)

All background agent spawning is **human-initiated only** via slash commands — the LLM never gets a direct tool to spawn agents autonomously. However, when paired with `@tintinweb/pi-tasks`, the LLM can use `TaskExecute` to spawn agents through the structured task system (with dependency tracking and cascading). Results are automatically injected back into the parent conversation when complete.

## Dependency: gob

This plugin uses [`gob`](https://github.com/juanibiapina/gob) as the background-process backend for `/bg` commands. gob is a Go CLI process manager designed for AI agents and humans to share a view of background processes. Pre-built binaries are available for Linux and macOS (both amd64 and arm64).

### Install from release binary (Linux/macOS)

```bash
# Download latest release (adjust platform: linux_amd64, linux_arm64, darwin_amd64, darwin_arm64)
curl -LO https://github.com/juanibiapina/gob/releases/latest/download/gob_3.4.0_linux_amd64.tar.gz
tar -xzf gob_3.4.0_linux_amd64.tar.gz
sudo mv gob /usr/local/bin/   # or ~/.local/bin/
gob --version
```

### Install via Homebrew (macOS)

```bash
brew tap juanibiapina/taps
brew install gob
```

### Install from source (requires Go 1.25.4+)

```bash
go install github.com/juanibiapina/gob@latest
```

If `gob` is missing, `/bg run` and `/bg agent` fail with an install hint.

## Features

- **Human-controlled agent spawning** — only slash commands trigger background agents; the LLM cannot spawn them
- **Automatic result injection** — when a background agent completes, its full result is sent back into the conversation and triggers a new LLM turn
- **Session file reading** — agent results are read from the pi session file (last assistant message), not just polled stdout
- **Configurable agent capabilities** — flags for read/write, thinking, model override, full tool access
- **Persistent task list** — tracks what you're working on across sessions
- **@tintinweb/pi-tasks integration** — acts as the subagent backend for pi-tasks' TaskExecute (replaces @tintinweb/pi-subagents)
- **TUI widgets** — `Ctrl+T` toggles the task-list footer, `Ctrl+B` toggles the background-task widget
- **Process survival** — background jobs are managed by gob and survive pi crashes/restarts
- **Non-intrusive** — no `gob tui` launch, no fullscreen takeover

## Installation

### Auto-discovery (recommended)

Symlink or copy into your extensions directory:

```bash
ln -s /path/to/pi-backtask/pi-backtask.ts ~/.pi/agent/extensions/pi-backtask.ts
```

### Direct load

```bash
pi -e /absolute/path/to/pi-backtask.ts
```

### From git

```bash
pi install git:github.com/lhl/pi-backtask
```

## How Result Injection Works

The "boomerang" flow:

1. You type `/bg agent "review the auth module"` — human-initiated
2. gob spawns a detached `pi` process — survives if your session crashes
3. The extension polls gob every 2 seconds for status updates
4. On completion, the extension reads the **full result** (not just a tail):
   - First tries: the pi session file (`.jsonl`) — parses the last assistant message for the complete response
   - Falls back to: `gob stdout <jobId>` — full process output
   - Last resort: the polled output tail (last 50 lines)
5. The result is injected into the parent conversation via `pi.sendMessage()` with `triggerTurn: true`
6. The parent LLM wakes up, sees the completed result, and can act on it

Results are capped at 12K characters to avoid context overflow. The notification includes elapsed time and the original task prompt for context.

## Task list identity

Set `PI_BACKTASK_LIST_ID` to share task lists across sessions/terminals:

```bash
export PI_BACKTASK_LIST_ID=my-project
```

When not set, the plugin uses the current working-directory name.

## Command reference

### Task list commands

```bash
/task add Investigate model gating regressions
/task start 1
/task done 1
/task pending 1
/task remove 1
/task list
/task clear
```

### Background commands

```bash
# Shell commands
/bg run "pytest tests/unit/test_metrics.py -q"
/bg run --watch "npm run dev"                        # notify on any new output
/bg run --watch --pattern "FAIL" "pnpm test --watch"  # notify only on matching output
/bg run --watch --pattern "/error|warn/i" "make build" # regex pattern

# Agent tasks
/bg agent "Review app/core/pipeline.py and propose a safer retry strategy"
/bg agent --rw "Refactor the auth module to use middleware pattern"
/bg agent --think "Analyze this complex race condition in worker.ts"
/bg agent --model anthropic/claude-sonnet-4 "Review the API design"
/bg agent --full "Implement the new caching layer with full tool access"

# Management
/bg list
/bg kill 2
/bg clear
```

### Shell flags (`/bg run`)

| Flag | Effect |
|------|--------|
| (none) | Fire-and-forget — notifies only on exit |
| `--watch` | Reactive output — wakes the LLM when new output is detected |
| `--pattern <p>` | Only wakes on output matching pattern (implies `--watch`). Supports plain substring (case-insensitive) or `/regex/flags` |

### Agent flags (`/bg agent`)

Flags can be combined. Order doesn't matter — everything after flags is the prompt.

| Flag | Effect |
|------|--------|
| (none) | Read-only tools (`read,bash,grep,find,ls`), no thinking, no extensions |
| `--rw` | Adds `edit` and `write` tools (agent can modify files) |
| `--think` | Enables extended thinking (high level) |
| `--model <m>` | Override model (e.g. `anthropic/claude-sonnet-4`, `openrouter/google/gemini-3-flash-preview`) |
| `--full` | All tools + extensions + thinking (maximum capability) |

**Model inheritance:** When no `--model` flag is specified, the background agent inherits the current session's model (provider/id). If no model is available, falls back to `openrouter/google/gemini-3-flash-preview`.

**Combining flags:**

```bash
# Read-write + thinking + specific model
/bg agent --rw --think --model anthropic/claude-sonnet-4 "Refactor and add tests for the payment module"
```

### Default agent configuration

Without flags, background agents are spawned with:
- Tools: `read,bash,grep,find,ls` (read-only — safe for analysis tasks)
- Thinking: off (faster, cheaper)
- Extensions: disabled (`--no-extensions`)
- Mode: `json` (structured output)
- Session: logged to `~/.pi/agent/sessions/pi-backtask/agent-<id>-<timestamp>.jsonl`

## End-to-end examples

### Example A: run tests in background while continuing chat

```bash
/bg run "pytest tests/unit/test_metrics.py -q"
```

Continue normal conversation while the tests run. When tests complete, the result appears in the conversation and the LLM can react to pass/fail.

### Example B: scout/analyze in background

```bash
/bg agent "Analyze the auth flow in src/auth/. Map the key files, entry points, and identify potential security concerns."
```

The agent runs read-only in the background. When done, its analysis is injected into the conversation — the parent LLM can use it to inform next steps.

### Example C: background implementation with review

```bash
# First: have a background agent implement something
/bg agent --rw "Implement the caching layer described in docs/DESIGN.md"

# When it completes, the result appears in conversation.
# Then fire off a reviewer:
/bg agent "Review the changes just made to the caching implementation. Check for edge cases and missing error handling."
```

### Example D: parallel research

```bash
/bg agent "Research how rate limiting is typically implemented in Express.js middleware"
/bg agent "Look at our current middleware stack in src/middleware/ and document what's there"
/bg list
```

Both run concurrently. Results arrive as each completes.

### Example E: watch tests, react to failures

```bash
/bg run --watch --pattern "FAIL" "pnpm test --watch"
```

The test watcher runs in the background. Only when output contains "FAIL" does the LLM get notified — it can then investigate the failure. Passing tests produce no interruption.

### Example F: watch a dev server for errors

```bash
/bg run --watch --pattern "/error|exception|crash/i" "npm run dev"
```

The dev server runs in the background. The LLM is woken only when error-like output appears.

### Example G: use a powerful model for hard problems

```bash
/bg agent --think --model anthropic/claude-sonnet-4 "This test is flaky. Analyze the race condition in test/integration/worker.test.ts and propose a fix."
```

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | Toggle task-list footer |
| `Ctrl+B` | Toggle background-task widget |

## Background widget

When visible (`Ctrl+B`), the widget shows:

```
┌─────────────────────────────────────────────┐
│ Background Tasks  running=2                 │
│  agent #1 running (34s) gob:abc123          │
│    analyzing auth flow...                   │
│  shell #2 completed (12s) gob:def456        │
│    Tests passed: 42/42                      │
└─────────────────────────────────────────────┘
```

Each task shows: kind, ID, status, elapsed time, gob job reference, and last output line.

## Notes on background jobs

- `/bg run` starts `bash -lc <command>` through `gob add`
- `/bg agent` starts a detached `pi` process through `gob add`
- `/bg kill <id>` maps to `gob stop <job_id>`
- Jobs are managed by gob, so they can outlive the current Pi session
- When a background agent completes, its full result is read from the session file (or gob stdout) and injected into the parent conversation with `triggerTurn: true` — the parent LLM sees and processes the result automatically
- Agent results are capped at 12K characters to avoid context overflow
- By default, background agents inherit the current session's model
- Session files are stored at `~/.pi/agent/sessions/pi-backtask/`
- The gob polling interval is 2–3 seconds; polling stops automatically when no jobs are running
- Output tail (shown in widget during execution) buffers the last 50 lines

### Reactive output (`--watch`)

- When `--watch` is used, the extension monitors gob stdout every ~3s for new output
- If a `--pattern` is specified, only output matching the pattern triggers a notification
- Pattern matching supports plain substrings (case-insensitive) and `/regex/flags` syntax
- Output notifications are debounced (2s) to batch rapid output into a single alert
- Reactive notifications include up to 4K chars of the new output since the last alert
- Without `--watch`, shell commands only notify on exit (completion/failure)

## Troubleshooting

- **`gob: command not found`**
  - Install gob (see dependency section), then restart Pi.
- **Background task started but no output yet**
  - Use `/bg list` and wait a few seconds; output tail updates are polled from gob every 2s.
- **Result didn't appear in conversation**
  - Check if the agent is still running: `/bg list`
  - Check gob directly: `gob list`, `gob stdout <job_id>`
  - Session file may have useful details: check `~/.pi/agent/sessions/pi-backtask/`
- **Agent spawned with wrong model**
  - Use `--model` flag explicitly, or check that your current pi session has a model set
- **Need to inspect raw job output**
  - Use gob directly: `gob list`, `gob stdout <job_id>`, `gob logs <job_id>`
- **Want to see what the agent actually did**
  - Read the session file: it's a JSONL log of the full conversation including tool calls

## LLM-Callable Tool: `bg_process`

In addition to human-only slash commands, the extension can register a `bg_process` tool that the LLM can call directly — **for shell commands only, not agent spawning**.

This is controlled by settings. By default, the tool is enabled with sensible policies:

### Policy Configuration

Add to `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (project):

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

### Policy Levels

| Level | Behavior |
|-------|----------|
| `"allow"` | LLM can use freely, no confirmation |
| `"confirm"` | Hard gate — tool/RPC returns a message telling the LLM to ask the user for approval, and provides the equivalent `/bg` command where applicable. Does not execute. |
| `"deny"` | Blocked — tool/RPC returns an error telling the LLM to ask the user |

Explicit but invalid policy values fail closed as `"deny"`. Project settings override only the keys they define; unspecified keys inherit from global settings or defaults.

### Policy Actions

| Action | What it controls | Default |
|--------|------------------|---------|
| `shell` | Run shell commands in background | `"allow"` |
| `shellWatch` | Run shell commands with reactive output (`watch: true`) | `"confirm"` |
| `agent` | Spawn read-only background agents | `"deny"` |
| `agentRw` | Spawn read-write agents | `"deny"` |
| `agentFull` | Spawn full-capability agents | `"deny"` |
| `kill` | Kill running background tasks | `"allow"` |

### Tool Schema

The LLM sees this tool:

```typescript
bg_process({
  action: "run" | "list" | "kill",
  command?: string,     // for action="run"
  watch?: boolean,      // enable reactive output notifications
  pattern?: string,     // filter notifications (substring or /regex/)
  id?: number,          // for action="kill"
})
```

### Examples (LLM perspective)

```
// Start a dev server
bg_process({ action: "run", command: "npm run dev" })

// Watch tests for failures
bg_process({ action: "run", command: "pnpm test --watch", watch: true, pattern: "FAIL" })

// Check what's running
bg_process({ action: "list" })

// Kill a stuck process
bg_process({ action: "kill", id: 3 })
```

### Background Command Interception

When the tool is enabled, the extension also blocks common bash background patterns (`&`, `nohup`, `disown`, `setsid`) and redirects the LLM to use `bg_process` instead. This prevents the LLM from using shell tricks that would lose process tracking.

## Design and security caveats

pi-backtask is a coordination tool, not a sandbox. The policy system reduces accidental autonomy, but it does not make arbitrary shell access safe.

- **Shell policy can bypass agent policy.** If the LLM can run arbitrary shell commands, it can potentially invoke `pi`, `gob add -- pi ...`, other agent CLIs, network tools, or local scripts. The `agent*` policies gate pi-backtask's RPC agent path; they do not sandbox the `bash` tool or the operating system.
- **Human slash commands are intentionally outside LLM policy.** `/bg run`, `/bg agent`, and `/bg kill` are human-controlled commands. Policy applies to the LLM-callable `bg_process` tool and pi-tasks RPC spawns.
- **Background-command interception is best effort.** The bash hook blocks common unmanaged background patterns such as trailing `&`, `nohup`, `disown`, and `setsid`, but it is not a full shell parser or security boundary.
- **Gob process survival is stronger than extension reattachment.** Gob jobs survive Pi crashes and can be inspected with `gob list`/`gob stdout`; pi-backtask's in-memory task map currently does not reattach old gob jobs after a parent Pi restart. `/bg list`, widgets, and automatic result boomerangs only cover jobs tracked by the current extension instance.
- **Injected output is untrusted.** Completion and reactive-output notifications wake the parent LLM with text produced by shell commands or child agents. Treat that text like tool output: useful evidence, but not trusted instructions.
- **Agents share the current working tree by default.** There is no worktree/container isolation. Read-write agents can modify the same files as the parent session.
- **Polling reads accumulated gob stdout.** Very noisy long-running jobs can make polling/result capture expensive. Prefer patterns for watch mode and inspect huge logs directly with gob.

If you need stronger guarantees, combine pi-backtask with stricter Pi tool settings, disable or gate the built-in `bash` tool, run agents in disposable worktrees/containers, or keep `backtask.tool` disabled and use human-only slash commands.

### Disabling the Tool Entirely

Set `"tool": false` to keep pi-backtask human-only (slash commands work, no LLM tool):

```json
{
  "backtask": {
    "tool": false
  }
}
```

## @tintinweb/pi-tasks Compatibility

pi-backtask implements the `@tintinweb/pi-subagents` RPC event protocol, making it a drop-in gob-backed agent backend for [`@tintinweb/pi-tasks`](https://github.com/tintinweb/pi-tasks). This means pi-tasks' `TaskExecute` tool can spawn background agents through pi-backtask's gob infrastructure — no need to install `@tintinweb/pi-subagents` separately.

### How it works

1. **Discovery**: pi-backtask emits `subagents:ready` on load and responds to `subagents:rpc:ping` with protocol version 2
2. **Spawn**: When pi-tasks calls `TaskExecute`, the RPC request flows through `subagents:rpc:spawn` → pi-backtask spawns a gob-managed `pi` process
3. **Completion**: When the gob job finishes, pi-backtask emits `subagents:completed` (or `subagents:failed`) → pi-tasks updates task status and cascades dependencies
4. **Stop**: pi-tasks' `TaskStop` sends `subagents:rpc:stop` → pi-backtask calls `gob stop`

### Agent type mapping

pi-tasks' `agentType` field maps to pi-backtask capabilities:

| agentType | Tools | Thinking | Extensions |
|-----------|-------|----------|------------|
| `"code"` or `"edit"` | read, bash, grep, find, ls, edit, write | off | disabled |
| `"full"` | all (read, bash, grep, find, ls, edit, write) | high | enabled |
| any other | read, bash, grep, find, ls (read-only) | off | disabled |

### Setup

Install both extensions — no additional configuration needed:

```bash
pi install npm:@tintinweb/pi-tasks
# pi-backtask installed via git or symlink (see Installation section)
```

Do **not** install `@tintinweb/pi-subagents` — pi-backtask replaces it with gob-backed agents that survive pi crashes.

### Policy enforcement on pi-tasks RPC

The same policy system gates RPC spawns from pi-tasks. Since pi-tasks typically sends generic agent types (e.g., `"general-purpose"`, `"Explore"`), these hit the `agent` policy. With the default `"deny"`, pi-tasks' `TaskExecute` will receive an error. Set `"agent": "allow"` to enable automatic TaskExecute spawns. `"confirm"` remains a hard gate: it rejects the RPC spawn and asks for human approval/manual action.

### Benefits over @tintinweb/pi-subagents

- **Process isolation** — agents run as separate OS processes via gob, not in-process
- **Crash survival** — gob-managed processes outlive the parent pi session
- **Session logging** — each agent's full conversation is logged to a JSONL session file
- **Unified management** — agents spawned by TaskExecute show up in `/bg list` and the background widget (`Ctrl+B`)
- **Full result capture** — completion events include the agent's full response (read from session file), not just a summary

## Differences from upstream (artiombell/pi-backtask)

This fork (lhl/pi-backtask) adds:

- **@tintinweb/pi-tasks compatibility** — implements the `pi-subagents` RPC protocol so TaskExecute spawns gob-backed agents
- **LLM-callable `bg_process` tool** — policy-gated tool for shell commands (agent spawning stays human-only)
- **Fine-grained policy system** — per-action allow/confirm/deny controls in settings
- **Background command interception** — blocks `&`/`nohup`/`disown` in bash, redirects to `bg_process`
- **Full result injection** — reads the complete agent response from session file, not just polled tail
- **Reactive output** — `--watch` and `--pattern` flags for shell commands; wakes the LLM on matching output
- **Agent flags** — `--rw`, `--think`, `--model`, `--full` for configurable agent capabilities
- **Larger result cap** — 12K chars (up from 6K)
- **Larger tail buffer** — 50 lines (up from 20)
- **Richer notifications** — includes elapsed time and original task in completion messages
- **Model inheritance** — agents inherit the parent session's model by default
- **Faster polling** — 3s throttle (down from 5s) for more responsive output tracking

## File

- `pi-backtask.ts`: plugin source (single-file extension)
