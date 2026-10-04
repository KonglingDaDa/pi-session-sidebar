/** Distinguishes a loaded pre-send gate from an unloaded extension. No raw user text. */
export const PRESEND_BUILD = "presend-new-app-2";

/** Bounds for catalog reads, Jev context, and OpenSpec. Documented in ASSUMPTIONS.md. */
export const LIMITS = {
	maxCatalogFileBytes: 256_000,
	maxSkillBodyChars: 80_000,
	maxCatalogEntries: 64,
	maxDialogRows: 32,
	maxJevSkills: 12,
	startMaxOrdinary: 3,
	ongoingMaxOrdinary: 1,
	maxRecentUser: 3,
	maxMessageChars: 600,
	replyHeadChars: 500,
	replyTailChars: 900,
	maxStateChars: 12_000,
	jevTimeoutMs: 8_000,
	openspecTimeoutMs: 2_000,
	recommendScoreMin: 2,
	/**
	 * Post-reply goal-closure only. Independent of pre-send recommendScoreMin.
	 * Carried over from the pre-2026-10-04 "worth doing" rubric (n=10 windows: useful waiting answers 1.78–1.82,
	 * unsafe permission substitute 1.14). The rubric changed to goal closure, so this threshold is provisional
	 * until a live session shows where the new four levels actually land. Do not retune it from one empty run.
	 */
	postReplyScoreMin: 1.7,
	scoreLevels: ["Not applicable to this send", "Weakly related", "Applicable now", "Strongly needed now"] as const,
	maxDirections: 2,
	maxActions: 3,
	/** How many recent user messages the advice anchor keeps as the user's own words. */
	maxAnchorUserMessages: 3,
	/** How many settled decisions from the timeline the advice anchor keeps. */
	maxAnchorDecisions: 3,
	/** Evidence line under one closure item ("what this rests on"). */
	evidenceChars: 60,
	/** Storage safety ceiling, separate from short-text generation targets. Reject; never clip. */
	postReplyTextMax: 4096,
	postReplyLabelChars: 32,
	directionPromptChars: 240,
	actionPromptChars: 240,
	postReplyTimeoutMs: 20_000,
	postReplyBudgetMs: 45_000,
	postReplyRetries: 1,
	/** Goal closure: does this push the user's original request toward being accepted, or is it conversation noise? */
	postReplyScoreLevels: [
		"Does not move the original goal: already done, rejected by the user, unrelated, or a generic continue",
		"Background only: context that helps explain the work, but not a step toward acceptance",
		"Moves the original goal: a real step toward what the user asked for, judged against the stated goal",
		"Unblocks acceptance: the user must decide it, or it is the last thing between here and done",
	] as const,
} as const;
