import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("./check-bilingual-docs.mjs", import.meta.url));
const policies = ["docs/documentation.md", "docs/documentation.zh-cn.md"];
const success = "Bilingual documentation check passed.\n";

// Fixtures exercise docs/documentation.md's executable contract via the public CLI.
function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "torsor-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const pair = (path) => {
    write(path, document(path));
    const other = path.replace(/\.md$/, ".zh-cn.md");
    write(other, document(other));
  };
  const policy = (exclusions = [], chineseExclusions = exclusions) => {
    for (const [index, path] of policies.entries()) {
      write(path, `${document(path)}
<!-- bilingual-exclusions:start -->
\`\`\`json
${JSON.stringify(index === 0 ? exclusions : chineseExclusions, null, 2)}
\`\`\`
<!-- bilingual-exclusions:end -->
`);
    }
  };
  const check = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.error, undefined);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "-m", "Synthetic documentation fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet");
  git("config", "user.name", "Docs Test");
  git("config", "user.email", "docs-test@example.invalid");
  policy();
  return { root, git, write, pair, policy, check, commit };
}

function document(path, body = "Synthetic documentation.\n") {
  const chinese = path.endsWith(".zh-cn.md");
  const other = encodeURIComponent(posix.basename(chinese
    ? path.replace(/\.zh-cn\.md$/, ".md")
    : path.replace(/\.md$/, ".zh-cn.md")));
  const navigation = chinese
    ? `> 简体中文（主要版本） | [English](${other})`
    : `> English | [简体中文](${other})`;
  return `# Sample\n\n${navigation}\n\n${body}`;
}

test("a tracked pair with reciprocal top navigation passes", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  repo.git("add", "--all");
  assert.deepEqual(repo.check(), { status: 0, stdout: success, stderr: "" });
});

test("either missing counterpart reports its exact repository-relative path", (t) => {
  const repo = repository(t);
  repo.write("docs/zeta.md", document("docs/zeta.md"));
  repo.write("docs/alpha.zh-cn.md", document("docs/alpha.zh-cn.md"));
  repo.git("add", "--all");
  assert.deepEqual(repo.check(), {
    status: 1,
    stdout: "",
    stderr: "docs/alpha.zh-cn.md: [missing-counterpart] expected docs/alpha.md\n"
      + "docs/zeta.md: [missing-counterpart] expected docs/zeta.zh-cn.md\n",
  });
});

test("both directions must link to the exact counterpart in top navigation", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  repo.write("guide.md", document("guide.md").replace("(guide.zh-cn.md)", "(wrong.zh-cn.md)"));
  repo.write("guide.zh-cn.md", document("guide.zh-cn.md").replace("(guide.md)", "(wrong.md)"));
  repo.git("add", "--all");
  assert.deepEqual(repo.check(), {
    status: 1,
    stdout: "",
    stderr: "guide.md: [navigation] expected top language navigation to guide.zh-cn.md\n"
      + "guide.zh-cn.md: [navigation] expected top language navigation to guide.md\n",
  });
});

test("body links, examples, images, comments and non-sibling URLs are not navigation", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  repo.git("add", "--all");
  const navigation = "> English | [简体中文](guide.zh-cn.md)";
  for (const content of [
    `# Sample\n\nBody first.\n\n${navigation}`,
    `# Sample\n\n\`\`\`md\n${navigation}\n\`\`\``,
    `# Sample\n\n<!--\n${navigation}\n-->`,
    `# Sample\n\n${navigation.replace("[", "![")}`,
    `# Sample\n\n${navigation.replace("guide.zh-cn.md", "https://example.invalid/guide.zh-cn.md")}`,
    `# Sample\n\n${navigation.replace("guide.zh-cn.md", "guide.zh-cn.md#section")}`,
    `# Sample\n\n${navigation.replace("guide.zh-cn.md", "guide.zh-cn.md?locale=zh")}`,
    `# Sample\n\n${navigation.replace("(guide.zh-cn.md)", "[translation]")}\n\n[translation]: guide.zh-cn.md`,
    `\`\`\`md\n# Sample\n\n${navigation}\n\`\`\``,
    `# Sample <!--\n\n${navigation}\n-->`,
    `    # Sample\n\n    ${navigation}`,
  ]) {
    repo.write("guide.md", content);
    assert.deepEqual(repo.check(), {
      status: 1,
      stdout: "",
      stderr: "guide.md: [navigation] expected top language navigation to guide.zh-cn.md\n",
    });
  }
});

test("existing navigation variants, BOM, CRLF and encoded sibling paths pass", (t) => {
  const repo = repository(t);
  repo.pair("docs/sample notes.md");
  repo.write("docs/sample notes.md",
    "\uFEFF# Sample\r\n\r\n> [简体中文（主要版本）](./sample%20notes.zh-cn.md) | English\r\n");
  repo.write("docs/sample notes.zh-cn.md",
    "# Sample\n\n> 简体中文（主要版本） | [English](./sample%20notes.md)\n");
  repo.git("add", "--all");
  assert.deepEqual(repo.check(), { status: 0, stdout: success, stderr: "" });
});

test("documented exclusions use policy data, not a hard-coded path list", (t) => {
  const repo = repository(t);
  const path = "components/sample/README.md";
  repo.write(path, "# Implementation reference\n");
  repo.policy(
    [{ path, reason: "Synthetic implementation reference." }],
    [{ path, reason: "合成实现参考。" }],
  );
  repo.git("add", "--all");
  assert.deepEqual(repo.check(), { status: 0, stdout: success, stderr: "" });
});

test("exclusion paths must match between both policies", (t) => {
  const repo = repository(t);
  const path = "components/sample/README.md";
  repo.write(path, "# Implementation reference\n");
  repo.policy([{ path, reason: "Synthetic reference." }], []);
  repo.git("add", "--all");
  const result = repo.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/documentation\.md: \[exclusion-mismatch\]/);
});

test("invalid, duplicate, unexplained, stale and paired exclusions fail", (t) => {
  const repo = repository(t);
  repo.write("reference.md", "# Reference\n");
  repo.pair("guide.md");
  repo.git("add", "--all");
  for (const [entries, code] of [
    [[{ path: "../reference.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "/reference.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "docs\\reference.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "docs/../reference.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "**/*.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "guide.zh-cn.md", reason: "Reference." }], "exclusion-path"],
    [[{ path: "reference.md", reason: " " }], "exclusion-reason"],
    [[{ path: "reference.md" }], "exclusion-reason"],
    [[{ path: "missing.md", reason: "Reference." }], "exclusion-stale"],
    [[{ path: "guide.md", reason: "Reference." }], "exclusion-paired"],
    [[{ path: "reference.md", reason: "Reference." }, { path: "reference.md", reason: "Again." }], "exclusion-duplicate"],
    [[null], "exclusion-format"],
    [{ path: "reference.md", reason: "Not an array." }, "exclusion-format"],
  ]) {
    repo.policy(entries);
    const result = repo.check();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`[${code}]`), result.stderr);
  }
});

test("missing, malformed and duplicate exclusion blocks fail explicitly", (t) => {
  const repo = repository(t);
  repo.git("add", "--all");
  for (const content of [
    document(policies[0]),
    `${document(policies[0])}\n<!-- bilingual-exclusions:start -->\n\`\`\`json\ninvalid\n\`\`\`\n<!-- bilingual-exclusions:end -->`,
    `${document(policies[0])}\n<!-- bilingual-exclusions:start -->\n<!-- bilingual-exclusions:start -->`,
  ]) {
    repo.write(policies[0], content);
    const result = repo.check();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docs\/documentation\.md: \[exclusion-(block|format)\]/);
  }
});

test("diff mode includes committed, staged and unstaged net changes in either language", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  const base = repo.commit();
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.write("guide.md", document("guide.md", "Revised English.\n"));
  const unilateral = {
    status: 1, stdout: "",
    stderr: "guide.md: [unilateral-change] counterpart must also change: guide.zh-cn.md\n",
  };
  assert.deepEqual(repo.check("--base", base), unilateral);
  repo.git("add", "--all");
  assert.deepEqual(repo.check("--base", base), unilateral);
  repo.commit();
  assert.deepEqual(repo.check("--base", base), unilateral);
  repo.write("guide.zh-cn.md", document("guide.zh-cn.md", "Revised Chinese.\n"));
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.commit();
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.write("guide.md", document("guide.md"));
  assert.deepEqual(repo.check("--base", base), {
    status: 1, stdout: "",
    stderr: "guide.zh-cn.md: [unilateral-change] counterpart must also change: guide.md\n",
  });
});

test("renames require handling both old and new counterpart paths", (t) => {
  const repo = repository(t);
  repo.pair("old.md");
  const base = repo.commit();
  repo.git("mv", "old.md", "new.md");
  repo.write("new.md", document("new.md"));
  const result = repo.check("--base", base);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new\.md: \[missing-counterpart\] expected new\.zh-cn\.md/);
  assert.match(result.stderr, /new\.md: \[unilateral-change\] counterpart must also change: new\.zh-cn\.md/);
  assert.match(result.stderr, /old\.md: \[unilateral-change\] counterpart must also change: old\.zh-cn\.md/);
  repo.git("mv", "old.zh-cn.md", "new.zh-cn.md");
  repo.write("new.zh-cn.md", document("new.zh-cn.md"));
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.commit();
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
});

test("one-sided deletions fail while paired staged and unstaged deletions pass", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  const base = repo.commit();
  rmSync(join(repo.root, "guide.md"));
  const result = repo.check("--base", base);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /guide\.md: \[unilateral-change\] counterpart must also change: guide\.zh-cn\.md/);
  assert.match(result.stderr, /guide\.zh-cn\.md: \[missing-counterpart\] expected guide\.md/);
  rmSync(join(repo.root, "guide.zh-cn.md"));
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.git("add", "--all");
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.commit();
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
});

test("new pairs require staging; untracked and ignored Markdown are outside scope", (t) => {
  const repo = repository(t);
  const base = repo.commit();
  repo.write("untracked.md", "# Not tracked\n");
  repo.write(".gitignore", "ignored.md\n");
  repo.write("ignored.md", "# Ignored\n");
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.pair("new.md");
  repo.git("add", "new.md");
  const result = repo.check("--base", base);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /new\.md: \[missing-counterpart\] expected new\.zh-cn\.md/);
  assert.match(result.stderr, /new\.md: \[unilateral-change\] counterpart must also change: new\.zh-cn\.md/);
  repo.git("add", "new.zh-cn.md");
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
});

test("exclusions allow unilateral edits, but moves and deletions need updated policy lists", (t) => {
  const repo = repository(t);
  repo.write("reference.md", "# Reference\n");
  repo.policy([{ path: "reference.md", reason: "Implementation reference." }]);
  const base = repo.commit();
  repo.write("reference.md", "# Revised reference\n");
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.git("mv", "reference.md", "moved.md");
  assert.match(repo.check("--base", base).stderr, /\[exclusion-stale\]/);
  repo.policy([{ path: "moved.md", reason: "Moved implementation reference." }]);
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  rmSync(join(repo.root, "moved.md"));
  assert.match(repo.check("--base", base).stderr, /\[exclusion-stale\]/);
  repo.policy();
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
});

test("a new exclusion cannot retroactively waive a normative base document", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  const base = repo.commit();
  repo.policy([{ path: "guide.md", reason: "Reclassified as implementation reference." }]);
  repo.git("rm", "--quiet", "guide.zh-cn.md");
  assert.deepEqual(repo.check("--base", base), {
    status: 1, stdout: "",
    stderr: "guide.zh-cn.md: [unilateral-change] counterpart must also change: guide.md\n",
  });
  repo.write("guide.md", "# Implementation reference\n");
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
});

test("diff mode compares with the merge base, not an independently advanced base tip", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  const base = repo.commit();
  repo.git("checkout", "--quiet", "-b", "topic");
  repo.write("guide.md", document("guide.md", "Revised English.\n"));
  repo.write("guide.zh-cn.md", document("guide.zh-cn.md", "Revised Chinese.\n"));
  repo.commit();
  repo.git("checkout", "--quiet", "-b", "base-tip", base);
  repo.write("guide.zh-cn.md", document("guide.zh-cn.md", "Revised Chinese.\n"));
  repo.commit();
  repo.git("checkout", "--quiet", "topic");
  assert.deepEqual(repo.check("--base", "base-tip"), { status: 0, stdout: success, stderr: "" });
});

test("legacy bases allow rollout without silently granting base-side exclusions", (t) => {
  const repo = repository(t);
  for (const path of policies) repo.write(path, document(path));
  repo.write("reference.md", "# Legacy reference\n");
  const base = repo.commit();
  repo.policy([{ path: "reference.md", reason: "Implementation reference." }]);
  assert.deepEqual(repo.check("--base", base), { status: 0, stdout: success, stderr: "" });
  repo.write("reference.md", "# Revised reference\n");
  assert.deepEqual(repo.check("--base", base), {
    status: 1, stdout: "",
    stderr: "reference.md: [unilateral-change] counterpart must also change: reference.zh-cn.md\n",
  });
});

test("invalid refs and CLI arguments fail without machine-specific paths", (t) => {
  const repo = repository(t);
  repo.commit();
  assert.deepEqual(repo.check("--base", "missing-ref"), {
    status: 2, stdout: "",
    stderr: ".: [git] cannot resolve --base to a commit; fetch the required history\n",
  });
  for (const args of [["--base"], ["--base", "--help"], ["--base", ""], ["--unknown"], ["--base", "HEAD", "--base", "HEAD"]]) {
    assert.deepEqual(repo.check(...args), {
      status: 2, stdout: "",
      stderr: ".: [usage] Usage: npm run check:docs [-- --base <git-ref>]\n",
    });
  }
  assert.deepEqual(repo.check("--help"), {
    status: 0,
    stdout: "Usage: npm run check:docs [-- --base <git-ref>]\n",
    stderr: "",
  });
});

test("tracked symlink modes cannot masquerade as regular excluded files", (t) => {
  const repo = repository(t);
  repo.write("reference.md", "# Reference\n");
  repo.policy([{ path: "reference.md", reason: "Implementation reference." }]);
  repo.git("add", "--all");
  const blob = repo.git("hash-object", "-w", "--", "reference.md");
  repo.git("update-index", "--add", "--cacheinfo", `120000,${blob},reference.md`);
  assert.deepEqual(repo.check(), {
    status: 1, stdout: "",
    stderr: "reference.md: [file-type] expected a regular file, not a symbolic link or directory\n",
  });
});

test("directories replacing tracked Markdown are reported rather than read", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  repo.git("add", "--all");
  rmSync(join(repo.root, "guide.md"));
  mkdirSync(join(repo.root, "guide.md"));
  assert.deepEqual(repo.check(), {
    status: 1, stdout: "",
    stderr: "guide.md: [file-type] expected a regular file, not a symbolic link or directory\n",
  });
});

test("path diagnostics preserve spaces, Unicode and case without machine paths", (t) => {
  const repo = repository(t);
  repo.write("docs/样例 notes.md", document("docs/样例 notes.md"));
  repo.write("Guide.md", document("Guide.md"));
  repo.write("guide.zh-cn.md", document("guide.zh-cn.md"));
  repo.git("add", "--all");
  const expected = {
    status: 1, stdout: "",
    stderr: "Guide.md: [missing-counterpart] expected Guide.zh-cn.md\n"
      + "docs/样例 notes.md: [missing-counterpart] expected docs/样例 notes.zh-cn.md\n"
      + "guide.zh-cn.md: [missing-counterpart] expected guide.md\n",
  };
  assert.deepEqual(repo.check(), expected);
  const nested = spawnSync(process.execPath, [cli], { cwd: join(repo.root, "docs"), encoding: "utf8" });
  assert.equal(nested.status, expected.status);
  assert.equal(nested.stderr, expected.stderr);
});

test("ambiguous merge bases fail instead of choosing an arbitrary comparison", (t) => {
  const repo = repository(t);
  const base = repo.commit();
  const tree = repo.git("rev-parse", "HEAD^{tree}");
  const left = repo.git("commit-tree", tree, "-p", base, "-m", "Synthetic left");
  const right = repo.git("commit-tree", tree, "-p", base, "-m", "Synthetic right");
  const firstMerge = repo.git("commit-tree", tree, "-p", left, "-p", right, "-m", "Synthetic first merge");
  const secondMerge = repo.git("commit-tree", tree, "-p", right, "-p", left, "-m", "Synthetic second merge");
  repo.git("update-ref", "HEAD", firstMerge);
  assert.deepEqual(repo.check("--base", secondMerge), {
    status: 2, stdout: "",
    stderr: ".: [git] expected a unique merge base with HEAD\n",
  });
});

test("missing ancestry fails instead of skipping diff checks", (t) => {
  const repo = repository(t);
  const base = repo.commit();
  repo.pair("guide.md");
  const head = repo.commit();
  repo.write(".git/shallow", `${head}\n`);
  assert.deepEqual(repo.check("--base", base), {
    status: 2, stdout: "",
    stderr: ".: [git] cannot find merge base with HEAD; fetch the required history\n",
  });
});

test("unresolved index conflicts fail explicitly", (t) => {
  const repo = repository(t);
  repo.pair("guide.md");
  repo.commit();
  const blob = repo.git("rev-parse", "HEAD:guide.md");
  const conflict = spawnSync("git", ["update-index", "--index-info"], {
    cwd: repo.root,
    encoding: "utf8",
    input: `0 ${"0".repeat(blob.length)}\tguide.md\n100644 ${blob} 1\tguide.md\n100644 ${blob} 2\tguide.md\n`,
  });
  assert.equal(conflict.status, 0, conflict.stderr);
  assert.deepEqual(repo.check(), {
    status: 2, stdout: "",
    stderr: ".: [git] resolve index conflicts before checking documentation\n",
  });
});

test("malformed base policy cannot be treated as a legacy exemption", (t) => {
  const repo = repository(t);
  repo.write(policies[0], `${document(policies[0])}\n<!-- bilingual-exclusions:start -->\n`);
  const base = repo.commit();
  repo.policy();
  const result = repo.check("--base", base);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/documentation\.md: \[exclusion-block\] base policy:/);
});
