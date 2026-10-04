/**
 * Jev (TypeSafe System One) judgments for the timeline. Questions are English (the pattern memory-rerank
 * validated); content is raw user / assistant text (redacted and clipped by the caller).
 *
 * - checkCompaction: does the post-compaction context still point where the user was going? (1 Score + ≤6 Noul)
 * - scoreTurn: how complete is this turn against what the user asked? (1 Score + 1 Noul; sees the action list)
 * - scoreNext: how worth doing next is each predicted step? (1 Score per candidate; text only, no tool info)
 */
import { clip } from "../shared/context.ts";
import { askJev, resolveEndpoint, DEFAULT_JEV_URL } from "../shared/jev-client.ts";
import { noul, type Question } from "../shared/questions.ts";
import type { CompactionJevResult, CompactionPhaseCoverage, NextStepV1, StepScoreV1 } from "./contracts.ts";
import { redactDeep, type PhaseLine } from "./core.ts";

type ScoreAnswer = { score?: number; confidence?: number };
type NoulAnswer = { noul?: number };
type Answers = Record<string, ScoreAnswer & NoulAnswer>;

async function ask(state: Record<string, unknown>, questions: Record<string, Question>, timeoutMs: number): Promise<{ answers: Answers; ms: number; tokens: number }> {
	const reply = await askJev(
		resolveEndpoint(DEFAULT_JEV_URL),
		"jev-latest",
		redactDeep(state),
		redactDeep(questions),
		timeoutMs,
	);
	return { answers: reply.answers as Answers, ms: reply.ms, tokens: reply.inputTokens };
}

function scoreOf(answers: Answers, id: string): { score: number; confidence: number } {
	const v = answers[id]?.score;
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Jev 没有返回 ${id}`);
	return { score: v, confidence: answers[id]?.confidence ?? 0 };
}

function noulOf(answers: Answers, id: string): number {
	const v = answers[id]?.noul;
	if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Jev 没有返回 ${id}`);
	return v;
}

const unit = (score: number, levels: number) => Math.min(1, Math.max(0, score / (levels - 1)));

const phaseView = (phases: readonly PhaseLine[], n: number) =>
	phases.slice(-n).map((p) => ({ title: p.title, status: p.status, last_step: p.lastStep }));

// ---------- compaction consistency ----------

export interface CheckInput {
	/** Timeline goal right before compaction ("" when the timeline was empty). */
	preGoal: string;
	/** Phases before compaction, oldest first; the last one is the current work. */
	phases: PhaseLine[];
	/** The user's latest messages before compaction, raw (redacted, clipped). */
	userMessages: string[];
	/** Goal section of the compaction summary. */
	postGoal: string;
	/** Whole compaction summary (clipped here). */
	summary: string;
	/** Messages Pi kept verbatim after the summary, oldest first (text only, redacted, clipped). */
	kept: { role: "user" | "assistant"; text: string }[];
}

export const MAX_PHASE_QUESTIONS = 4;
export const SUMMARY_CHARS = 12000;

const CONTEXT =
	"`before_compaction` describes the conversation right before its older turns were compacted: " +
	"`user_messages` are the user's latest messages (oldest first, raw text), `timeline_goal` and `phases` come " +
	"from a timeline kept alongside the conversation (oldest first; the last phase is the work in progress at " +
	"compaction time). `after_compaction` is everything the AI assistant still sees afterwards: `summary` replaced " +
	"the older turns, and `kept_recent_messages` are the newest messages, kept word for word after the summary " +
	"(an empty list means nothing was kept). Something counts as present after compaction when it is in the " +
	"summary or in the kept messages.";

export const CONSISTENCY_LEVELS = [
	"Diverged: the goal the assistant would follow after compaction (`after_compaction.summary.goal_section` plus `after_compaction.kept_recent_messages`) is about a different task, or the task the user was mainly working on right before compaction is missing from both.",
	"Partly diverged: the main task is there, but after compaction a finished, abandoned or minor item looks like the current goal, or the user's latest explicit request is missing from both the summary and the kept messages.",
	"Mostly consistent: same task and direction; only minor omissions or wording differences.",
	"Fully consistent: same task, the same current progress and the same next step as before compaction.",
];

export function buildState(input: CheckInput): Record<string, unknown> {
	return {
		before_compaction: {
			user_messages: input.userMessages,
			timeline_goal: input.preGoal || "(none)",
			phases: phaseView(input.phases, 8),
		},
		after_compaction: {
			summary: {
				goal_section: input.postGoal,
				full_text: clip(input.summary, SUMMARY_CHARS),
			},
			kept_recent_messages: input.kept,
		},
	};
}

export function buildQuestions(input: CheckInput): { questions: Record<string, Question>; phaseIds: string[] } {
	const questions: Record<string, Question> = {
		consistency: {
			type: "score",
			instructions: `${CONTEXT} How consistent is the goal the assistant would follow after compaction with the direction the user was actually working in right before compaction (judge the direction by \`before_compaction.user_messages\` first, then the timeline goal and phases)?`,
			criteria: CONSISTENCY_LEVELS,
		},
		invented: noul(
			`${CONTEXT} Does \`after_compaction.summary.goal_section\` state a goal or requirement that the user never asked for in \`before_compaction.user_messages\` and that does not follow from them?`,
			"Yes: at least one goal or requirement in it has no basis in the user's messages.",
			"No: every goal in it comes from, or clearly follows from, the user's messages.",
		),
	};
	const phaseIds: string[] = [];
	const current = input.phases.at(-1);
	if (current) {
		questions.current = noul(
			{
				current_work: { phase: current.title, last_step: current.lastStep },
				question: `${CONTEXT} After compaction, can the assistant still tell what \`current_work\` is and where it stands, from \`after_compaction.summary.full_text\` or \`after_compaction.kept_recent_messages\`?`,
			},
			"Yes: the summary or the kept messages say what this work is and how far it has got, even in different words.",
			"No: neither mentions this work, or they only name it without saying where it stands.",
		);
		const earlier = input.phases.slice(0, -1).slice(-MAX_PHASE_QUESTIONS);
		earlier.forEach((p, i) => {
			phaseIds.push(p.id);
			questions[`phase_${i}`] = noul(
				{
					phase: { title: p.title, status: p.status, last_step: p.lastStep },
					question: `${CONTEXT} Is the work of \`phase\` still present after compaction (for example as done work, a decision or a result), in \`after_compaction.summary.full_text\` or \`after_compaction.kept_recent_messages\`?`,
				},
				"Yes: the summary or the kept messages mention this work or its outcome, even in different words.",
				"No: nothing after compaction refers to this work.",
			);
		});
	}
	return { questions, phaseIds };
}

export async function checkCompaction(input: CheckInput, timeoutMs: number): Promise<CompactionJevResult> {
	const { questions, phaseIds } = buildQuestions(input);
	const { answers, ms, tokens } = await ask(buildState(input), questions, timeoutMs);
	const consistency = scoreOf(answers, "consistency");
	const earlier = input.phases.slice(0, -1).slice(-MAX_PHASE_QUESTIONS);
	const phases: CompactionPhaseCoverage[] = phaseIds.map((id, i) => ({
		phaseId: id,
		title: earlier[i]?.title ?? "",
		covered: noulOf(answers, `phase_${i}`),
	}));
	return {
		consistency: unit(consistency.score, CONSISTENCY_LEVELS.length),
		level: consistency.score,
		confidence: consistency.confidence,
		invented: noulOf(answers, "invented"),
		currentCovered: input.phases.length ? noulOf(answers, "current") : -1,
		phases,
		ms,
		tokens,
	};
}

// ---------- per-turn completion ----------

export const REPLY_CHARS = 6000;

export interface TurnScoreInput {
	/** End of the assistant's previous reply (and unanswered messages since), redacted. "" for the first turn. */
	previous: string;
	/** The user's answers to the assistant's mid-turn questions. */
	decisions: string[];
	/** The user's message this turn, raw (redacted, clipped). */
	userRequest: string;
	/** What the summary model understood the user wanted. */
	intent: string;
	goal: string;
	/** Earlier phases, oldest first. */
	phases: PhaseLine[];
	/** Assistant's visible reply text this turn (redacted, budgeted). */
	reply: string;
	/** Code-extracted action list (tool names and targets only). */
	actions: string;
}

const TURN_CONTEXT =
	"`turn` is one turn of a conversation between a user and an AI coding assistant. `user_request` is what the user " +
	"wrote (raw). It is often a reply to `previous_assistant_ending` (the end of the assistant's previous message: a " +
	"question, a proposal or a plan); then what the user asked includes what they agreed to there. " +
	"`user_decisions_during_turn` are the user's answers to questions the assistant asked in the middle of this turn; " +
	"they are part of what the user asked. `intent_as_understood` is a one-line reading of the request (it may be " +
	"wrong; the raw request wins). `assistant_reply` is the assistant's visible reply text (tool output and hidden " +
	"reasoning are not included; the middle may be cut), and `actions` lists the tools it used (files changed, " +
	"commands run with ✗ for failures, subagents, searches, questions; names only; long command lists keep the start, " +
	"the end and checks). `session` gives the overall goal and earlier phases for context.";

/** One dimension only: how much got done (whether it was tested is a different question and made the levels ambiguous). */
export const COMPLETION_LEVELS = [
	"Nothing of what the user asked (or agreed to) got done.",
	"Some of it got done, but most of it did not.",
	"Most of it got done; some parts are missing.",
	"All of it got done (for a question or a request for a plan or opinion: it was fully answered).",
];

export function buildTurnState(input: TurnScoreInput): Record<string, unknown> {
	return {
		session: { goal: input.goal || "(none)", earlier_phases: phaseView(input.phases, 4) },
		turn: {
			previous_assistant_ending: input.previous || "(none: first turn)",
			user_request: input.userRequest,
			user_decisions_during_turn: input.decisions.length ? input.decisions : "(none)",
			intent_as_understood: input.intent,
			assistant_reply: clip(input.reply, REPLY_CHARS),
			actions: input.actions || "(no tools used)",
		},
	};
}

export function buildTurnQuestions(): Record<string, Question> {
	return {
		completion: {
			type: "score",
			instructions: `${TURN_CONTEXT} How much of what the user asked (including what they agreed to and decided) got done in this turn? Judge only what got done, not whether it was tested.`,
			criteria: COMPLETION_LEVELS,
		},
		off_intent: noul(
			`${TURN_CONTEXT} Did the assistant go somewhere the user did not ask for or agree to: a different task, large changes nobody asked for, spending beyond an agreed limit, or ignoring an explicit constraint? Following an agreed plan, asking the user before a costly or uncertain step, writing docs or tests for requested work, and changing approach after the user approved it are NOT off-intent.`,
			"Yes: a clear part of the work is outside or against what the user asked or agreed to.",
			"No: the work stays within what the user asked or agreed to (small helpful extras are fine).",
		),
		waiting: noul(
			`${TURN_CONTEXT} Is the part that is not done waiting on the user or on something outside the assistant's control (a login, a key, a payment, a decision only the user can make, an unavailable external service), rather than the assistant not trying or getting it wrong?`,
			"Yes: what is left is waiting on the user or an outside factor.",
			"No: nothing is left, or what is left is the assistant's own shortfall.",
		),
	};
}

export async function scoreTurn(input: TurnScoreInput, timeoutMs: number): Promise<StepScoreV1> {
	const { answers, ms, tokens } = await ask(buildTurnState(input), buildTurnQuestions(), timeoutMs);
	const c = scoreOf(answers, "completion");
	return {
		completion: unit(c.score, COMPLETION_LEVELS.length),
		level: c.score,
		confidence: c.confidence,
		offIntent: noulOf(answers, "off_intent"),
		rubric: 2,
		waiting: noulOf(answers, "waiting"),
		ms,
		tokens,
	};
}

// ---------- next-step ranking ----------

export interface NextScoreInput {
	goal: string;
	phases: PhaseLine[];
	/** The user's latest messages, oldest first (raw, redacted, clipped). */
	userMessages: string[];
	/** Assistant's visible reply text in the latest turn. */
	reply: string;
	candidates: string[];
}

const NEXT_CONTEXT =
	"`conversation` is the latest state of a conversation between a user and an AI coding assistant: the user's " +
	"latest messages (oldest first, raw), the assistant's latest visible reply, and a timeline of the session " +
	"(goal and phases, oldest first). `candidate` is a guessed next **user message** (what the user would type next), " +
	"not a supervisor recommendation and not a goal-driven task action.";

export const NEXT_LEVELS = [
	"Unlikely next message: already sent, rejected, empty/vague (continue/ok/next), or not something this user would type now.",
	"Possible later message: related, but not the immediate next thing the user would send given the latest reply.",
	"Plausible next user message: fits the last user turn, the latest reply, and any waiting question.",
	"The most likely next user message right now, especially a concrete answer when the assistant is waiting.",
];

export function buildNextState(input: NextScoreInput): Record<string, unknown> {
	return {
		conversation: {
			user_messages: input.userMessages,
			latest_assistant_reply: clip(input.reply, REPLY_CHARS),
			session_goal: input.goal || "(none)",
			phases: phaseView(input.phases, 6),
		},
	};
}

export function buildNextQuestions(candidates: readonly string[]): Record<string, Question> {
	const questions: Record<string, Question> = {};
	candidates.forEach((text, i) => {
		questions[`next_${i}`] = {
			type: "score",
			instructions: { candidate: text, question: `${NEXT_CONTEXT} How plausible is \`candidate\` as the user's next message?` },
			criteria: NEXT_LEVELS,
		};
	});
	return questions;
}

/** Candidates with Jev scores, highest first (ties keep Gemini's order). */
export async function scoreNext(input: NextScoreInput, timeoutMs: number): Promise<NextStepV1[]> {
	if (!input.candidates.length) return [];
	const { answers } = await ask(buildNextState(input), buildNextQuestions(input.candidates), timeoutMs);
	const scored = input.candidates.map((text, i) => {
		const s = scoreOf(answers, `next_${i}`);
		return { text, score: unit(s.score, NEXT_LEVELS.length), confidence: s.confidence, i };
	});
	scored.sort((a, b) => b.score - a.score || a.i - b.i);
	return scored.map(({ text, score, confidence }) => ({ text, score, confidence }));
}
