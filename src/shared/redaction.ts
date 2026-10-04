/** Redaction primitives for advice payloads and Jev transport. */
/** Credential shapes (jev-sweep POLICY.secretRe plus jgw_ gateway keys and full private-key blocks). */
const SECRET_RE =
	/apikey_[A-Za-z0-9]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bjgw_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bghp_[A-Za-z0-9]{20,}|\bxox[abp]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}/g;
/** An e-mail address, optionally followed by a password-looking ASCII token ("a@b.com,Secret123"). */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:([,，:：;；\s]+)([\x21-\x7e]{6,}))?/g;
/** The value after 密码 / password when a separator is present ("密码：xxx", "password=xxx", "pwd xxx"). */
const PASSWORD_RE = /((?:密码|口令|password|passwd|pwd)(?:\s*[:：=]\s*|\s*(?:是|为)\s*|\s+))([^\s，,。；;、]+)/gi;
/** Long tokens mixing lower case, upper case and digits (typical of generated passwords and keys). */
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+=]{16,}/g;

export function redact(text: string): string {
	return text
		.replace(SECRET_RE, "[redacted]")
		.replace(EMAIL_RE, (_m, sep?: string, tail?: string) => {
			if (!tail) return "[email]";
			const secretLike = /[,\uFF0C:\uFF1A;\uFF1B]/.test(sep ?? "") || /\d/.test(tail);
			return secretLike ? `[email]${sep}[redacted]` : `[email]${sep}${tail}`;
		})
		.replace(PASSWORD_RE, (_m, label: string) => `${label}[redacted]`)
		.replace(LONG_TOKEN_RE, (t) => (/[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) ? "[redacted]" : t));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Replace lone surrogate halves (Jev rejects invalid Unicode with HTTP 400). */
export function wellFormed(text: string): string {
	return text.replace(LONE_SURROGATE, "\uFFFD");
}

/** Redact, then keep at most `max` chars without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
	const t = redact(text);
	if (t.length <= max) return wellFormed(t);
	return `${wellFormed(t.slice(0, max))}…`;
}
