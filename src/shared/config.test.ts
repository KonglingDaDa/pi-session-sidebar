import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adviceModel, defaultSummaryModel } from "./models.ts";
import { allowedJevUrl, askJev, DEFAULT_JEV_URL, resolveEndpoint } from "./jev-client.ts";

const variables = ["PI_CODING_AGENT_DIR", "PI_SIDEBAR_SUMMARY_PROVIDER", "PI_SIDEBAR_SUMMARY_MODEL", "PI_SIDEBAR_ADVICE_PROVIDER", "PI_SIDEBAR_ADVICE_MODEL"] as const;

test("public model defaults, JSON configuration, and explicit advice override work without local paths", () => {
  const before = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  const directory = mkdtempSync(join(tmpdir(), "pi-sidebar-models-"));
  try {
    for (const key of variables) delete process.env[key];
    process.env.PI_CODING_AGENT_DIR = directory;
    assert.deepEqual(defaultSummaryModel(), { provider: "google", model: "gemini-2.5-flash" });
    assert.deepEqual(adviceModel(), defaultSummaryModel());
    process.env.PI_SIDEBAR_SUMMARY_PROVIDER = "fixture-provider";
    process.env.PI_SIDEBAR_SUMMARY_MODEL = "fixture-summary";
    assert.deepEqual(adviceModel(), { provider: "fixture-provider", model: "fixture-summary" });
    writeFileSync(join(directory, "session-timeline.json"), JSON.stringify({ summary: { provider: "configured", model: "configured-model" } }));
    assert.deepEqual(adviceModel(), { provider: "configured", model: "configured-model" });
    process.env.PI_SIDEBAR_ADVICE_PROVIDER = "advice-provider";
    process.env.PI_SIDEBAR_ADVICE_MODEL = "advice-model";
    assert.deepEqual(adviceModel(), { provider: "advice-provider", model: "advice-model" });
  } finally {
    for (const key of variables) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Jev works with the official API or a loopback override, without a mandatory local gateway", async () => {
  assert.equal(DEFAULT_JEV_URL, "https://api.typesafe.ai/v1/systemone");
  assert.deepEqual(resolveEndpoint(DEFAULT_JEV_URL, {}, {}), { key: undefined, url: DEFAULT_JEV_URL });
  const endpoint = resolveEndpoint(DEFAULT_JEV_URL, { TYPESAFE_API_KEY: "test-key", SYSTEMONE_ENDPOINT: "http://127.0.0.1:12345/v1/systemone" }, {});
  assert.equal(endpoint.url, "http://127.0.0.1:12345/v1/systemone");
  for (const url of ["http://example.com/v1/systemone", "https://api.typesafe.ai/v1/systemone?debug=1", "https://user:pass@api.typesafe.ai/v1/systemone"]) assert.equal(allowedJevUrl(url), undefined);
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), endpoint.url);
      const request = JSON.parse(String(options?.body));
      assert.equal(request.model, "jev-latest");
      assert.equal(request.state.text, "password=[redacted]");
      return new Response(JSON.stringify({ answers: { progress: { score: 2.5, confidence: 0.8 } }, usage: { input_tokens: 12 } }));
    };
    const reply = await askJev(endpoint, "jev-latest", { text: "password=example-password" }, { progress: { type: "score", criteria: ["incomplete", "complete"] } }, 1000);
    assert.equal((reply.answers.progress as { score: number }).score, 2.5);
    assert.equal(reply.inputTokens, 12);
  } finally { globalThis.fetch = previous; }
});
