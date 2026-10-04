import { clip, redact, wellFormed } from "../shared/redaction.ts";
import { LIMITS } from "./limits.ts";

export { clip, redact, wellFormed };

const SECRETISH = /apikey_|sk-|jgw_|Bearer\s|PRIVATE KEY|ghp_|xox[abp]-|AKIA|AIza|password|passwd|pwd|密码|口令/i;

/** Drop images and secret-like lines before any model/Jev payload or log. */
export function sanitizeText(text: string, max: number): string {
	const cleaned = text
		.split("\n")
		.filter((line) => !SECRETISH.test(line) || line.length < 8)
		.join("\n");
	return clip(cleaned, max);
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function jsonValue(value: string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue } | Record<string, unknown>): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => jsonValue(item as JsonValue));
	const out: { [key: string]: JsonValue } = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		out[key] = jsonValue(item as JsonValue);
	}
	return out;
}

export function sanitizeDeep(value: JsonValue, max = LIMITS.maxMessageChars): JsonValue {
	if (typeof value === "string") return sanitizeText(value, max);
	if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, max));
	if (value && typeof value === "object") {
		const out: { [key: string]: JsonValue } = {};
		for (const [key, item] of Object.entries(value)) out[key] = sanitizeDeep(item, max);
		return out;
	}
	return value;
}

export function capState(state: Record<string, unknown>, maxChars: number = LIMITS.maxStateChars): Record<string, unknown> {
	let current: Record<string, unknown> = structuredClone(state);
	const over = () => JSON.stringify(current).length > maxChars;
	if (!over()) return current;
	if (Array.isArray(current.catalog)) {
		current.catalog = (current.catalog as Record<string, unknown>[]).map((row) => ({
			...row,
			description: typeof row.description === "string" ? row.description.slice(0, 40) : row.description,
		}));
	}
	if (over() && Array.isArray(current.recent_user_messages)) {
		current.recent_user_messages = (current.recent_user_messages as string[]).map((t) => t.slice(0, 80));
	}
	if (over() && typeof current.last_assistant_reply === "string") current.last_assistant_reply = current.last_assistant_reply.slice(0, 80);
	if (over()) current.confirmed_task_context = "";
	if (over() && current.openspec && typeof current.openspec === "object") {
		const os = current.openspec as { kind?: string; changes?: unknown; change?: { name?: string }; error?: string };
		const names = Array.isArray(os.changes)
			? (os.changes as { name?: string }[]).slice(0, 2).map((c) => c.name)
			: os.change?.name;
		current.openspec = { kind: os.kind, names, error: os.error };
	}
	if (over() && Array.isArray(current.catalog)) current.catalog = (current.catalog as unknown[]).slice(0, 3);
	if (over()) {
		const budget = Math.max(0, maxChars - 48);
		current = { current_message: String(current.current_message ?? "").slice(0, budget), clipped: true };
	}
	return current;
}
