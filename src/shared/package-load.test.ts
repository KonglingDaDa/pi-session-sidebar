import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const loader = createJiti(import.meta.url, { fsCache: false });
interface LoadedExtension {
  commands: Map<string, unknown>;
  shortcuts: Map<string, unknown>;
  handlers: Map<string, unknown>;
}
const { loadExtensions } = await loader.import<{
  loadExtensions(paths: string[], cwd: string): Promise<{ errors: unknown[]; extensions: LoadedExtension[] }>;
}>(`${hostRoot}/dist/core/extensions/loader.js`);

test("Pi's real loader registers the complete standalone package with no pre-send handler", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-sidebar-load-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const file = resolve(import.meta.dirname, "../index.ts");
    const result = await loadExtensions([file], directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.ok(extension.commands.has("timeline"));
    assert.ok(extension.commands.has("task-assistant"));
    assert.ok(extension.shortcuts.has("alt+s"));
    assert.equal(extension.handlers.has("input"), false);
    assert.ok(extension.handlers.has("agent_settled"));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
