#!/usr/bin/env python3
"""Give zentui's compact user-message style a rule above and below.

The zen preset uses `compact` so user messages stay one text row; this adds the
frame lines the opencode preset has without the spacer rows.
"""

import pathlib
import sys

agent = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else pathlib.Path.home() / ".pi" / "agent")
path = agent / "npm" / "node_modules" / "pi-zentui" / "extensions" / "zentui" / "user-message-styles.ts"
if not path.exists():
    sys.exit(0)

source = path.read_text()
if "rx-pi: compact keeps" in source:
    sys.exit(0)

OLD = '''function renderCompact(input: UserMessageStyleRenderInput): string[] {
	const { width, theme, config } = input;
	if (width <= 0) return [""];
	const rail = renderRail(theme, config);
	const railWidth = visibleWidth(rail);
	if (width <= railWidth) {
		return renderMarkdown(input, width).map((line) =>
			truncateToWidth(trimMarkdownPadding(line), width, ""),
		);
	}
	const contentWidth = width - railWidth;
	return renderMarkdown(input, contentWidth).map((line) =>
		truncateToWidth(`${rail}${trimMarkdownPadding(line)}`, width, ""),
	);
}'''

NEW = '''function renderCompact(input: UserMessageStyleRenderInput): string[] {
	const { width, theme, config } = input;
	if (width <= 0) return [""];
	// rx-pi: compact keeps one text row but is framed by rules like the opencode preset.
	const rule = () => border(theme, config, "─".repeat(width));
	const rail = renderRail(theme, config);
	const railWidth = visibleWidth(rail);
	if (width <= railWidth) {
		return [
			rule(),
			...renderMarkdown(input, width).map((line) =>
				truncateToWidth(trimMarkdownPadding(line), width, ""),
			),
			rule(),
		];
	}
	const contentWidth = width - railWidth;
	return [
		rule(),
		...renderMarkdown(input, contentWidth).map((line) =>
			truncateToWidth(`${rail}${trimMarkdownPadding(line)}`, width, ""),
		),
		rule(),
	];
}'''

if OLD not in source:
    sys.exit(0)
path.write_text(source.replace(OLD, NEW))
