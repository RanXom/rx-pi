/**
 * session-rename — `/rename` with context-derived names.
 *
 * `/rename <name>` sets the display name.
 * `/rename` with no argument asks the selected model for a short title in one
 * hidden request; if that fails, a local heuristic derives one.
 * Unnamed sessions are named once after their first completed turn.
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

function conversation(ctx: ExtensionContext, limit = 6): string {
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getEntries() as unknown[];
	} catch {
		return "";
	}
	const parts: string[] = [];
	for (const entry of entries) {
		const record = entry as { type?: string; message?: { role?: string; content?: unknown } };
		if (record.type !== "message") continue;
		const role = record.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(record.message?.content).replace(/\s+/g, " ").trim();
		if (text) parts.push(`${role}: ${text.slice(0, 400)}`);
	}
	return parts.slice(-limit).join("\n");
}

/** Local fallback: first request, flags preserved, "how to" kept. */
function heuristicName(ctx: ExtensionContext): string | undefined {
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
	text = text.replace(/\b(hyphen|dash)\s+([a-z0-9])\b/g, "-$2");
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
	if (picked[0] === "how") {
		const rest = picked.slice(1).filter((word) => word !== "to");
		picked.splice(0, picked.length, "how", "to", ...rest);
	}
	return picked
		.slice(0, 5)
		.join(" ")
		.replace(/^./, (char) => char.toUpperCase());
}

/** One hidden request on the selected model: 3–6 words, title only. */
async function modelName(ctx: ExtensionContext): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const transcript = conversation(ctx);
	if (!transcript) return undefined;
	try {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("rename timeout")), 20000);
			timer.unref?.();
		});
		const response = await Promise.race([
			ctx.modelRegistry.complete(
				model,
			{
				systemPrompt:
					"You name coding sessions. Reply with ONLY a 3-6 word title, no quotes, no trailing punctuation, no explanation.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: `Conversation:\n${transcript}\n\nTitle:` }],
						timestamp: Date.now(),
					},
				],
			},
				{ maxTokens: 300, reasoningEffort: "minimal", sessionId: ctx.sessionManager.getSessionId() },
			),
			timeout,
		]);
		if (timer) clearTimeout(timer);
		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim()
			.replace(/^["'`]+|["'`.]+$/g, "")
			.trim();
		return text ? text.slice(0, 60) : undefined;
	} catch (error) {
		return undefined;
	}
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
			const model = await modelName(ctx);
			const name = explicit || model || heuristicName(ctx);
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
		void (async () => {
			const name = (await modelName(ctx)) || heuristicName(ctx);
			if (name) apply(name, ctx);
		})();
	});

	pi.on("session_start", () => {
		autoTried = false;
	});
}
