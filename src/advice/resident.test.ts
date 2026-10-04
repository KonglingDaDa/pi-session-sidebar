import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { claimTaskAssistant, TASK_ASSISTANT_HERE, TASK_ASSISTANT_PING } from "./resident.ts";

function bus() {
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	return {
		emit(channel: string, data: unknown) {
			for (const h of listeners.get(channel) ?? []) h(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const list = listeners.get(channel) ?? [];
			list.push(handler);
			listeners.set(channel, list);
			return () => {
				const next = (listeners.get(channel) ?? []).filter((h) => h !== handler);
				listeners.set(channel, next);
			};
		},
	};
}

function fakePi(events: ReturnType<typeof bus>): ExtensionAPI {
	return { events } as unknown as ExtensionAPI;
}

test("same EventBus: second factory skips; different buses both claim", () => {
	const shared = bus();
	assert.equal(claimTaskAssistant(fakePi(shared)), true);
	assert.equal(claimTaskAssistant(fakePi(shared)), false);
	assert.equal(claimTaskAssistant(fakePi(shared)), false);
	const other = bus();
	assert.equal(claimTaskAssistant(fakePi(other)), true);
	assert.ok(TASK_ASSISTANT_PING.includes("dup-ping"));
	assert.ok(TASK_ASSISTANT_HERE.includes("dup-here"));
});
