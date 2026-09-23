import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("parallel CI covers every root test and typecheck behind validate", async () => {
  const [manifest, workflow] = await Promise.all([
    readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, ".github", "workflows", "ci.yml"), "utf8"),
  ]);
  const commands = [...workflow.matchAll(/^            command: (.+)$/gm)]
    .map((match) => match[1])
    .join(" && ");
  assert.ok(commands, "CI validation slices are required");

  const suites = [...manifest.scripts.test.matchAll(/\bnpm run (test:[\w-]+)/g)]
    .map((match) => match[1]);
  for (const suite of suites) {
    assert.equal(
      [...commands.matchAll(new RegExp(`\\bnpm run ${suite}(?![\\w-])`, "g"))].length,
      1,
      `${suite} must run in exactly one CI validation slice`,
    );
  }

  const workspaces = [
    ...manifest.scripts.typecheck.matchAll(
      /\bnpm run typecheck --workspace (@torsor\/[\w-]+)/g,
    ),
  ].map((match) => match[1]);
  for (const workspace of workspaces) {
    assert.equal(
      commands.split(`npm run typecheck --workspace ${workspace}`).length - 1,
      1,
      `${workspace} typecheck must run in exactly one CI validation slice`,
    );
  }
  assert.match(commands, /\bnpm exec --prefix prototype -- tsc --noEmit -p prototype\/tsconfig\.app\.json\b/);
  assert.match(commands, /\bnpm run build\b/);
  assert.match(workflow, /^  validate:\r?\n    if: always\(\)\r?\n    needs: validation\r?$/m);
  assert.match(workflow, /VALIDATION_RESULT: \$\{\{ needs\.validation\.result \}\}/);
  assert.match(workflow, /run: test "\$VALIDATION_RESULT" = success/);
});
