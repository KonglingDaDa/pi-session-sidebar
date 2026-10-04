/**
 * Jev client: shared transport for sidebar scoring.
 * Direct fetch to TypeSafe or a configured loopback gateway (no SDK). Every string leaf is redacted and made well-formed right before sending.
 * The key is read from the environment or ~/.config/typesafe/systemone.env and never logged.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redact, wellFormed } from "./redaction.ts";

export const DEFAULT_JEV_URL = "https://api.typesafe.ai/v1/systemone";

const ENV_FILE = path.join(os.homedir(), ".config", "typesafe", "systemone.env");

function parseEnvFile(file = ENV_FILE): Record<string, string> {
	const out: Record<string, string> = {};
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
			if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
		}
	} catch {
		// Missing file: fall back to the environment and the configured URL.
	}
	return out;
}

function baseUrl(base?: string): string | undefined {
	const b = base?.trim();
	return b ? `${b.replace(/\/$/, "")}/v1/systemone` : undefined;
}

/** Hosts a Jev request may go to: the local gateway (loopback only) or TypeSafe's own API over https. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const OFFICIAL = new Set(["api.typesafe.ai"]);

/** The URL when it points at an allowed Jev host and the System One path; undefined otherwise. */
export function allowedJevUrl(raw: string): URL | undefined {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return undefined;
	}
	if (u.username || u.password || u.search || u.hash) return undefined;
	if (!u.pathname.endsWith("/v1/systemone")) return undefined;
	if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u;
	if (u.protocol === "https:" && (LOOPBACK.has(u.hostname) || OFFICIAL.has(u.hostname))) return u;
	return undefined;
}

export interface JevEndpoint {
	key?: string;
	url: string;
}

/** Key and URL: the first allowed address among environment endpoint/base, systemone.env endpoint/base, then the configured default. */
export function resolveEndpoint(defaultUrl: string, env: Record<string, string | undefined> = process.env, file = parseEnvFile()): JevEndpoint {
	const key = env.SYSTEMONE_API_KEY || env.TYPESAFE_API_KEY || file.SYSTEMONE_API_KEY || file.TYPESAFE_API_KEY || undefined;
	const candidates = [
		env.SYSTEMONE_ENDPOINT,
		baseUrl(env.TYPESAFE_BASE_URL),
		file.SYSTEMONE_ENDPOINT,
		baseUrl(file.TYPESAFE_BASE_URL),
		defaultUrl,
	].filter((u): u is string => Boolean(u?.trim()));
	// An endpoint outside the whitelist (e.g. a public relay) is skipped rather than fatal, so a loopback base still wins.
	const url = candidates.find((u) => allowedJevUrl(u.trim()))?.trim() ?? candidates[0] ?? defaultUrl;
	return { key, url };
}

export interface JevReply {
	answers: Record<string, unknown>;
	inputTokens: number;
	ms: number;
}

export class JevError extends Error {
	readonly kind: "timeout" | "http" | "parse" | "network" | "no_key" | "bad_url";
	constructor(message: string, kind: JevError["kind"]) {
		super(message);
		this.kind = kind;
	}
}

/** One System One request. Throws JevError (message redacted, ≤ 200 chars). No retries. */
export async function askJev(
	endpoint: JevEndpoint,
	model: string,
	state: unknown,
	questions: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JevReply> {
	if (!endpoint.key) throw new JevError("no Jev key (SYSTEMONE_API_KEY / ~/.config/typesafe/systemone.env)", "no_key");
	const jevUrl = allowedJevUrl(endpoint.url);
	if (!jevUrl) throw new JevError("Jev URL not allowed (loopback gateway or https://api.typesafe.ai/v1/systemone only)", "bad_url");
	const started = Date.now();
	const timeout = AbortSignal.timeout(timeoutMs);
	const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let res: Response;
	try {
		res = await fetch(jevUrl, {
			method: "POST",
			headers: { Authorization: `Bearer ${endpoint.key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model, state, questions }, (_k, v) => (typeof v === "string" ? wellFormed(redact(v)) : v)),
			signal: sig,
		});
	} catch (e) {
		if (timeout.aborted) throw new JevError("timeout", "timeout");
		throw new JevError(`network: ${redact(String((e as Error)?.message ?? e)).slice(0, 180)}`, "network");
	}
	if (!res.ok) {
		let text = "";
		try {
			text = await res.text();
		} catch {
			// Body unreadable: report the status alone.
		}
		const body = redact(text.replace(/\s+/g, " ")).slice(0, 160);
		throw new JevError(`http ${res.status}: ${body}`, "http");
	}
	let data: { answers?: Record<string, unknown>; usage?: { input_tokens?: unknown } };
	try {
		data = (await res.json()) as typeof data;
	} catch (e) {
		throw new JevError(`parse: ${String((e as Error)?.message ?? e).slice(0, 180)}`, "parse");
	}
	const tokens = data.usage?.input_tokens;
	return {
		answers: data.answers ?? {},
		inputTokens: typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0,
		ms: Date.now() - started,
	};
}
