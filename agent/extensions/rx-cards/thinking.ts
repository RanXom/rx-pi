/**
 * thinking.ts — one line per reasoning block.
 *
 * Collapsed:  + Thought · 12s   (pi's hidden-thinking label, repainted)
 * Streaming:  ⠋ Thinking
 * Expanded:   *− Thought · 12s* prepended to the reasoning markdown itself,
 *             so the header always sits directly above the content and pi
 *             owns all spacing/indentation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 90;

interface ThinkingComponent {
	children: unknown[];
	outputPad?: unknown;
	hideThinkingBlock?: boolean;
	render(width: number): string[];
	setHiddenThinkingLabel(label: string): void;
	setHideThinkingBlock(hide: boolean): void;
	updateContent(message: unknown, streaming?: boolean): void;
}

interface Record_ {
	phase: "idle" | "streaming" | "settled";
	startedAt: number;
	endedAt: number;
	text: string;
}

const records = new WeakMap<object, Record_>();
const wrapped: Array<{ component: ThinkingComponent; original: ThinkingComponent["render"] }> = [];
const durations = new Map<string, number>();

let tui: TUI | undefined;
let theme: { fg(token: string, text: string): string; italic(text: string): string } | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let frame = 0;
let streaming = 0;

const strip = (line: string): string => stripVTControlCharacters(line);
const LABEL_LINE = /^\s*[+−-]?\s*(Thinking|Thought)(?:\.{3}|…)?(?:\s*(?:·|for)\s*\d+s)?\s*$/i;

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

function label(record: Record_): string {
	if (record.phase === "streaming") return `${SPINNER[frame % SPINNER.length]} Thinking`;
	const suffix = seconds(record) > 0 ? ` · ${seconds(record)}s` : "";
	return `+ Thought${suffix}`;
}

function patch(component: ThinkingComponent): void {
	if (records.has(component)) return;
	records.set(component, { phase: "settled", startedAt: 0, endedAt: 0, text: "" });
	const original = component.render;
	const patched = function (this: ThinkingComponent, width: number): string[] {
		const state = records.get(this)!;
		this.setHiddenThinkingLabel(label(state));
		return original.call(this, width);
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
		for (const { component: other } of wrapped) {
			if (other === component) continue;
			const previous = records.get(other);
			if (previous?.phase === "streaming") {
				previous.phase = "settled";
				previous.endedAt = Date.now();
				streaming = Math.max(0, streaming - 1);
			}
		}
		const record = records.get(component)!;
		if (record.phase === "streaming") return;
		record.phase = "streaming";
		record.startedAt = Date.now();
		record.endedAt = 0;
		record.text = "";
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
			if (record.text.trim()) durations.set(record.text.trim(), seconds(record));
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
		let thinking = "";
		let text = false;
		for (const part of message.content as Array<{ type?: string; thinking?: string; text?: string }>) {
			if (part?.type === "thinking" && part.thinking) thinking = part.thinking;
			else if (part?.type === "text" && part.text) text = true;
		}
		if (thinking) {
			begin(active ?? ensurePatched());
			if (active) records.get(active)!.text = thinking;
		}
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
			return {
				render: () => {
					ensurePatched();
					return [];
				},
				invalidate: () => {},
			};
		});
	});

	pi.on("session_shutdown", () => {
		stopTimer();
		for (const { component, original } of wrapped.splice(0)) component.render = original;
		tui = undefined;
		active = undefined;
		streaming = 0;
	});

	// Expanded thinking is pi's own markdown, so inject the header there. The
	// duration is keyed by the reasoning text, which is exact.
	const host = pi as unknown as {
		registerMarkdownTransformer?: (
			transformer: (markdown: string, context: { messageType: string; isStreaming: boolean }) => string,
			options?: { messageTypes?: readonly string[] },
		) => void;
	};
	host.registerMarkdownTransformer?.(
		(markdown, context) => {
			if (context.messageType !== "assistant-thinking") return markdown;
			const known = durations.get(markdown.trim());
			const suffix = known ? ` · ${known}s` : "";
			return `*− Thought${suffix}*\n\n${markdown}`;
		},
		{ messageTypes: ["assistant-thinking"] },
	);

	// Theme is only used to keep the collapsed label's styling consistent if a
	// future host exposes the render path; referenced to avoid dead-code drift.
	void theme;
}
