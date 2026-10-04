/** Bounded timeline context and credential masking. */
/** Head and tail of a long text, so both the question and the end of a pasted log survive. */
export function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = Math.ceil(max * 0.65);
  const tail = max - head;
  return `${t.slice(0, head)}\n…[${t.length - max} chars omitted]…\n${t.slice(t.length - tail)}`;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[redacted]"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted-token]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
  [/((?:api[_-]?key|access[_-]?token|secret|password|passwd|密码|口令)\s*[:=：]\s*)[^\s,;，；]{6,}/gi, "$1[redacted]"],
];

/** Mask key-like strings; the rest of the text is left as is. */
export function redact(text: string): string {
  let t = text;
  for (const [re, rep] of SECRET_PATTERNS) t = t.replace(re, rep);
  return t;
}
