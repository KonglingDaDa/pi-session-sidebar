import type { SessionLine } from "./contracts.ts";
import { LIMITS } from "./limits.ts";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

/** Recent user lines plus the last assistant reply. Never includes images. */
export function recentLines(entries: readonly unknown[], limit = LIMITS.maxRecentUser + 4): SessionLine[] {
	const out: SessionLine[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { message?: unknown }).message;
		if (!message || typeof message !== "object") continue;
		const role = (message as { role?: unknown }).role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf((message as { content?: unknown }).content).trim();
		if (!text) continue;
		out.push({ role, text });
	}
	return out.slice(-limit);
}
