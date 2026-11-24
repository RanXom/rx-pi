/**
 * rx-cards — fast-tui's tool cards without the rest of its UI.
 *
 * Vendored from pi-fast-tui 0.9.0 (MIT, Diogo Soares Rodrigues and
 * pi-open-tui contributors). Only the card renderer, the codemode card, and
 * the thinking row are registered; header, footer, editor, telemetry, popups
 * and copy buttons stay out.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createResolver } from "./cards/index.ts";
import { setupCodemode } from "./cards/codemode/extension.ts";
import { installThinkingRow } from "./thinking.ts";
import { renderFrame } from "./cards/frame.ts";

class PlanCard implements Component {
	constructor(private readonly text: string, private readonly theme: Theme) {}
	render(width: number): string[] {
		const lines = this.text
			.split("\n")
			.map((line) => line.trimEnd())
			.filter((line) => line.trim() !== "[plan-mode-execute]");
		while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
		return renderFrame(
			{
				width,
				header: "Execute plan",
				state: "success",
				applyBg: false,
				sections: [{ label: "Plan", lines }],
			},
			this.theme,
		);
	}
	invalidate(): void {}
}

export default function rxCards(pi: ExtensionAPI): void {
	const cards = createResolver(setupCodemode(pi, () => true));
	pi.registerToolRenderer((toolName, next) => cards(toolName, next));
	installThinkingRow(pi);
	pi.registerMessageRenderer("plan-mode-execute", (message, _options, theme) => {
		const text = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content.map((part: { text?: string }) => part.text ?? "").join("\n")
				: String(message.content ?? "");
		return new PlanCard(text, theme);
	});
}
