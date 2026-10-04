import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ModelSelection { provider: string; model: string }

/** Public default; users may choose any compatible model in Pi's registry. */
export function defaultSummaryModel(): ModelSelection {
  return {
    provider: process.env.PI_SIDEBAR_SUMMARY_PROVIDER?.trim() || "google",
    model: process.env.PI_SIDEBAR_SUMMARY_MODEL?.trim() || "gemini-2.5-flash",
  };
}

/** Advice follows the configured summary model unless explicitly overridden. */
export function adviceModel(): ModelSelection {
  const selected = defaultSummaryModel();
  const configuredDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredDir ? resolve(configuredDir === "~" ? homedir() : configuredDir.startsWith("~/") ? join(homedir(), configuredDir.slice(2)) : configuredDir) : join(homedir(), ".pi", "agent");
  try {
    const config = JSON.parse(readFileSync(join(agentDir, "session-timeline.json"), "utf8"));
    if (typeof config?.summary?.provider === "string" && config.summary.provider.trim()) selected.provider = config.summary.provider.trim();
    if (typeof config?.summary?.model === "string" && config.summary.model.trim()) selected.model = config.summary.model.trim();
  } catch {
    // Optional settings; the timeline owner surfaces unreadable/invalid JSON separately.
  }
  return {
    provider: process.env.PI_SIDEBAR_ADVICE_PROVIDER?.trim() || selected.provider,
    model: process.env.PI_SIDEBAR_ADVICE_MODEL?.trim() || selected.model,
  };
}
