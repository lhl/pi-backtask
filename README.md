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
- `/bg run|agent|list|kill|clear` (backed by `gob add/list/stop`)
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

Example:

```bash
/task add Investigate model gating regressions
/task start 1
/bg run "pytest tests/unit/test_metrics.py -q"
/bg list
```

## Notes on background jobs

- `/bg run` starts `bash -lc <command>` through `gob add`
- `/bg agent` starts a detached `pi` process through `gob add`
- `/bg kill <id>` maps to `gob stop <job_id>`
- Jobs are managed by gob, so they can outlive the current Pi session


## File

- `pi-backtask.ts`: plugin source
