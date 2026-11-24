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
	"what", "where", "when", "why", "have", "has", "had", "about", "into",
	"read", "write", "code", "dont", "building", "project", "occur", "functionality",
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

	let text = messages[0]!.toLowerCase().replace(/https?:\/\/\S+/g, " ");
	// "hyphen L" reads better as the flag it means.
	text = text.replace(/\b(hyphen|dash)\s+([a-z0-9])\b/g, "-$2");
	// "how do you, how do I add" collapses to "how add".
	text = text.replace(/\bhow\s+(?:do|does|can|could|would|should)\s+(?:you|i|we)\b/g, "how");

	const words = text.match(/-?[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
	const picked: string[] = [];
	for (const word of words) {
		const keep = word === "how" || word === "to";
		if (!keep && STOP_WORDS.has(word)) continue;
		if (picked.length > 0 && picked[picked.length - 1] === word) continue;
		picked.push(word);
		if (picked.length >= 8) break;
	}
	if (picked.length === 0) {
		const fallback = messages[0]!
			.replace(/[^a-zA-Z0-9\s-]/g, " ")
			.trim()
			.split(/\s+/)
			.slice(0, 3)
			.join(" ");
		return fallback ? fallback.replace(/^./, (char) => char.toUpperCase()) : undefined;
	}
	// A question should read "How to add -l flag", not "How add to -l flag".
	if (picked[0] === "how") {
		const rest = picked.slice(1).filter((word) => word !== "to");
		picked.splice(0, picked.length, "how", "to", ...rest);
	}
	return picked
		.slice(0, 5)
		.join(" ")
		.replace(/^./, (char) => char.toUpperCase());
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
