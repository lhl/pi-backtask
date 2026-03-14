# pi-backtask

`pi-backtask` is a Pi Coding Agent extension that adds two Claude Code style workflows:

1. Persistent task list management (`/task ...`)
2. Background jobs for shell commands and Pi agents (`/bg ...`)

## Features

- `Ctrl+T` toggles the task-list footer
- `Ctrl+B` toggles the background-task widget
- `/task add|start|done|pending|remove|clear|list`
- `/bg run|agent|list|kill|clear`
- Task-list persistence under `~/.pi/backtask-lists/<list-id>.json`

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

## File

- `pi-backtask.ts`: plugin source
