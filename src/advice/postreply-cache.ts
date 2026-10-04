import { parseTaskAssistantEvent, type TaskAssistantUpdate } from "./events.ts";
import { latestSettledReply } from "./postreply.ts";
import { splitTurns, type Entry } from "../timeline/core.ts";

/** Session custom entry: UI-only, never a message in the model context. No time-based expiry. */
export const POSTREPLY_CACHE_ENTRY = "pi-local:task-assistant:postreply-cache";
export interface PostReplyCache {
	v: 1;
	turnEndId: string;
	update: TaskAssistantUpdate;
}

export function cachedPostReply(sessionId: string, branch: readonly unknown[]): TaskAssistantUpdate | undefined {
	const reply = latestSettledReply(branch);
	const end = splitTurns(branch as Entry[]).at(-1)?.toId;
	if (!reply || !end) return undefined;
	let cached: TaskAssistantUpdate | undefined;
	for (const raw of branch) {
		const entry = raw as { type?: string; customType?: string; data?: Partial<PostReplyCache> } | undefined;
		if (entry?.type !== "custom" || entry.customType !== POSTREPLY_CACHE_ENTRY) continue;
		const data = entry.data;
		if (!data || data.v !== 1 || data.turnEndId !== end) continue;
		const update = parseTaskAssistantEvent(data.update);
		if (update?.type !== "update" || update.sessionId !== sessionId || update.replyEntryId !== reply.replyEntryId) continue;
		if (update.status === "pending") continue; // An interrupted job is never a completed cache.
		// Stricter than the legacy bus: cached actionable suggestions must have valid evidence.
		if ([...update.directions, ...update.actions].some((item) => !item.evidence?.trim())) continue;
		cached = update;
	}
	return cached;
}

export function postReplyCache(update: TaskAssistantUpdate, branch: readonly unknown[]): PostReplyCache | undefined {
	if (update.status === "pending") return undefined;
	const reply = latestSettledReply(branch);
	const end = splitTurns(branch as Entry[]).at(-1)?.toId;
	if (!end || reply?.replyEntryId !== update.replyEntryId) return undefined;
	return { v: 1, turnEndId: end, update };
}
