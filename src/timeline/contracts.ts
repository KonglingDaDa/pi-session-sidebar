/**
 * Seam contracts for session-timeline. Types only: no logic here.
 * Every custom entry carries `v`; readers skip versions they do not know (and count them).
 * v2 (2026-09-26): step records gain `intent`, Jev completion `score`, and next-step predictions `next`.
 * v2 additions (2026-09-27, optional fields, same `v`): step `decisions` / `now` / `gen.prompt`; score `rubric` / `waiting`.
 */

export const STEP_ENTRY = "session-timeline" as const;
export const COMPACTION_ENTRY = "session-timeline-compaction" as const;

export type StepStatus = "done" | "in_progress" | "blocked" | "waiting_user";
export const STEP_STATUSES: readonly StepStatus[] = ["done", "in_progress", "blocked", "waiting_user"];

/** Tool categories counted per turn (code-computed, never model-generated). */
export interface ToolCounts {
	read: number;
	edit: number;
	run: number;
	search: number;
	agent: number;
	ask: number;
	other: number;
}

export interface TurnStats {
	tools: ToolCounts;
	/** Tool results marked isError. */
	errors: number;
	/** Distinct paths changed by edit/write (at most 20 kept). */
	files: string[];
	added: number;
	removed: number;
	/** Subagent names (or "workflow"), distinct, at most 5. */
	agents: string[];
	/** Successful `git commit` bash calls. */
	commits: number;
	/** First entry timestamp → last entry timestamp of the turn. */
	durationMs: number;
	/** Sum of assistant message usage in the turn (display is off by default: the footer already shows totals). */
	cost: number;
	tokens: number;
}

/** v1 step record (still read; upcast to v2 with intent "" and no score / next). */
export interface TimelineStepV1 {
	v: 1;
	kind: "step";
	fromId: string;
	toId: string;
	startedAt: number;
	endedAt: number;
	phase: { id: string; title: string; isNew: boolean };
	summary: string;
	status: StepStatus;
	goal: string;
	stats: TurnStats;
	gen: { ok: boolean; model: string; ms: number; error?: string };
}

/** Jev completion score for one turn. */
export interface StepScoreV1 {
	/** Score level (0..3) normalized to 0..1. */
	completion: number;
	/** Raw probability-weighted Score position, 0..3. */
	level: number;
	confidence: number;
	/** Noul: the turn went somewhere the user did not ask for. */
	offIntent: number;
	/** Rubric version: 2 = context includes the previous reply and mid-turn decisions, completion asks only "how much got done". Older scores are not shown. */
	rubric?: 2;
	/** Noul (rubric 2): what is left is waiting on the user or an outside factor (login, key, a decision only the user can make). */
	waiting?: number;
	ms: number;
	tokens: number;
}

export interface NextStepV1 {
	text: string;
	/** Jev "worth doing next" Score normalized to 0..1; absent when not scored. A prediction, not a measurement. */
	score?: number;
	confidence?: number;
}

export interface NextV1 {
	/** ≤5, highest score first (Gemini's order when unscored). */
	steps: NextStepV1[];
	/** ≤2 phase-level "what could come after this" directions; only when the turn ended done. Unscored. */
	directions: string[];
	/** Set when Jev scoring failed: steps keep Gemini's order without scores. */
	scoreError?: string;
}

/**
 * One summarized turn: user message `fromId` up to `toId`. Latest record for a `fromId` wins.
 * Failure semantics: Gemini failure → gen.ok=false, intent = head of the user message, no score / next.
 * Jev failure → scoreError (and/or next.scoreError); the summary is kept.
 */
export interface TimelineStepV2 {
	v: 2;
	kind: "step";
	fromId: string;
	toId: string;
	startedAt: number;
	endedAt: number;
	/** phase.id = fromId of the first step of that phase. */
	phase: { id: string; title: string; isNew: boolean };
	/** What the user wanted this turn. */
	intent: string;
	/** What came of it (result / conclusion). "" when it would just repeat `intent`. */
	summary: string;
	/** ≤3 key decisions settled this turn (the user's mid-turn answers, proposals the user accepted). Absent in older records. */
	decisions?: string[];
	/** Where the whole session stands after this turn: done so far, stuck on, waiting for whom. Absent in older records. */
	now?: string;
	status: StepStatus;
	/** Session goal as understood after this step. */
	goal: string;
	stats: TurnStats;
	gen: {
		ok: boolean;
		model: string;
		ms: number;
		error?: string;
		/** Written by backfill (batched) rather than right after the turn. */
		backfill?: boolean;
		/** Summarized while the previous turn had no record yet (backfill pending); re-summarized once it has one. */
		gap?: boolean;
		/** In-memory interim summary of a turn still running (mid-turn compaction). Never written to the session. */
		partial?: boolean;
		/** Prompt version: 2 = with previous reply / mid-turn decisions, `decisions` and `now` fields. Absent = older prompt. */
		prompt?: 2;
	};
	score?: StepScoreV1;
	scoreError?: string;
	next?: NextV1;
}

/** The step shape the rest of the code works with. */
export type TimelineStep = TimelineStepV2;

export interface CompactionPhaseCoverage {
	phaseId: string;
	title: string;
	/** Noul: probability that the post-compaction context still covers this phase. */
	covered: number;
}

export interface CompactionJevResult {
	/** Score level (0..3) normalized to 0..1. */
	consistency: number;
	/** Raw probability-weighted Score position, 0..3. */
	level: number;
	confidence: number;
	/** Noul: summary introduces a goal the user never asked for. */
	invented: number;
	/** Noul: what the assistant sees after compaction (summary + kept recent messages) covers what was being worked on right before compaction; -1 when there was no timeline phase to check. */
	currentCovered: number;
	phases: CompactionPhaseCoverage[];
	ms: number;
	tokens: number;
}

export interface CompactionCheckV1 {
	v: 1;
	kind: "compaction";
	/** Id of Pi's compaction entry this check is about. Latest record per compactionId wins. */
	compactionId: string;
	at: number;
	tokensBefore: number;
	preGoal: string;
	postGoal: string;
	/** Gemini's one-sentence Simplified-Chinese gist of `postGoal` (Pi's summaries are usually English). Added by a later record. */
	postBrief?: string;
	/** User / assistant text messages Pi kept verbatim after the summary (optional: absent in older records). */
	keptMessages?: number;
	jev?: CompactionJevResult;
	error?: string;
}

/** What Gemini must return for one turn (validated before use). */
export interface SummaryOutput {
	continue_phase: boolean;
	phase_title: string;
	intent: string;
	/** "" when the result would just repeat the intent. */
	result: string;
	status: StepStatus;
	goal: string;
	/** ≤3 key decisions settled this turn. */
	decisions: string[];
	/** Where the whole session stands now ("" when not given). */
	now: string;
	/** Up to 5 next-step candidates. */
	next: string[];
	/** Up to 2 directions, only when status is done. */
	directions: string[];
}

/** One turn inside a batched (backfill) Gemini reply. */
export interface BatchTurnOutput {
	id: string;
	continue_phase: boolean;
	phase_title: string;
	intent: string;
	result: string;
	decisions: string[];
	status: StepStatus;
	goal: string;
}

export interface BatchOutput {
	turns: BatchTurnOutput[];
	/** Where the session stands after the batch's last turn ("" when not given). */
	now: string;
	/** Only when the batch contains the branch's latest turn. */
	next: string[];
	directions: string[];
}

export type ModuleName =
	| "time"
	| "duration"
	| "tools"
	| "diff"
	| "agents"
	| "errors"
	| "commits"
	| "cost"
	| "goal"
	| "compaction"
	| "score"
	| "next"
	| "hints";

export const MODULE_NAMES: readonly ModuleName[] = [
	"time",
	"duration",
	"tools",
	"diff",
	"agents",
	"errors",
	"commits",
	"cost",
	"goal",
	"compaction",
	"score",
	"next",
	"hints",
];

export interface TimelineConfig {
	/** Settings file layout version (2: small print off by default, `duration` split from `time`). */
	version?: number;
	enabled: boolean;
	width: number;
	modules: Record<ModuleName, boolean>;
	summary: { provider: string; model: string; thinking: "off" | "minimal" | "low" | "medium" | "high"; timeoutMs: number };
	jev: { enabled: boolean; timeoutMs: number };
	backfill: { auto: boolean; maxTurns: number; batchSize: number };
}
