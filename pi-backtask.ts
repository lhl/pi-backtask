/**
 * pi-backtask — Background task + task-list workflow
 *
 * This plugin uses gob (https://github.com/juanibiapina/gob) as the
 * background-process backend for /bg commands.
 *
 * Non-intrusive by design: it never launches `gob tui` or fullscreen views.
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

// Try to import Type for tool schema; falls back gracefully if unavailable
let Type: any;
try {
	Type = require("@sinclair/typebox").Type;
} catch {
	try {
		Type = require("@mariozechner/pi-ai").Type;
	} catch {
		// Type unavailable — tool registration will be skipped
	}
}

/**
 * Policy settings for the bg_process tool.
 * Each action can be: "allow" (no confirmation), "confirm" (requires approval), or "deny" (blocked).
 *
 * Configure in ~/.pi/agent/settings.json or .pi/settings.json:
 * {
 *   "backtask": {
 *     "tool": true,
 *     "policy": {
 *       "shell": "allow",
 *       "shellWatch": "confirm",
 *       "agent": "deny",
 *       "agentRw": "deny",
 *       "agentFull": "deny",
 *       "kill": "allow"
 *     }
 *   }
 * }
 */
type PolicyLevel = "allow" | "confirm" | "deny";

interface BacktaskPolicy {
	/** Run shell commands in background */
	shell: PolicyLevel;
	/** Run shell commands with --watch (reactive output) */
	shellWatch: PolicyLevel;
	/** Spawn read-only background agents */
	agent: PolicyLevel;
	/** Spawn read-write agents (--rw) */
	agentRw: PolicyLevel;
	/** Spawn full-capability agents (--full) */
	agentFull: PolicyLevel;
	/** Kill running background tasks */
	kill: PolicyLevel;
}

interface BacktaskSettings {
	/** Whether to register the bg_process tool for LLM use */
	tool: boolean;
	/** Per-action policy */
	policy: BacktaskPolicy;
}

const DEFAULT_POLICY: BacktaskPolicy = {
	shell: "allow",
	shellWatch: "confirm",
	agent: "deny",
	agentRw: "deny",
	agentFull: "deny",
	kill: "allow",
};

const DEFAULT_SETTINGS: BacktaskSettings = {
	tool: true,
	policy: DEFAULT_POLICY,
};

function loadBacktaskSettings(): BacktaskSettings {
	const locations = [
		path.join(process.cwd(), ".pi", "settings.json"),
		path.join(os.homedir(), ".pi", "agent", "settings.json"),
	];
	for (const loc of locations) {
		try {
			if (!fs.existsSync(loc)) continue;
			const raw = JSON.parse(fs.readFileSync(loc, "utf8"));
			const bt = raw?.backtask;
			if (!bt) continue;
			return {
				tool: bt.tool ?? DEFAULT_SETTINGS.tool,
				policy: { ...DEFAULT_POLICY, ...(bt.policy || {}) },
			};
		} catch { /* skip malformed */ }
	}
	return DEFAULT_SETTINGS;
}

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
	sessionFile?: string;
	gobJobId?: string;
	lastTailLine?: string;
	lastTailReadAt?: number;
	/** Reactive output: notify parent on new output */
	reactToOutput?: boolean;
	/** Only notify when output matches this pattern (substring or /regex/) */
	notifyPattern?: string;
	/** Compiled regex from notifyPattern */
	notifyMatcher?: RegExp | null;
	/** Track how much output we've already alerted on */
	lastAlertedLength?: number;
	/** Debounce timer for output reactions */
	outputReactTimer?: any;
}

interface PersistedState {
	nextTaskId: number;
	tasks: BackTaskItem[];
}

interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface GobListJob {
	id: string;
	status: string;
	command: string[];
	description?: string;
	created_at?: string;
	started_at?: string;
	exit_code?: number;
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
	if (bg.outputTail.length > 50) {
		bg.outputTail = bg.outputTail.slice(-50);
	}
}

async function execCommand(command: string, args: string[], cwd: string): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout?.setEncoding("utf-8");
		proc.stderr?.setEncoding("utf-8");
		proc.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		proc.on("close", (code: number | null) => {
			resolve({
				exitCode: typeof code === "number" ? code : 1,
				stdout,
				stderr,
			});
		});

		proc.on("error", (err: Error) => {
			resolve({
				exitCode: 1,
				stdout,
				stderr: `${stderr}\nspawn error: ${err.message}`.trim(),
			});
		});
	});
}

function extractGobJobId(output: string): string | null {
	const m = output.match(/\b(?:Added job|Job)\s+([A-Za-z0-9_-]+)\b/);
	return m?.[1] || null;
}

function jobTimestamp(job: GobListJob): number {
	const raw = job.started_at || job.created_at || "";
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? ms : 0;
}

function pickNewestNewJob(beforeIds: Set<string>, jobs: GobListJob[], hint: string): string | null {
	const candidates = jobs
		.filter((job) => !beforeIds.has(job.id))
		.sort((a, b) => jobTimestamp(b) - jobTimestamp(a));
	if (candidates.length === 0) return null;

	const hintLower = hint.toLowerCase();
	const hinted = candidates.find((job) => job.command.join(" ").toLowerCase().includes(hintLower));
	return (hinted || candidates[0])?.id || null;
}

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;

	let nextTaskId = 1;
	let tasks: BackTaskItem[] = [];

	let nextBgId = 1;
	const backgroundTasks: Map<number, BackgroundTask> = new Map();

	let showTaskFooter = true;
	let showBackgroundWidget = false;

	let gobAvailable: boolean | null = null;
	let gobWarnedMissing = false;
	let gobPollTimer: any;
	let gobPollBusy = false;

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
								const head = `${task.kind} #${task.id} ${task.status} (${elapsed})${task.gobJobId ? ` gob:${task.gobJobId}` : ""}`;
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

	/**
	 * Read the full output from gob stdout on completion (not just the polled tail).
	 * For agent tasks, also try reading the session file for the final assistant message.
	 */
	async function readFullResult(bg: BackgroundTask): Promise<string> {
		// Try reading the session file for agent tasks (contains full conversation)
		if (bg.kind === "agent" && bg.sessionFile && fs.existsSync(bg.sessionFile)) {
			try {
				const lines = fs.readFileSync(bg.sessionFile, "utf8").trim().split("\n");
				// Walk backwards to find the last assistant message
				for (let i = lines.length - 1; i >= 0; i--) {
					try {
						const event = JSON.parse(lines[i]);
						if (event.role === "assistant" && event.content) {
							const text = Array.isArray(event.content)
								? event.content
									.filter((b: any) => b.type === "text")
									.map((b: any) => b.text)
									.join("\n")
								: String(event.content);
							if (text.trim()) return text;
						}
					} catch { /* skip malformed lines */ }
				}
			} catch { /* fall through to gob stdout */ }
		}

		// Fall back to full gob stdout
		if (bg.gobJobId) {
			try {
				const result = await execCommand("gob", ["stdout", bg.gobJobId], process.cwd());
				if (result.exitCode === 0 && result.stdout.trim()) {
					return result.stdout.trim();
				}
			} catch { /* fall through to tail */ }
		}

		// Last resort: use the polled tail
		return bg.outputTail.join("\n");
	}

	async function completeBackgroundTask(ctx: ExtensionContext, bg: BackgroundTask, status: BackgroundStatus, exitCode: number | null = null) {
		bg.status = status;
		bg.endedAt = Date.now();
		bg.exitCode = exitCode;
		refreshAll(ctx);

		const elapsed = formatDuration(bg.endedAt - bg.startedAt);
		const headline =
			status === "completed"
				? `✓ ${bg.kind} #${bg.id} completed (${elapsed})`
				: status === "killed"
					? `■ ${bg.kind} #${bg.id} killed (${elapsed})`
					: `✗ ${bg.kind} #${bg.id} failed (${elapsed})`;
		ctx.ui.notify(headline, status === "completed" ? "success" : status === "killed" ? "warning" : "error");

		// Read full result (not just tail) for the LLM
		const fullResult = await readFullResult(bg);
		const content = fullResult.trim()
			? `[${headline}]\nTask: ${bg.title}\n\n${fullResult.slice(-12000)}`
			: `[${headline}]\nTask: ${bg.title}\n\n(no output)`;

		// Check if this task was spawned via the subagents RPC protocol
		const subagentId = findSubagentId(bg.id);
		if (subagentId) {
			// Emit lifecycle events for pi-tasks; it handles its own result routing
			emitSubagentLifecycleEvent(bg, subagentId, fullResult);
		} else {
			// Normal pi-backtask flow: inject result into parent conversation
			pi.sendMessage(
				{
					customType: "backtask-result",
					content,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true }
			);
		}
	}

	async function ensureGobInstalled(ctx: ExtensionContext): Promise<boolean> {
		if (gobAvailable === true) return true;
		if (gobAvailable === false) {
			if (!gobWarnedMissing) {
				ctx.ui.notify("gob CLI not found. Install: brew tap juanibiapina/taps && brew install gob", "error");
				gobWarnedMissing = true;
			}
			return false;
		}

		const probe = await execCommand("gob", ["--version"], process.cwd());
		gobAvailable = probe.exitCode === 0;
		if (!gobAvailable && !gobWarnedMissing) {
			ctx.ui.notify("gob CLI not found. Install: brew tap juanibiapina/taps && brew install gob", "error");
			gobWarnedMissing = true;
		}
		return gobAvailable;
	}

	async function gobListJobs(): Promise<GobListJob[]> {
		const result = await execCommand("gob", ["list", "--json"], process.cwd());
		if (result.exitCode !== 0) {
			throw new Error(result.stderr.trim() || result.stdout.trim() || "gob list failed");
		}
		const parsed = JSON.parse(result.stdout || "[]");
		if (!Array.isArray(parsed)) {
			throw new Error("gob list --json returned non-array output");
		}
		return parsed as GobListJob[];
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

	async function syncBgTailFromGob(bg: BackgroundTask, ctx?: ExtensionContext) {
		if (!bg.gobJobId) return;
		if (Date.now() - (bg.lastTailReadAt || 0) < 3000) return;
		bg.lastTailReadAt = Date.now();

		const result = await execCommand("gob", ["stdout", bg.gobJobId], process.cwd());
		if (result.exitCode !== 0) return;

		const fullOutput = result.stdout;
		const lines = fullOutput
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const lastLine = lines[lines.length - 1];
		if (!lastLine) return;
		if (bg.lastTailLine === lastLine) return;
		bg.lastTailLine = lastLine;
		appendTail(bg, lastLine);

		// Reactive output: check for new output that matches pattern
		if (bg.reactToOutput && ctx && bg.status === "running") {
			const prevLength = bg.lastAlertedLength || 0;
			if (fullOutput.length > prevLength) {
				const newOutput = fullOutput.slice(prevLength);
				const shouldNotify = bg.notifyMatcher
					? bg.notifyMatcher.test(newOutput)
					: newOutput.trim().length > 0;

				if (shouldNotify) {
					// Debounce: wait 2s for more output to accumulate
					if (bg.outputReactTimer) clearTimeout(bg.outputReactTimer);
					bg.outputReactTimer = setTimeout(() => {
						bg.outputReactTimer = null;
						const alertOutput = fullOutput.slice(bg.lastAlertedLength || 0);
						bg.lastAlertedLength = fullOutput.length;
						const patternNote = bg.notifyPattern ? ` (matched: ${bg.notifyPattern})` : "";
						pi.sendMessage(
							{
								customType: "backtask-output",
								content: `[${bg.kind} #${bg.id} new output${patternNote}]\nCommand: ${bg.title}\n\n${alertOutput.slice(-4000)}`,
								display: true,
							},
							{ triggerTurn: true }
						);
					}, 2000);
				}
				// Update alerted length even if debounced (prevents duplicate alerts)
				bg.lastAlertedLength = fullOutput.length;
			}
		}
	}

	function stopGobPollingIfIdle() {
		const stillRunning = Array.from(backgroundTasks.values()).some((bg) => bg.status === "running" && !!bg.gobJobId);
		if (!stillRunning && gobPollTimer) {
			clearInterval(gobPollTimer);
			gobPollTimer = undefined;
		}
	}

	async function pollGobBackgroundTasks(ctx: ExtensionContext) {
		if (gobPollBusy) return;
		const running = Array.from(backgroundTasks.values()).filter((bg) => bg.status === "running" && !!bg.gobJobId);
		if (running.length === 0) {
			stopGobPollingIfIdle();
			return;
		}

		gobPollBusy = true;
		try {
			const jobs = await gobListJobs();
			const byId = new Map(jobs.map((job) => [job.id, job]));

			for (const bg of running) {
				const job = byId.get(bg.gobJobId!);
				if (!job) {
					appendTail(bg, `gob job ${bg.gobJobId} not found`);
					await completeBackgroundTask(ctx, bg, bg.status === "killed" ? "killed" : "failed", bg.exitCode ?? null);
					continue;
				}

				await syncBgTailFromGob(bg, ctx);

				if (job.status !== "running") {
					const exitCode = typeof job.exit_code === "number" ? job.exit_code : null;
					const status = bg.status === "killed" ? "killed" : exitCode === 0 ? "completed" : "failed";
					await completeBackgroundTask(ctx, bg, status, exitCode);
				}
			}

			refreshBackgroundWidget(ctx);
		} catch (err: any) {
			ctx.ui.notify(`gob sync failed: ${String(err?.message || err)}`, "error");
		} finally {
			gobPollBusy = false;
			stopGobPollingIfIdle();
		}
	}

	function ensureGobPolling(ctx: ExtensionContext) {
		if (gobPollTimer) return;
		gobPollTimer = setInterval(() => {
			if (!ctxRef) return;
			void pollGobBackgroundTasks(ctxRef);
		}, 2000);
		void pollGobBackgroundTasks(ctx);
	}

	async function spawnGobBackground(
		ctx: ExtensionContext,
		kind: BackgroundKind,
		title: string,
		description: string,
		command: string,
		args: string[],
		sessionFile?: string
	): Promise<BackgroundTask | null> {
		const id = nextBgId++;
		const bg: BackgroundTask = {
			id,
			kind,
			title,
			status: "running",
			startedAt: Date.now(),
			outputTail: [],
			sessionFile,
		};
		backgroundTasks.set(id, bg);
		refreshAll(ctx);

		if (!(await ensureGobInstalled(ctx))) {
			appendTail(bg, "gob CLI missing; cannot start background task");
			await completeBackgroundTask(ctx, bg, "failed", null);
			return null;
		}

		let beforeIds = new Set<string>();
		try {
			const before = await gobListJobs();
			beforeIds = new Set(before.map((job) => job.id));
		} catch {
			// best-effort: fallback to output parsing
		}

		const addArgs = ["add", "--description", description, "--", command, ...args];
		const addResult = await execCommand("gob", addArgs, process.cwd());
		if (addResult.exitCode !== 0) {
			appendTail(bg, addResult.stderr || addResult.stdout || "gob add failed");
			await completeBackgroundTask(ctx, bg, "failed", addResult.exitCode);
			return bg;
		}

		const output = `${addResult.stdout}\n${addResult.stderr}`;
		let jobId = extractGobJobId(output);

		if (!jobId) {
			try {
				const after = await gobListJobs();
				jobId = pickNewestNewJob(beforeIds, after, `${command} ${args.join(" ")}`);
			} catch {
				// ignore fallback failure
			}
		}

		if (!jobId) {
			appendTail(bg, output || "unable to determine gob job id");
			await completeBackgroundTask(ctx, bg, "failed", null);
			return bg;
		}

		bg.gobJobId = jobId;
		appendTail(bg, `gob job ${jobId} started`);
		refreshAll(ctx);
		ensureGobPolling(ctx);
		return bg;
	}

	function makeAgentSessionFile(id: number): string {
		const dir = path.join(os.homedir(), ".pi", "agent", "sessions", "pi-backtask");
		fs.mkdirSync(dir, { recursive: true });
		return path.join(dir, `agent-${id}-${Date.now()}.jsonl`);
	}

	/**
	 * Parse a notify pattern string into a RegExp or null.
	 * Supports: plain substring, or /regex/flags format.
	 */
	function parseNotifyPattern(pattern: string): RegExp | null {
		if (!pattern) return null;
		const regexMatch = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
		if (regexMatch) {
			try {
				return new RegExp(regexMatch[1], regexMatch[2]);
			} catch {
				return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
			}
		}
		// Plain substring → case-insensitive match
		return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
	}

	/**
	 * Parse /bg run options. Supports:
	 *   /bg run <command>
	 *   /bg run --watch <command>              (notify on any new output)
	 *   /bg run --watch --pattern <p> <command> (notify only on matching output)
	 */
	function parseBgRunArgs(raw: string): { command: string; watch: boolean; pattern?: string } {
		const tokens = raw.split(/\s+/);
		let watch = false;
		let pattern: string | undefined;
		const rest: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "--watch") { watch = true; continue; }
			if (t === "--pattern" && i + 1 < tokens.length) { pattern = tokens[++i]; watch = true; continue; }
			rest.push(t);
		}
		return { command: rest.join(" "), watch, pattern };
	}

	async function spawnShellBackground(ctx: ExtensionContext, command: string, watch = false, pattern?: string) {
		const description = `pi-backtask shell: ${command.slice(0, 120)}`;
		const bg = await spawnGobBackground(ctx, "shell", command, description, "bash", ["-lc", command]);
		if (bg && watch) {
			bg.reactToOutput = true;
			bg.notifyPattern = pattern;
			bg.notifyMatcher = pattern ? parseNotifyPattern(pattern) : null;
			bg.lastAlertedLength = 0;
		}
		return bg;
	}

	/**
	 * Parse /bg agent options. Supports:
	 *   /bg agent <prompt>
	 *   /bg agent --rw <prompt>           (adds write+edit tools)
	 *   /bg agent --model <model> <prompt>
	 *   /bg agent --think <prompt>        (enables thinking)
	 *   /bg agent --full <prompt>         (all tools + extensions + thinking)
	 */
	function parseBgAgentArgs(raw: string): { prompt: string; rw: boolean; model?: string; think: boolean; full: boolean } {
		const tokens = raw.split(/\s+/);
		let rw = false;
		let think = false;
		let full = false;
		let model: string | undefined;
		const rest: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t === "--rw") { rw = true; continue; }
			if (t === "--think") { think = true; continue; }
			if (t === "--full") { full = true; continue; }
			if (t === "--model" && i + 1 < tokens.length) { model = tokens[++i]; continue; }
			rest.push(t);
		}
		return { prompt: rest.join(" "), rw, model, think, full };
	}

	async function spawnAgentBackground(ctx: ExtensionContext, rawArgs: string) {
		const { prompt, rw, model: modelOverride, think, full } = parseBgAgentArgs(rawArgs);
		if (!prompt.trim()) return null;

		const localId = nextBgId;
		const sessionFile = makeAgentSessionFile(localId);
		const model = modelOverride || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview");
		const description = `pi-backtask agent: ${prompt.slice(0, 120)}`;

		const tools = full
			? "read,bash,grep,find,ls,edit,write"
			: rw
				? "read,bash,grep,find,ls,edit,write"
				: "read,bash,grep,find,ls";

		const piArgs = [
			"--mode", "json",
			"-p",
			"--session", sessionFile,
			"--model", model,
			"--tools", tools,
		];

		if (!full) {
			piArgs.push("--no-extensions");
		}

		if (think || full) {
			piArgs.push("--thinking", "high");
		} else {
			piArgs.push("--thinking", "off");
		}

		piArgs.push(prompt);

		return spawnGobBackground(
			ctx,
			"agent",
			prompt,
			description,
			"pi",
			piArgs,
			sessionFile
		);
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
					ctx.ui.notify("Usage: /bg run [--watch] [--pattern <p>] <bash command>", "error");
					return;
				}
				const { command, watch, pattern } = parseBgRunArgs(payload);
				if (!command.trim()) {
					ctx.ui.notify("Usage: /bg run [--watch] [--pattern <p>] <bash command>", "error");
					return;
				}
				const bg = await spawnShellBackground(ctx, command, watch, pattern);
				if (!bg) return;
				const watchNote = watch ? ` [watching${pattern ? `: ${pattern}` : ""}]` : "";
				ctx.ui.notify(`Started shell #${bg.id}${bg.gobJobId ? ` (gob:${bg.gobJobId})` : ""}${watchNote}`, "info");
				return;
			}

			if (action === "agent") {
				if (!payload) {
					ctx.ui.notify("Usage: /bg agent [--rw] [--think] [--full] [--model <m>] <prompt>", "error");
					return;
				}
				const bg = await spawnAgentBackground(ctx, payload);
				if (!bg) {
					ctx.ui.notify("Failed to start agent (empty prompt?)", "error");
					return;
				}
				ctx.ui.notify(`Started agent #${bg.id}${bg.gobJobId ? ` (gob:${bg.gobJobId})` : ""}`, "info");
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
				if (bg.status !== "running") {
					ctx.ui.notify(`Background task #${id} is not running.`, "warning");
					return;
				}
				if (!bg.gobJobId) {
					ctx.ui.notify(`Background task #${id} has no gob job id.`, "error");
					return;
				}
				const stopResult = await execCommand("gob", ["stop", bg.gobJobId], process.cwd());
				if (stopResult.exitCode !== 0) {
					appendTail(bg, stopResult.stderr || stopResult.stdout || `failed to stop gob job ${bg.gobJobId}`);
					refreshAll(ctx);
					ctx.ui.notify(`Failed to stop gob:${bg.gobJobId}`, "error");
					return;
				}
				appendTail(bg, stopResult.stdout || `stopped gob job ${bg.gobJobId}`);
				await completeBackgroundTask(ctx, bg, "killed", null);
				stopGobPollingIfIdle();
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
						const gobRef = bg.gobJobId ? ` gob:${bg.gobJobId}` : "";
						return `#${bg.id} [${bg.kind}] ${bg.status} ${elapsed}${gobRef} - ${bg.title}`;
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

	// ─── bg_process tool (LLM-callable, policy-gated) ───────────────────────
	const settings = loadBacktaskSettings();

	if (settings.tool && Type) {
		const BgProcessParams = Type.Object({
			action: Type.Union([
				Type.Literal("run"),
				Type.Literal("list"),
				Type.Literal("kill"),
			], { description: "Action to perform" }),
			command: Type.Optional(Type.String({ description: "Shell command to run in background (for action=run)" })),
			watch: Type.Optional(Type.Boolean({ description: "Enable reactive output notifications (default: false)" })),
			pattern: Type.Optional(Type.String({ description: "Only notify on output matching this pattern (substring or /regex/flags). Implies watch=true" })),
			id: Type.Optional(Type.Number({ description: "Background task ID (for action=kill)" })),
		});

		pi.registerTool({
			name: "bg_process",
			label: "Background Process",
			description: `Run and manage background shell processes. Actions:
- run: Start a command in the background (requires 'command'). Optional: watch (notify on output), pattern (filter notifications).
- list: Show all background tasks with status.
- kill: Stop a running background task (requires 'id').

Note: This tool is for shell commands only, not for spawning agents. Results are automatically delivered when processes complete.
Use watch+pattern for test runners, dev servers, and builds where you want to react to specific output.`,
			promptSnippet: "Run shell commands in background without blocking conversation",
			promptGuidelines: [
				"Use bg_process for long-running shell commands: dev servers, test watchers, builds, log tails.",
				"Do NOT use bg_process to spawn agents or delegate tasks — only shell commands.",
				"After starting a process, continue other work. You'll be notified on completion or matching output.",
				"Use watch=true with pattern for reactive monitoring (e.g., pattern='FAIL' for test watchers).",
				"Prefer bg_process over bash with & or nohup for long-running processes.",
			],
			parameters: BgProcessParams,

			async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: ExtensionContext) {
				ctxRef = ctx;

				if (params.action === "list") {
					const rows = Array.from(backgroundTasks.values())
						.sort((a, b) => b.id - a.id)
						.map((bg) => {
							const elapsed = formatDuration((bg.endedAt || Date.now()) - bg.startedAt);
							const gobRef = bg.gobJobId ? ` gob:${bg.gobJobId}` : "";
							return `#${bg.id} [${bg.kind}] ${bg.status} ${elapsed}${gobRef} - ${bg.title}`;
						});
					return {
						content: [{ type: "text", text: rows.length > 0 ? rows.join("\n") : "No background tasks." }],
						details: {},
					};
				}

				if (params.action === "kill") {
					const policy = settings.policy.kill;
					if (policy === "deny") {
						return { content: [{ type: "text", text: "Denied: kill action is not allowed by policy." }], details: {} };
					}
					const id = params.id;
					if (!id) {
						return { content: [{ type: "text", text: "Error: 'id' is required for kill action." }], details: {} };
					}
					const bg = backgroundTasks.get(id);
					if (!bg) {
						return { content: [{ type: "text", text: `Error: Background task #${id} not found.` }], details: {} };
					}
					if (bg.status !== "running") {
						return { content: [{ type: "text", text: `Task #${id} is not running (status: ${bg.status}).` }], details: {} };
					}
					if (!bg.gobJobId) {
						return { content: [{ type: "text", text: `Task #${id} has no gob job id.` }], details: {} };
					}
					const stopResult = await execCommand("gob", ["stop", bg.gobJobId], process.cwd());
					if (stopResult.exitCode !== 0) {
						return { content: [{ type: "text", text: `Failed to stop task #${id}: ${stopResult.stderr || stopResult.stdout}` }], details: {} };
					}
					appendTail(bg, `stopped gob job ${bg.gobJobId}`);
					await completeBackgroundTask(ctx, bg, "killed", null);
					return { content: [{ type: "text", text: `Killed task #${id} (gob:${bg.gobJobId}).` }], details: {} };
				}

				if (params.action === "run") {
					const command = params.command?.trim();
					if (!command) {
						return { content: [{ type: "text", text: "Error: 'command' is required for run action." }], details: {} };
					}

					const watch = params.watch || !!params.pattern;
					const pattern = params.pattern;

					// Determine policy
					const policy = watch ? settings.policy.shellWatch : settings.policy.shell;
					if (policy === "deny") {
						const reason = watch ? "shell commands with --watch" : "shell commands";
						return { content: [{ type: "text", text: `Denied: ${reason} not allowed by policy. Ask the user to run via /bg run.` }], details: {} };
					}
					if (policy === "confirm") {
						// Hard gate: tell the LLM it must get user approval first
						ctx.ui.notify(`bg_process wants to run: ${command.slice(0, 80)}`, "warning");
						return {
							content: [{ type: "text", text: `Confirmation required: ask the user to approve running this command in background:\n\n  ${command}${watch ? `\n  (with reactive output${pattern ? `: ${pattern}` : ""})` : ""}\n\nIf approved, the user can run: /bg run ${watch ? "--watch " : ""}${pattern ? `--pattern "${pattern}" ` : ""}"${command}"` }],
							details: {},
						};
					}

					const bg = await spawnShellBackground(ctx, command, watch, pattern);
					if (!bg) {
						return { content: [{ type: "text", text: "Failed to start background task. Is gob installed?" }], details: {} };
					}
					const watchNote = watch ? ` [watching${pattern ? `: ${pattern}` : ""}]` : "";
					return {
						content: [{ type: "text", text: `Started shell #${bg.id}${bg.gobJobId ? ` (gob:${bg.gobJobId})` : ""}${watchNote}\nCommand: ${command}` }],
						details: {},
					};
				}

				return { content: [{ type: "text", text: "Unknown action. Use: run, list, or kill." }], details: {} };
			},
		});
	}

	// ─── Block bash background patterns (optional, when tool is enabled) ────
	if (settings.tool && settings.policy.shell !== "deny") {
		pi.on("tool_call", async (event, ctx) => {
			if (event.toolName !== "bash") return;
			const command = String((event as any).input?.command ?? "");
			// Detect common background patterns
			if (/&\s*$/.test(command) || /\b(nohup|disown|setsid)\b/.test(command)) {
				return {
					block: true,
					reason: "Background shell patterns (&, nohup, disown, setsid) are not supported. " +
						'Use the bg_process tool with action "run" to run commands in the background. ' +
						'Example: bg_process({ action: "run", command: "npm run dev", watch: true })',
				};
			}
			return undefined;
		});
	}

	// ─── @tintinweb/pi-subagents RPC compatibility layer ────────────────────
	// Implements the pi-subagents event protocol so @tintinweb/pi-tasks'
	// TaskExecute can spawn agents via pi-backtask's gob backend.
	const SUBAGENTS_PROTOCOL_VERSION = 2;

	/** Maps subagent IDs to background task IDs for completion routing. */
	const subagentBgMap = new Map<string, number>();

	// Handle ping requests from pi-tasks
	pi.events.on("subagents:rpc:ping", (data: any) => {
		const requestId = data?.requestId;
		if (!requestId) return;
		pi.events.emit(`subagents:rpc:ping:reply:${requestId}`, {
			success: true,
			data: { version: SUBAGENTS_PROTOCOL_VERSION },
		});
	});

	// Handle spawn requests from pi-tasks
	pi.events.on("subagents:rpc:spawn", async (data: any) => {
		const { requestId, type, prompt, options } = data || {};
		if (!requestId) return;

		if (!prompt?.trim()) {
			pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
				success: false,
				error: "Empty prompt",
			});
			return;
		}

		if (!ctxRef) {
			pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
				success: false,
				error: "No active session context",
			});
			return;
		}

		// Map pi-tasks agent types to capability flags
		const isRw = type === "code" || type === "edit" || options?.tools?.includes("edit");
		const isFull = type === "full";
		const think = options?.thinking || false;
		const model = options?.model;

		// Enforce policy
		const policyKey = isFull ? "agentFull" : isRw ? "agentRw" : "agent";
		const policy = settings.policy[policyKey];
		if (policy === "deny") {
			pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
				success: false,
				error: `Denied by policy: ${policyKey} is set to deny`,
			});
			return;
		}
		if (policy === "confirm" && ctxRef) {
			ctxRef.ui.notify(`pi-tasks spawn (${policyKey}): ${prompt.slice(0, 80)}`, "warning");
		}

		// Spawn directly rather than going through parseBgAgentArgs
		// (avoids prompt-as-flags injection if prompt text contains "--rw" etc.)
		const localId = nextBgId;
		const sessionFile = makeAgentSessionFile(localId);
		const resolvedModel = model || (ctxRef.model ? `${ctxRef.model.provider}/${ctxRef.model.id}` : "openrouter/google/gemini-3-flash-preview");
		const description = `pi-backtask agent (via pi-tasks): ${prompt.slice(0, 120)}`;

		const tools = isFull || isRw
			? "read,bash,grep,find,ls,edit,write"
			: "read,bash,grep,find,ls";

		const piArgs = [
			"--mode", "json",
			"-p",
			"--session", sessionFile,
			"--model", resolvedModel,
			"--tools", tools,
		];

		if (!isFull) {
			piArgs.push("--no-extensions");
		}

		if (think || isFull) {
			piArgs.push("--thinking", "high");
		} else {
			piArgs.push("--thinking", "off");
		}

		piArgs.push(prompt);

		const bg = await spawnGobBackground(
			ctxRef,
			"agent",
			prompt,
			description,
			"pi",
			piArgs,
			sessionFile
		);

		if (!bg) {
			pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
				success: false,
				error: "Failed to spawn background agent",
			});
			return;
		}

		// Use a stable agent ID that pi-tasks can track
		const agentId = `backtask-agent-${bg.id}`;
		subagentBgMap.set(agentId, bg.id);

		pi.events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
			success: true,
			data: { id: agentId },
		});
	});

	// Handle stop requests from pi-tasks
	pi.events.on("subagents:rpc:stop", async (data: any) => {
		const { requestId, agentId } = data || {};
		if (!requestId) return;

		const bgId = subagentBgMap.get(agentId);
		const bg = bgId != null ? backgroundTasks.get(bgId) : undefined;

		if (!bg || bg.status !== "running" || !bg.gobJobId) {
			pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
				success: false,
				error: `Agent ${agentId} not found or not running`,
			});
			return;
		}

		const stopResult = await execCommand("gob", ["stop", bg.gobJobId], process.cwd());
		if (stopResult.exitCode !== 0) {
			pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
				success: false,
				error: stopResult.stderr || "Failed to stop gob job",
			});
			return;
		}

		pi.events.emit(`subagents:rpc:stop:reply:${requestId}`, {
			success: true,
			data: {},
		});
	});

	/**
	 * Emit subagent lifecycle events so pi-tasks can track task completion
	 * and cascade dependencies.
	 */
	function findSubagentId(bgId: number): string | undefined {
		for (const [agentId, mappedBgId] of subagentBgMap.entries()) {
			if (mappedBgId === bgId) return agentId;
		}
		return undefined;
	}

	function emitSubagentLifecycleEvent(bg: BackgroundTask, agentId: string, fullResult: string) {
		if (bg.status === "completed") {
			pi.events.emit("subagents:completed", { id: agentId, result: fullResult.slice(-12000) });
		} else if (bg.status === "killed") {
			pi.events.emit("subagents:failed", {
				id: agentId,
				error: "Agent stopped",
				result: fullResult.slice(-12000),
				status: "stopped",
			});
		} else if (bg.status === "failed") {
			const error = bg.outputTail[bg.outputTail.length - 1] || "Agent failed";
			pi.events.emit("subagents:failed", { id: agentId, error });
		}

		subagentBgMap.delete(agentId);
	}

	// Announce readiness so pi-tasks can discover us
	pi.events.emit("subagents:ready");

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		const state = readState();
		nextTaskId = state.nextTaskId;
		tasks = state.tasks;
		refreshAll(ctx);
		void ensureGobInstalled(ctx);
		// Re-announce after session starts in case pi-tasks loaded first
		pi.events.emit("subagents:ready");
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
		if (gobPollTimer) {
			clearInterval(gobPollTimer);
			gobPollTimer = undefined;
		}
		if (!ctxRef) return;
		ctxRef.ui.setWidget("pi-backtask-bg", undefined);
	});
}
