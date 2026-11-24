/**
 * thinking.ts — one line per reasoning block.
 *
 * While the model reasons: an animated spinner and `Thinking`.
 * Collapsed:  + Thought · 12s
 * Expanded:   − Thought · 12s, then pi's reasoning rows.
 *
 * Every hidden-thinking component in the transcript is patched, not just the
 * latest, and expansion is detected from rendered non-empty rows (pi renders
 * one label row while collapsed).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 90;

interface ThinkingComponent {
	children: unknown[];
	outputPad?: unknown;
	render(width: number): string[];
	setHiddenThinkingLabel(label: string): void;
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: unknown, streaming?: boolean): void;
}

interface Record_ {
	phase: "idle" | "streaming" | "settled";
	startedAt: number;
	endedAt: number;
}

const records = new WeakMap<object, Record_>();
const wrapped: Array<{ component: ThinkingComponent; original: ThinkingComponent["render"] }> = [];
let tui: TUI | undefined;
let theme: { fg(token: string, text: string): string; italic(text: string): string } | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let frame = 0;
let streaming = 0;

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function isThinking(value: object): value is ThinkingComponent {
	const component = value as unknown as Record<string, unknown>;
	return (
		Array.isArray(component.children) &&
		typeof component.render === "function" &&
		typeof component.setHiddenThinkingLabel === "function" &&
		typeof component.setHideThinkingBlock === "function" &&
		typeof component.updateContent === "function"
	);
}

function collect(root: unknown): ThinkingComponent[] {
	const found: ThinkingComponent[] = [];
	const pending: unknown[] = [root];
	const seen = new Set<object>();
	while (pending.length > 0) {
		const value = pending.pop();
		if (!value || typeof value !== "object" || seen.has(value)) continue;
		seen.add(value);
		if (isThinking(value)) found.push(value);
		const children = (value as { children?: unknown }).children;
		if (!Array.isArray(children)) continue;
		for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
	}
	return found;
}

function seconds(record: Record_): number {
	if (!record.startedAt) return 0;
	const end = record.endedAt || Date.now();
	return Math.max(1, Math.round((end - record.startedAt) / 1000));
}

function label(record: Record_, expanded: boolean): string {
	if (record.phase === "streaming") return `${SPINNER[frame % SPINNER.length]} Thinking`;
	const suffix = seconds(record) > 0 ? ` · ${seconds(record)}s` : "";
	return `${expanded ? "−" : "+"} Thought${suffix}`;
}

/** Expanded header keeps the collapsed label's color and italics. */
function styledLabel(record: Record_, expanded: boolean): string {
	const text = label(record, expanded);
	if (theme) return theme.italic(theme.fg("thinkingText", text));
	return `\x1b[3m${text}\x1b[0m`;
}

const LABEL_LINE = /^\s*[+−-]?\s*(Thinking|Thought)(\s*·\s*\d+s)?\s*$/;

function patch(component: ThinkingComponent): void {
	if (records.has(component)) return;
	const record: Record_ = { phase: "settled", startedAt: Date.now(), endedAt: Date.now() };
	records.set(component, record);
	const original = component.render;
	const patched = function (this: ThinkingComponent, width: number): string[] {
		const state = records.get(this)!;
		this.setHiddenThinkingLabel(label(state, false));
		const raw = original.call(this, width);
		// Expanded renders include the reasoning rows plus a native label row;
		// collapsed renders are label/blank rows only.
		const content = raw.filter((line) => !LABEL_LINE.test(strip(line)));
		const hasContent = content.some((line) => strip(line).trim().length > 0);
		if (!hasContent) return raw;
		// Pi drops the spacer row when the block expands; put it back so the
		// header keeps its position and spacing.
		const leading = content.length > 0 && strip(content[0] ?? "").trim() === "" ? [] : [""];
		return [...leading, styledLabel(state, true), ...content];
	};
	component.render = patched as ThinkingComponent["render"];
	wrapped.push({ component, original });
}

function ensurePatched(): ThinkingComponent | undefined {
	if (!tui) return undefined;
	const found = collect(tui);
	for (const component of found) patch(component);
	return found.at(-1);
}

function startTimer(): void {
	if (timer) return;
	timer = setInterval(() => {
		frame++;
		tui?.requestRender();
	}, TICK_MS);
	timer.unref?.();
}

function stopTimer(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
}

export function installThinkingRow(pi: ExtensionAPI): void {
	let active: ThinkingComponent | undefined;

	const begin = (component: ThinkingComponent | undefined): void => {
		if (!component) return;
		const record = records.get(component)!;
		if (record.phase === "streaming") return;
		record.phase = "streaming";
		record.startedAt = Date.now();
		record.endedAt = 0;
		active = component;
		streaming++;
		startTimer();
	};

	const settle = (): void => {
		if (!active) return;
		const record = records.get(active);
		if (record && record.phase === "streaming") {
			record.phase = "settled";
			record.endedAt = Date.now();
			streaming = Math.max(0, streaming - 1);
		}
		active = undefined;
		if (streaming === 0) stopTimer();
		tui?.requestRender();
	};

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		theme = (ctx as { ui: { theme: typeof theme } }).ui.theme;
		const message = (event as { message?: { role?: string } }).message;
		if (message?.role === "assistant") active = undefined;
	});

	pi.on("message_update", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const message = (event as { message?: { role?: string; content?: unknown } }).message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		let thinking = false;
		let text = false;
		for (const part of message.content as Array<{ type?: string; thinking?: string; text?: string }>) {
			if (part?.type === "thinking" && part.thinking) thinking = true;
			else if (part?.type === "text" && part.text) text = true;
		}
		if (thinking) begin(active ?? ensurePatched());
		if (text) settle();
	});

	pi.on("message_end", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		const message = (event as { message?: { role?: string } }).message;
		if (message?.role === "assistant") settle();
	});

	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		theme = (ctx as { ui: { theme: typeof theme } }).ui.theme;
		ctx.ui.setWidget("rx-cards-tui", (view: TUI) => {
			tui = view;
			ensurePatched();
			return { render: () => [], invalidate: () => {} };
		});
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		for (const { component, original } of wrapped.splice(0)) component.render = original;
		tui = undefined;
		active = undefined;
		streaming = 0;
	});
}
