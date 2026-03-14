# pi-backtask

`pi-backtask` is a Pi Coding Agent extension that adds two Claude Code style workflows:

1. Persistent task list management (`/task ...`)
2. Background jobs for shell commands and Pi agents (`/bg ...`)

## Dependency: gob

This plugin uses [`gob`](https://github.com/juanibiapina/gob) as the background-process backend for `/bg` commands.

Install on macOS:

```bash
brew tap juanibiapina/taps
brew install gob
```

If `gob` is missing, `/bg run` and `/bg agent` fail with an install hint.

## Features

- `Ctrl+T` toggles the task-list footer
- `Ctrl+B` toggles the background-task widget
- `/task add|start|done|pending|remove|clear|list`
- `/bg run|agent|list|kill|clear` (backed by `gob add/list/stop/stdout`)
- Non-intrusive integration: no `gob tui` launch and no fullscreen takeover

## Task list identity

Set `PI_BACKTASK_LIST_ID` to share task lists across sessions/terminals:

```bash
export PI_BACKTASK_LIST_ID=my-project
```

When not set, the plugin uses the current working-directory name.

## Usage

Run Pi with the plugin file:

```bash
pi -e /absolute/path/to/pi-backtask.ts
```

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
/bg run "pytest tests/unit/test_metrics.py -q"
/bg agent "Review app/core/pipeline.py and propose a safer retry strategy"
/bg list
/bg kill 2
/bg clear
```

## End-to-end examples

### Example A: run tests in background while continuing chat

```bash
/task add Validate feature branch before merge
/task start 1
/bg run "pytest tests/unit/test_metrics.py -q"
/bg list
```

Continue normal conversation while the tests run. Use `/bg list` to monitor and `/bg kill <id>` to stop if needed.

### Example B: delegate analysis to a background agent

```bash
/task add Audit websocket reconnection behavior
/task start 1
/bg agent "Audit websocket reconnection path and list concrete failure modes"
/bg list
```

The background agent runs as a detached `pi` process through `gob`, and the plugin tracks status/log tail in the widget.

## Notes on background jobs

- `/bg run` starts `bash -lc <command>` through `gob add`
- `/bg agent` starts a detached `pi` process through `gob add`
- `/bg kill <id>` maps to `gob stop <job_id>`
- Jobs are managed by gob, so they can outlive the current Pi session

## Troubleshooting

- **`gob: command not found`**
  - Install gob (see dependency section), then restart Pi.
- **Background task started but no output yet**
  - Use `/bg list` and wait a few seconds; output tail updates are polled from gob.
- **Need to inspect raw job output**
  - Use gob directly: `gob list`, `gob stdout <job_id>`, `gob logs <job_id>`.

## File

- `pi-backtask.ts`: plugin source
