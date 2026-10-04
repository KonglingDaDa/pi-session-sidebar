/** Post-reply advice lifecycle. Ordinary input remains handled by Pi. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TASK_ASSISTANT_CHANNEL, parseTaskAssistantEvent } from "./events.ts";
import { POSTREPLY_CACHE_ENTRY } from "./postreply-cache.ts";
import { fillUiFrom, PostReplyController } from "./postreply-queue.ts";
import { claimTaskAssistant } from "./resident.ts";

export default function postReplyAdvice(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_PARENT_SESSION) return;
  if (!claimTaskAssistant(pi)) return;
  let enabled = true;
  let current: ExtensionContext | undefined;
  const post = new PostReplyController({
    emit: (event) => pi.events.emit(TASK_ASSISTANT_CHANNEL, event),
    notify: (message, level = "info") => current?.ui.notify(message, level),
    persist: (cache) => pi.appendEntry(POSTREPLY_CACHE_ENTRY, cache),
  });
  pi.events.on(TASK_ASSISTANT_CHANNEL, (data) => {
    const event = parseTaskAssistantEvent(data);
    if (!event) return;
    if (event.type === "advice-context") post.onAdviceContext(event);
    else if (event.type === "advice-covered") post.onAdviceCovered(event);
    else post.onBus(event, current ? fillUiFrom(current) : undefined);
  });
  pi.on("session_shutdown", () => post.abort("session_shutdown"));
  pi.on("session_before_switch", () => post.abort("session_before_switch"));
  pi.on("session_before_tree", () => post.abort("session_before_tree"));
  pi.on("session_compact", () => post.abort("session_compact"));
  pi.on("session_before_compact", () => post.abort("session_before_compact"));
  pi.on("agent_start", (_event, ctx) => { current = ctx; post.abort("agent_start"); });
  pi.on("session_start", (_event, ctx) => {
    current = ctx;
    post.abort("session_start");
    post.setEnabled(enabled && ctx.mode === "tui");
    if (enabled && ctx.mode === "tui") post.restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    current = ctx;
    if (enabled && ctx.mode === "tui") post.restore(ctx);
  });
  pi.on("agent_settled", (_event, ctx) => {
    current = ctx;
    if (enabled && ctx.mode === "tui") post.kick(ctx);
  });
  post.helloProvider();
  pi.registerCommand("task-assistant", {
    description: "回复后建议：on / off / status / fill N / retry（不自动发送）",
    handler: async (args, ctx) => {
      current = ctx;
      if (ctx.mode !== "tui") { ctx.ui.notify("回复后建议只在交互模式下工作", "warning"); return; }
      const [command, number] = args.trim().split(/\s+/);
      if (command === "off") { enabled = false; post.abort("off"); post.setEnabled(false); }
      else if (command === "on") { enabled = true; post.setEnabled(true); post.restore(ctx); }
      else if (command === "retry") {
        if (!enabled || !ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("请先开启建议，并等待当前回复完成", "warning"); return;
        }
        post.kick(ctx, true);
        ctx.ui.notify("已重跑回复后建议", "info"); return;
      } else if (command === "fill") {
        const n = Number(number);
        if (!Number.isInteger(n) || n < 1) { ctx.ui.notify("用法：/task-assistant fill 1", "warning"); return; }
        post.fillIndex(n, fillUiFrom(ctx)); return;
      } else if (command && command !== "status") {
        ctx.ui.notify("用法：/task-assistant on | off | status | fill N | retry", "warning"); return;
      }
      ctx.ui.notify(
        `回复后建议 ${enabled ? "开" : "关"}。${post.statusLine()}。点击侧栏条目复制；fill 只填空输入框，不发送。`,
        "info",
      );
    },
  });
}
