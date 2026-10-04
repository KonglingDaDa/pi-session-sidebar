import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pack = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
const files = new Set(pack.files.map((file) => file.path));
for (const required of ["README.md", "LICENSE", "package.json", "src/index.ts", "src/timeline/index.ts", "src/advice/index.ts"]) assert.ok(files.has(required), `Missing package resource: ${required}`);
for (const path of files) {
  assert.ok(!/node_modules|\.env|\.jsonl$|calibrate|\.test\.|\.codegraph/.test(path), `Unexpected artifact in package: ${path}`);
  if (!path.endsWith(".ts")) continue;
  const source = readFileSync(resolve(root, path), "utf8");
  assert.ok(!source.includes("/home/desk"), `Machine-specific path: ${path}`);
  for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
    const target = relative(root, resolve(root, dirname(path), match[1]));
    assert.ok(files.has(target), `Unpackaged import: ${path} -> ${target}`);
  }
}

// Check the complete Git source surface as well, printing only filenames on a failure.
// Tests intentionally contain dummy credential strings, so scan runtime sources for literal values.
const secretValue = /(?:["'`]Bearer\s+[A-Za-z0-9._~+/=-]{16,}|["'`](?:github_pat_[A-Za-z0-9_]{35,}|gh[pous]_[A-Za-z0-9]{30,}|jgw_[A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9_-]{30,})["'`]|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/;
const queue = [resolve(root, "src")];
while (queue.length) {
  const directory = queue.pop();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) queue.push(path);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      assert.ok(!secretValue.test(readFileSync(path, "utf8")), `Potential credential in ${relative(root, path)}`);
    }
  }
}
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
assert.equal(manifest.license, "MIT");
assert.ok(existsSync(resolve(root, ".github/workflows/check.yml")));
console.log(`Package content verified: ${files.size} files; all relative imports included; no local paths or credential literals in runtime sources.`);
