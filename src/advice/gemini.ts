/** Nested Gemini call via the session model registry. Does not import timeline internals. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LIMITS } from "./limits.ts";
import { sanitizeText } from "./redact.ts";

export type GeminiRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "streamSimple">;

import { adviceModel } from "../shared/models.ts";

export type Thinking = "off" | "low";

export interface GeminiCallResult {
	text?: string;
	thinking?: string;
	error?: string;
	stopReason?: string;
	ms: number;
	model: string;
}

function combineAbort(job: AbortSignal, timeoutMs: number): AbortSignal {
	return AbortSignal.any([job, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : job]);
}

export async function callGeminiJson(
	registry: GeminiRegistry,
	system: string,
	prompt: string,
	job: AbortSignal,
	timeoutMs: number = LIMITS.postReplyTimeoutMs,
	thinking: Thinking = "low",
): Promise<GeminiCallResult> {
	const selected = adviceModel();
	const label = `${selected.provider}/${selected.model}`;
	const model = registry.find(selected.provider, selected.model);
	if (!model) return { error: `找不到模型 ${label}`, ms: 0, model: label };
	if (job.aborted) return { error: "aborted", ms: 0, model: label };
	const started = Date.now();
	try {
		const stream = registry.streamSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: sanitizeText(prompt, 20_000) }], timestamp: Date.now() }] },
			{
				// SimpleStreamOptions.reasoning is ThinkingLevel (no "off"); omit the field to disable thinking.
				reasoning: thinking === "low" ? "low" : undefined,
				maxTokens: 4096,
				cacheRetention: "none",
				signal: combineAbort(job, timeoutMs),
			},
		);
		const reply = await stream.result();
		const ms = Date.now() - started;
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			const error = reply.errorMessage || `模型返回 ${reply.stopReason}`;
			if (job.aborted || reply.stopReason === "aborted") return { error: "aborted", stopReason: reply.stopReason, ms, model: label };
			return { error, stopReason: reply.stopReason, ms, model: label };
		}
		const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
		const thought = reply.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n");
		if (!text.trim() && !thought.trim()) return { error: "模型没有返回正文", stopReason: reply.stopReason, ms, model: label };
		return { text, thinking: thought, stopReason: reply.stopReason, ms, model: label };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		const ms = Date.now() - started;
		if (job.aborted || /abort/i.test(error)) return { error: "aborted", ms, model: label };
		return { error, ms, model: label };
	}
}
