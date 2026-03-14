/**
 * pi-backtask — Background task + task-list workflow
 *
 * Shortcuts:
 *   Ctrl+B  Toggle background tasks widget
 *   Ctrl+T  Toggle task-list footer
 *
 * Commands:
 *   /task add <text>
 *   /task start <id>
 *   /task done <id>
 *   /task pending <id>
 *   /task remove <id>
 *   /task clear
 *   /task list
 *
 *   /bg run <bash command>
 *   /bg agent <prompt>
 *   /bg list
 *   /bg kill <id>
 *   /bg clear
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const { spawn } = require("child_process") as any;

type TaskStatus = "pending" | "in_progress" | "completed";

type BackgroundStatus = "running" | "completed" | "failed" | "killed";

type BackgroundKind = "shell" | "agent";

interface BackTaskItem {
	id: number;
	text: string;
	status: TaskStatus;
	createdAt: string;
	updatedAt: string;
}

interface BackgroundTask {
	id: number;
	kind: BackgroundKind;
	title: string;
	status: BackgroundStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	outputTail: string[];
	proc?: any;
	sessionFile?: string;
}

interface PersistedState {
	nextTaskId: number;
	tasks: BackTaskItem[];
}

const STATUS_ICON: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "●",
	completed: "✓",
};

function nowIso(): string {
	return new Date().toISOString();
}

function getListId(): string {
	const fromEnv = String(process.env.PI_BACKTASK_LIST_ID || "").trim();
	if (fromEnv) return fromEnv;
	const cwdName = path.basename(process.cwd() || "").trim();
	return cwdName || "default";
}

function statePath(): string {
	const dir = path.join(os.homedir(), ".pi", "backtask-lists");
	fs.mkdirSync(dir, { recursive: true });
	return path.join(dir, `${getListId()}.json`);
}

function readState(): PersistedState {
	const file = statePath();
	if (!fs.existsSync(file)) {
		return { nextTaskId: 1, tasks: [] };
	}
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		const nextTaskId = Number(parsed?.nextTaskId) || 1;
		const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
		return {
			nextTaskId: Math.max(1, Math.trunc(nextTaskId)),
			tasks,
		};
	} catch {
		return { nextTaskId: 1, tasks: [] };
	}
}

function writeState(state: PersistedState) {
	try {
		fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), "utf8");
	} catch {
		// best-effort persistence only
	}
}

function formatDuration(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	return `${min}m ${sec % 60}s`;
}

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;

	let nextTaskId = 1;
	let tasks: BackTaskItem[] = [];

	let nextBgId = 1;
	const backgroundTasks: Map<number, BackgroundTask> = new Map();

	let showTaskFooter = true;
	let showBackgroundWidget = false;

	function persist() {
		writeState({ nextTaskId, tasks });
	}

	function activeTaskCount() {
		return tasks.filter((t) => t.status === "in_progress").length;
	}

	function pendingTaskCount() {
		return tasks.filter((t) => t.status === "pending").length;
	}

	function completedTaskCount() {
		return tasks.filter((t) => t.status === "completed").length;
	}

	function runningBgCount() {
		return Array.from(backgroundTasks.values()).filter((t) => t.status === "running").length;
	}

	function refreshStatus(ctx: ExtensionContext) {
		const total = tasks.length;
		ctx.ui.setStatus(
			`backtask: ${total} total | ${activeTaskCount()} active | ${pendingTaskCount()} pending | ${runningBgCount()} bg running`,
			"pi-backtask"
		);
	}

	function refreshFooter(ctx: ExtensionContext) {
		if (!showTaskFooter) {
			ctx.ui.setFooter(() => ({
				dispose: () => {},
				invalidate() {},
				render(): string[] {
					return [];
				},
			}));
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const total = tasks.length;
					const left =
						theme.fg("accent", " BackTask ") +
						theme.fg("dim", ` list=${getListId()}`);
					const right =
						theme.fg("accent", `active ${activeTaskCount()}`) +
						theme.fg("dim", "  ") +
						theme.fg("muted", `pending ${pendingTaskCount()}`) +
						theme.fg("dim", "  ") +
						theme.fg("success", `done ${completedTaskCount()}`) +
						theme.fg("dim", "  ") +
						theme.fg("warning", `bg ${runningBgCount()}`);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					const line1 = truncateToWidth(left + pad + right, width, "");

					if (total === 0) {
						return [line1, truncateToWidth(` ${theme.fg("dim", "No tasks. Use /task add <text>.")}`, width, "")];
					}

					const ordered = [
						...tasks.filter((t) => t.status === "in_progress"),
						...tasks.filter((t) => t.status === "pending"),
						...tasks.filter((t) => t.status === "completed").slice(-10),
					].slice(0, 10);

					const rows = ordered.map((task) => {
						const icon =
							task.status === "completed"
								? theme.fg("success", STATUS_ICON.completed)
								: task.status === "in_progress"
									? theme.fg("accent", STATUS_ICON.in_progress)
									: theme.fg("muted", STATUS_ICON.pending);
						const label = task.status === "completed"
							? theme.fg("dim", task.text)
							: task.status === "in_progress"
								? theme.fg("success", task.text)
								: theme.fg("muted", task.text);
						return truncateToWidth(` ${icon} ${theme.fg("accent", `#${task.id}`)} ${label}`, width, "");
					});
					return [line1, ...rows];
				},
			};
		});
	}

	function refreshBackgroundWidget(ctx: ExtensionContext) {
		if (!showBackgroundWidget) {
			ctx.ui.setWidget("pi-backtask-bg", undefined);
			return;
		}

		ctx.ui.setWidget(
			"pi-backtask-bg",
			(_tui, theme) => {
				const container = new Container();
				const borderFn = (s: string) => theme.fg("dim", s);
				container.addChild(new DynamicBorder(borderFn));
				const content = new Text("", 1, 0);
				container.addChild(content);
				container.addChild(new DynamicBorder(borderFn));

				return {
					invalidate() {
						container.invalidate();
					},
					render(width: number): string[] {
						const rows: string[] = [];
						const items = Array.from(backgroundTasks.values()).sort((a, b) => b.id - a.id).slice(0, 10);
						rows.push(theme.fg("accent", " Background Tasks ") + theme.fg("dim", ` running=${runningBgCount()}`));
						if (items.length === 0) {
							rows.push(theme.fg("dim", "  none"));
						} else {
							for (const task of items) {
								const statusColor =
									task.status === "running"
										? "accent"
										: task.status === "completed"
											? "success"
											: task.status === "killed"
												? "warning"
												: "error";
								const elapsed = formatDuration((task.endedAt || Date.now()) - task.startedAt);
								const head = `${task.kind} #${task.id} ${task.status} (${elapsed})`;
								rows.push(theme.fg(statusColor, truncateToWidth(`  ${head}`, width - 2, "")));
								if (task.outputTail.length > 0) {
									const tail = task.outputTail[task.outputTail.length - 1] || "";
									rows.push(theme.fg("muted", truncateToWidth(`    ${tail}`, width - 2, "")));
								}
							}
						}
						content.setText(rows.join("\n"));
						return container.render(width);
					},
				};
			},
			{ placement: "belowEditor" }
		);
	}

	function refreshAll(ctx: ExtensionContext) {
		refreshStatus(ctx);
		refreshFooter(ctx);
		refreshBackgroundWidget(ctx);
	}

	function parseId(arg: string): number | null {
		const num = Number(arg);
		if (!Number.isFinite(num)) return null;
		const id = Math.trunc(num);
		return id > 0 ? id : null;
	}

	function appendTail(bg: BackgroundTask, chunk: string) {
		const lines = chunk
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		if (lines.length === 0) return;
		bg.outputTail.push(...lines);
		if (bg.outputTail.length > 20) {
			bg.outputTail = bg.outputTail.slice(-20);
		}
	}

	function completeBackgroundTask(ctx: ExtensionContext, bg: BackgroundTask, status: BackgroundStatus, exitCode: number | null = null) {
		bg.status = status;
		bg.endedAt = Date.now();
		bg.exitCode = exitCode;
		bg.proc = undefined;
		refreshAll(ctx);

		const headline =
			status === "completed"
				? `${bg.kind} #${bg.id} completed`
				: status === "killed"
					? `${bg.kind} #${bg.id} killed`
					: `${bg.kind} #${bg.id} failed`;
		ctx.ui.notify(headline, status === "completed" ? "success" : status === "killed" ? "warning" : "error");

		const tail = bg.outputTail.join("\n");
		if (tail.trim()) {
			pi.sendMessage(
				{
					customType: "backtask-result",
					content: `[${headline}]\n\n${tail.slice(-6000)}`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true }
			);
		}
	}

	function spawnShellBackground(ctx: ExtensionContext, command: string) {
		const id = nextBgId++;
		const bg: BackgroundTask = {
			id,
			kind: "shell",
			title: command,
			status: "running",
			startedAt: Date.now(),
			outputTail: [],
		};
		backgroundTasks.set(id, bg);
		refreshAll(ctx);

		const proc = spawn("bash", ["-lc", command], {
			cwd: process.cwd(),
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		bg.proc = proc;

		proc.stdout?.setEncoding("utf-8");
		proc.stderr?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			appendTail(bg, chunk);
			if (ctxRef) refreshBackgroundWidget(ctxRef);
		});
		proc.stderr?.on("data", (chunk: string) => {
			appendTail(bg, chunk);
			if (ctxRef) refreshBackgroundWidget(ctxRef);
		});
		proc.on("close", (code: number | null) => {
			if (!ctxRef) return;
			completeBackgroundTask(ctxRef, bg, code === 0 ? "completed" : "failed", code);
		});
		proc.on("error", (err: Error) => {
			appendTail(bg, `spawn error: ${err.message}`);
			if (!ctxRef) return;
			completeBackgroundTask(ctxRef, bg, "failed", null);
		});

		return bg;
	}

	function makeAgentSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "pi-backtask");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `agent-${id}-${Date.now()}.jsonl`);
	}

	function spawnAgentBackground(ctx: ExtensionContext, prompt: string) {
		const id = nextBgId++;
		const sessionFile = makeAgentSessionFile(id);
		const bg: BackgroundTask = {
			id,
			kind: "agent",
			title: prompt,
			status: "running",
			startedAt: Date.now(),
			outputTail: [],
			sessionFile,
		};
		backgroundTasks.set(id, bg);
		refreshAll(ctx);

		const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";
		const proc = spawn(
			"pi",
			[
				"--mode",
				"json",
				"-p",
				"--session",
				sessionFile,
				"--no-extensions",
				"--model",
				model,
				"--tools",
				"read,bash,grep,find,ls",
				"--thinking",
				"off",
				prompt,
			],
			{
				cwd: process.cwd(),
				env: { ...process.env },
				stdio: ["ignore", "pipe", "pipe"],
			}
		);
		bg.proc = proc;

		let buffer = "";
		proc.stdout?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line);
					if (event.type === "message_update") {
						const delta = event.assistantMessageEvent;
						if (delta?.type === "text_delta") {
							appendTail(bg, String(delta.delta || ""));
						}
					}
				} catch {
					appendTail(bg, line);
				}
			}
			if (ctxRef) refreshBackgroundWidget(ctxRef);
		});

		proc.stderr?.setEncoding("utf-8");
		proc.stderr?.on("data", (chunk: string) => {
			appendTail(bg, chunk);
			if (ctxRef) refreshBackgroundWidget(ctxRef);
		});

		proc.on("close", (code: number | null) => {
			if (!ctxRef) return;
			if (buffer.trim()) appendTail(bg, buffer);
			completeBackgroundTask(ctxRef, bg, code === 0 ? "completed" : "failed", code);
		});

		proc.on("error", (err: Error) => {
			appendTail(bg, `spawn error: ${err.message}`);
			if (!ctxRef) return;
			completeBackgroundTask(ctxRef, bg, "failed", null);
		});

		return bg;
	}

	function ensureSingleInProgress(ctx: ExtensionContext) {
		const active = tasks.filter((t) => t.status === "in_progress");
		if (active.length <= 1) return;
		const keepId = active[active.length - 1]?.id;
		for (const task of tasks) {
			if (task.status === "in_progress" && task.id !== keepId) {
				task.status = "pending";
				task.updatedAt = nowIso();
			}
		}
		ctx.ui.notify("Only one task can stay in progress; older active tasks moved to pending.", "warning");
	}

	pi.registerShortcut("ctrl+t", {
		description: "Toggle backtask list footer",
		handler: async (ctx) => {
			ctxRef = ctx;
			showTaskFooter = !showTaskFooter;
			refreshAll(ctx);
			ctx.ui.notify(`Task list ${showTaskFooter ? "shown" : "hidden"}.`, "info");
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Toggle background tasks widget",
		handler: async (ctx) => {
			ctxRef = ctx;
			showBackgroundWidget = !showBackgroundWidget;
			refreshBackgroundWidget(ctx);
			ctx.ui.notify(`Background widget ${showBackgroundWidget ? "shown" : "hidden"}.`, "info");
		},
	});

	pi.registerCommand("task", {
		description: "Manage task list. Examples: /task add <text>, /task start <id>, /task done <id>, /task list",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [actionRaw, ...rest] = String(args || "").trim().split(/\s+/);
			const action = String(actionRaw || "list").toLowerCase();
			const payload = rest.join(" ").trim();

			if (action === "add") {
				if (!payload) {
					ctx.ui.notify("Usage: /task add <text>", "error");
					return;
				}
				tasks.push({
					id: nextTaskId++,
					text: payload,
					status: tasks.length === 0 ? "in_progress" : "pending",
					createdAt: nowIso(),
					updatedAt: nowIso(),
				});
				ensureSingleInProgress(ctx);
				persist();
				refreshAll(ctx);
				ctx.ui.notify("Task added.", "success");
				return;
			}

			if (action === "start" || action === "done" || action === "pending" || action === "remove") {
				const id = parseId(payload);
				if (!id) {
					ctx.ui.notify(`Usage: /task ${action} <id>`, "error");
					return;
				}
				const idx = tasks.findIndex((t) => t.id === id);
				if (idx < 0) {
					ctx.ui.notify(`Task #${id} not found.`, "error");
					return;
				}
				if (action === "remove") {
					tasks.splice(idx, 1);
				} else {
					tasks[idx].status = action === "start" ? "in_progress" : action === "done" ? "completed" : "pending";
					tasks[idx].updatedAt = nowIso();
					ensureSingleInProgress(ctx);
				}
				persist();
				refreshAll(ctx);
				ctx.ui.notify(`Task ${action} applied.`, "success");
				return;
			}

			if (action === "clear") {
				tasks = [];
				nextTaskId = 1;
				persist();
				refreshAll(ctx);
				ctx.ui.notify("Task list cleared.", "warning");
				return;
			}

			if (action === "list") {
				if (tasks.length === 0) {
					ctx.ui.notify("No tasks. Use /task add <text>.", "info");
					return;
				}
				const rows = tasks
					.map((t) => `${STATUS_ICON[t.status]} #${t.id} [${t.status}] ${t.text}`)
					.join("\n");
				pi.sendMessage({
					customType: "backtask-list",
					content: `Task list (${getListId()}):\n${rows}`,
					display: true,
				});
				return;
			}

			ctx.ui.notify("Unknown /task action. Try: add|start|done|pending|remove|clear|list", "error");
		},
	});

	pi.registerCommand("bg", {
		description: "Manage background tasks. Examples: /bg run <cmd>, /bg agent <prompt>, /bg list, /bg kill <id>",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const [actionRaw, ...rest] = String(args || "").trim().split(/\s+/);
			const action = String(actionRaw || "list").toLowerCase();
			const payload = rest.join(" ").trim();

			if (action === "run") {
				if (!payload) {
					ctx.ui.notify("Usage: /bg run <bash command>", "error");
					return;
				}
				const bg = spawnShellBackground(ctx, payload);
				ctx.ui.notify(`Started shell #${bg.id}`, "info");
				return;
			}

			if (action === "agent") {
				if (!payload) {
					ctx.ui.notify("Usage: /bg agent <prompt>", "error");
					return;
				}
				const bg = spawnAgentBackground(ctx, payload);
				ctx.ui.notify(`Started agent #${bg.id}`, "info");
				return;
			}

			if (action === "kill") {
				const id = parseId(payload);
				if (!id) {
					ctx.ui.notify("Usage: /bg kill <id>", "error");
					return;
				}
				const bg = backgroundTasks.get(id);
				if (!bg) {
					ctx.ui.notify(`Background task #${id} not found.`, "error");
					return;
				}
				if (bg.proc && bg.status === "running") {
					bg.proc.kill("SIGTERM");
					completeBackgroundTask(ctx, bg, "killed", null);
					return;
				}
				ctx.ui.notify(`Background task #${id} is not running.`, "warning");
				return;
			}

			if (action === "clear") {
				for (const [id, bg] of Array.from(backgroundTasks.entries())) {
					if (bg.status !== "running") backgroundTasks.delete(id);
				}
				refreshAll(ctx);
				ctx.ui.notify("Cleared non-running background tasks.", "info");
				return;
			}

			if (action === "list") {
				const rows = Array.from(backgroundTasks.values())
					.sort((a, b) => b.id - a.id)
					.map((bg) => {
						const elapsed = formatDuration((bg.endedAt || Date.now()) - bg.startedAt);
						return `#${bg.id} [${bg.kind}] ${bg.status} ${elapsed} - ${bg.title}`;
					});
				pi.sendMessage({
					customType: "backtask-bg-list",
					content: rows.length > 0 ? `Background tasks:\n${rows.join("\n")}` : "No background tasks.",
					display: true,
				});
				return;
			}

			ctx.ui.notify("Unknown /bg action. Try: run|agent|list|kill|clear", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		// Standalone plugin: no repo-specific theme defaults dependency.
		const state = readState();
		nextTaskId = state.nextTaskId;
		tasks = state.tasks;
		refreshAll(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		ctxRef = ctx;
		const state = readState();
		nextTaskId = state.nextTaskId;
		tasks = state.tasks;
		refreshAll(ctx);
	});

	pi.on("session_shutdown", async () => {
		persist();
		if (!ctxRef) return;
		for (const bg of backgroundTasks.values()) {
			if (bg.proc && bg.status === "running") {
				bg.proc.kill("SIGTERM");
			}
		}
		ctxRef.ui.setWidget("pi-backtask-bg", undefined);
	});
}
