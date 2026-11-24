/**
 * Custom pi startup header.
 *
 * Left: a compact π mark drawn on a half-height grid (two grid rows per
 * terminal line, rendered with ▀ ▄ █) so it stays four lines tall instead
 * of ten.
 *
 * Right: a small info stack — cwd, the three input prefixes, agent status,
 * then version · model · git branch. The footer is hidden on this machine,
 * so the header carries that context instead.
 *
 * Wide terminals get the side-by-side layout, narrower ones stack the info
 * under the mark, very narrow ones show only the path.
 *
 * Tweak MARK_COLORS / MARK / HINTS, then run /reload in pi.
 * Restore the built-in header with /builtin-header (or delete this file).
 */

import { homedir } from "node:os";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";

// ── Mark ───────────────────────────────────────────────────────────────────

/** Theme tokens for the mark colors. "b" = crossbar, "l" = legs. */
const MARK_COLORS = { b: "text", l: "muted" } as const;

/** Mark grid: two rows per terminal line, "." leaves a cell empty. */
const MARK = [
	"bbbbbbbbbbb",
	"bbbbbbbbbbb",
	".lll...lll.",
	".ll.....ll.",
	".ll.....ll.",
	".ll.....ll.",
	".ll.....ll.",
	".ll.....ll.",
];

const MARK_WIDTH = 11;
const INDENT = " ";
const MARK_GAP = "  ";

/** Input prefixes shown under the path. */
const HINTS: [key: string, label: string][] = [
	["/", "commands"],
	["!", "bash"],
	["@", "files"],
];

// ── Rendering helpers ──────────────────────────────────────────────────────

type Styler = (text: string) => string;
type Seg = { text: string; style?: Styler };

function segWidth(line: Seg[]): number {
	return line.reduce((n, seg) => n + seg.text.length, 0);
}

/** Render a segment list, cutting it off at `max` visible columns. */
function fit(line: Seg[], max: number): string {
	let out = "";
	let room = max;
	for (const seg of line) {
		if (room <= 0) break;
		const text = seg.text.length > room ? seg.text.slice(0, room) : seg.text;
		out += seg.style ? seg.style(text) : text;
		room -= text.length;
	}
	return out;
}

/** Style runs of same-colored cells at once to keep the ANSI stream small. */
function paintRun(theme: Theme, run: { ch: string; color: string }[]): string {
	const text = run.map((cell) => cell.ch).join("");
	return theme.fg(run[0].color, text);
}

/**
 * Draw the mark. A grid column must stay one color: two colors in one column
 * would need a background fill, which not every theme token provides as `bg`.
 */
function renderMark(theme: Theme): string[] {
	const lines: string[] = [];

	for (let row = 0; row < MARK.length; row += 2) {
		const top = MARK[row] ?? "";
		const bottom = MARK[row + 1] ?? "";
		const cells: { ch: string; color: string }[] = [];

		for (let col = 0; col < MARK_WIDTH; col++) {
			const t = top[col] ?? ".";
			const b = bottom[col] ?? ".";
			const color = MARK_COLORS[(t !== "." ? t : b) as keyof typeof MARK_COLORS];
			let ch = " ";
			if (t !== "." && b !== ".") ch = "█";
			else if (t !== ".") ch = "▀";
			else if (b !== ".") ch = "▄";
			cells.push({ ch, color });
		}

		let line = "";
		let run: { ch: string; color: string }[] = [];
		for (const cell of cells) {
			if (run.length > 0 && (cell.ch === " " || cell.color !== run[0].color)) {
				line += paintRun(theme, run);
				run = [];
			}
			if (cell.ch === " ") line += " ";
			else run.push(cell);
		}
		lines.push(line + (run.length > 0 ? paintRun(theme, run) : ""));
	}

	return lines;
}

function shortenPath(path: string): string {
	const home = process.env.HOME ?? homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

type HeaderState = {
	cwd: string;
	model: string;
	branch: string;
	status: "ready" | "working";
};

function infoLines(theme: Theme, state: HeaderState): Seg[][] {
	const accent: Styler = (text) => theme.fg("accent", text);
	const muted: Styler = (text) => theme.fg("muted", text);
	const dim: Styler = (text) => theme.fg("dim", text);
	const key: Styler = (text) => theme.bold(theme.fg("muted", text));

	const hints: Seg[] = [];
	for (const [prefix, label] of HINTS) {
		if (hints.length > 0) hints.push({ text: "   ", style: dim });
		hints.push({ text: prefix, style: key });
		hints.push({ text: " ", style: dim });
		hints.push({ text: label, style: dim });
	}

	const busy = state.status === "working";
	const statusColor: Styler = (text) => theme.fg(busy ? "accent" : "success", text);

	const meta: Seg[] = [{ text: `v${VERSION}`, style: dim }];
	if (state.model) {
		meta.push({ text: "  ·  ", style: dim });
		meta.push({ text: state.model, style: muted });
	}

	return [
		[{ text: shortenPath(state.cwd), style: (text) => theme.bold(theme.fg("accent", text)) }],
		hints,
		meta,
	];
}

// ── Extension ──────────────────────────────────────────────────────────────

async function gitBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeout: 400 });
		const name = result.stdout?.trim() ?? "";
		return result.code === 0 && name && name !== "HEAD" ? name : "";
	} catch {
		return "";
	}
}

type HeaderContext = {
	cwd: string;
	model?: { id: string };
	ui: { setHeader(factory: any): void };
};

export default function (pi: ExtensionAPI) {
	const state: HeaderState = { cwd: process.cwd(), model: "", branch: "", status: "ready" };
	let refresh: (() => void) | undefined;

	const applyHeader = (ctx: HeaderContext) => {
		ctx.ui.setHeader((_tui: unknown, theme: Theme) => ({
			render(width: number): string[] {
				const mark = renderMark(theme);
				const info = infoLines(theme, state);

				// Too narrow for the mark: keep the path, drop the rest.
				if (width < MARK_WIDTH + INDENT.length + 2) {
					return ["", fit(info[0], Math.max(0, width))];
				}

				const infoWidth = Math.max(...info.map(segWidth));
				const sideWidth = INDENT.length + MARK_WIDTH + MARK_GAP.length + infoWidth;

				if (width >= sideWidth) {
					const infoMax = width - INDENT.length - MARK_WIDTH - MARK_GAP.length;
					return [
						"",
						...mark.map((line, i) =>
							INDENT + line + MARK_GAP + (info[i] ? fit(info[i], infoMax) : ""),
						),
					];
				}

				const max = Math.max(0, width - INDENT.length);
				return [
					"",
					...mark.map((line) => INDENT + line),
					"",
					...info.map((line) => INDENT + fit(line, max)),
				];
			},
			invalidate() {},
		}));
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		state.cwd = ctx.cwd;
		state.model = ctx.model?.id ?? "";
		state.branch = await gitBranch(pi, ctx.cwd);
		state.status = "ready";

		refresh = () => applyHeader(ctx);
		refresh();
	});

	pi.on("model_select", async (event) => {
		state.model = event.model?.id ?? state.model;
		refresh?.();
	});

	pi.on("agent_start", async () => {
		state.status = "working";
		refresh?.();
	});

	pi.on("agent_settled", async () => {
		state.status = "ready";
		refresh?.();
	});

	pi.registerCommand("builtin-header", {
		description: "Restore the built-in startup header",
		handler: async (_args, ctx) => {
			refresh = undefined;
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
