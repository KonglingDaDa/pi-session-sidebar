/**
 * Dedup task-assistant when autoload + old `-e trial/...` both run.
 * jiti loads extensions with moduleCache=false, so module-level WeakMap / globalThis
 * singletons are the wrong tool. Handshake uses the shared EventBus (same Pi runtime).
 * A new ExtensionAPI/runtime (soft reload, second session) gets a new bus and re-registers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TASK_ASSISTANT_PING = "pi-local:task-assistant:dup-ping";
export const TASK_ASSISTANT_HERE = "pi-local:task-assistant:dup-here";

/** True when this factory should register input/bus/commands. False = skip duplicate. */
export function claimTaskAssistant(pi: ExtensionAPI): boolean {
	let occupied = false;
	const off = pi.events.on(TASK_ASSISTANT_HERE, () => {
		occupied = true;
	});
	pi.events.emit(TASK_ASSISTANT_PING, { v: 1 });
	off();
	if (occupied) return false;
	pi.events.on(TASK_ASSISTANT_PING, () => {
		pi.events.emit(TASK_ASSISTANT_HERE, { v: 1 });
	});
	return true;
}
