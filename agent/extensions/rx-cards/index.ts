/**
 * rx-cards — fast-tui's tool cards without the rest of its UI.
 *
 * Vendored from pi-fast-tui 0.9.0 (MIT, Diogo Soares Rodrigues and
 * pi-open-tui contributors). Only the card renderer, the codemode card, and
 * the thinking row are registered; header, footer, editor, telemetry, popups
 * and copy buttons stay out.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createResolver } from "./cards/index.ts";
import { setupCodemode } from "./cards/codemode/extension.ts";
import { installThinkingRow } from "./thinking.ts";

export default function rxCards(pi: ExtensionAPI): void {
	const cards = createResolver(setupCodemode(pi, () => true));
	pi.registerToolRenderer((toolName, next) => cards(toolName, next));
	installThinkingRow(pi);
}
