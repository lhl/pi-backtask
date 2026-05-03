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

		pi.sendMessage(
			{
				customType: "backtask-result",
				content,
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true }
		);
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

	async function syncBgTailFromGob(bg: BackgroundTask) {
		if (!bg.gobJobId) return;
		if (Date.now() - (bg.lastTailReadAt || 0) < 5000) return;
		bg.lastTailReadAt = Date.now();

		const result = await execCommand("gob", ["stdout", bg.gobJobId], process.cwd());
		if (result.exitCode !== 0) return;
		const lines = result.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		const lastLine = lines[lines.length - 1];
		if (!lastLine) return;
		if (bg.lastTailLine === lastLine) return;
		bg.lastTailLine = lastLine;
		appendTail(bg, lastLine);
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

				await syncBgTailFromGob(bg);

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

	async function spawnShellBackground(ctx: ExtensionContext, command: string) {
		const description = `pi-backtask shell: ${command.slice(0, 120)}`;
		return spawnGobBackground(ctx, "shell", command, description, "bash", ["-lc", command]);
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
					ctx.ui.notify("Usage: /bg run <bash command>", "error");
					return;
				}
				const bg = await spawnShellBackground(ctx, payload);
				if (!bg) return;
				ctx.ui.notify(`Started shell #${bg.id}${bg.gobJobId ? ` (gob:${bg.gobJobId})` : ""}`, "info");
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

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		const state = readState();
		nextTaskId = state.nextTaskId;
		tasks = state.tasks;
		refreshAll(ctx);
		void ensureGobInstalled(ctx);
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
