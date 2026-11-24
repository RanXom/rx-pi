/**
 * session-rename — `/rename` with context-derived names.
 *
 * `/rename <name>` sets the session display name.
 * `/rename` with no argument derives one from the conversation so far.
 * Sessions that are still unnamed also get a derived name after their first
 * completed turn, once.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STOP_WORDS = new Set([
	"the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
	"is", "are", "was", "were", "be", "been", "it", "this", "that", "these",
	"those", "i", "you", "we", "they", "he", "she", "my", "your", "our", "their",
	"please", "can", "could", "would", "should", "do", "does", "did", "run",
	"make", "let", "just", "then", "than", "so", "if", "as", "at", "by", "from",
	"hey", "hi", "ok", "okay", "thanks", "thank", "say", "tell", "reply",
	"think", "something", "anything", "look", "check", "want", "need", "help",
	"using", "use", "again", "also", "give", "show", "find", "get",
]);

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
		.join(" ");
}

function deriveName(ctx: ExtensionContext): string | undefined {
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getEntries() as unknown[];
	} catch {
		return undefined;
	}
	const messages: string[] = [];
	for (const entry of entries) {
		const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (record.type !== "message" || record.message?.role !== "user") continue;
		const text = textOf(record.message.content).replace(/```[\s\S]*?```/g, " ");
		if (text.trim()) messages.push(text);
	}
	if (messages.length === 0) return undefined;
	// Prefer the opening request; it usually names the task.
	const words = [messages[0]!, ...messages.slice(-2)]
		.join(" ")
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
	const seen = new Set<string>();
	const picked: string[] = [];
	for (const word of words) {
		if (seen.has(word)) continue;
		seen.add(word);
		picked.push(word);
		if (picked.length === 4) break;
	}
	if (picked.length === 0) {
		// Everything was filler ("hi", "say ok"): keep the first few words anyway.
		const fallback = messages[0]!
			.replace(/[^a-zA-Z0-9\s-]/g, " ")
			.trim()
			.split(/\s+/)
			.slice(0, 3)
			.join(" ");
		return fallback ? fallback.replace(/^./, (char) => char.toUpperCase()) : undefined;
	}
	return picked.join(" ").replace(/^./, (char) => char.toUpperCase());
}

export default function sessionRename(pi: ExtensionAPI): void {
	let autoTried = false;

	const apply = (name: string, ctx: ExtensionContext): boolean => {
		try {
			pi.setSessionName(name);
			ctx.ui.notify(`Session renamed: ${name}`, "info");
			return true;
		} catch {
			return false;
		}
	};

	pi.registerCommand("rename", {
		description: "Rename the session; leave blank to derive a name from context",
		handler: async (args, ctx) => {
			const explicit = args.trim();
			const name = explicit || deriveName(ctx);
			if (!name) {
				try {
					const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
					require("node:fs").writeFileSync("/tmp/rename-debug.json", JSON.stringify(entries.map((e) => ({ type: e.type, role: e.message?.role })), null, 1));
				} catch (error) {
					require("node:fs").writeFileSync("/tmp/rename-debug.json", String(error));
				}
				ctx.ui.notify("Nothing to name the session from yet.", "warning");
				return;
			}
			apply(name, ctx);
		},
	});

	pi.on("agent_end", (_event, ctx) => {
		if (autoTried) return;
		autoTried = true;
		try {
			if (pi.getSessionName()) return;
		} catch {
			return;
		}
		const name = deriveName(ctx);
		if (name) apply(name, ctx);
	});

	pi.on("session_start", () => {
		autoTried = false;
	});
}
