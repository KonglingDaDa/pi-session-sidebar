import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import timeline from "./timeline/index.ts";
import advice from "./advice/index.ts";

/** One Pi package entry assembles the independent timeline and advice owners. */
export default function sessionSidebar(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_PARENT_SESSION) return;
  advice(pi);
  timeline(pi);
}
