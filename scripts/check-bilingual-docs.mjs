import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

const usage = "Usage: npm run check:docs [-- --base <git-ref>]\n";
const policies = ["docs/documentation.md", "docs/documentation.zh-cn.md"];
const startMarker = "<!-- bilingual-exclusions:start -->";
const endMarker = "<!-- bilingual-exclusions:end -->";

class CommandError extends Error {}

function git(root, args, failure) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new CommandError(`.: [git] ${failure}`);
  }
  return result.stdout;
}

function paths(output) {
  return output.split("\0").filter((path) => /\.md$/i.test(path)).sort();
}

function counterpart(path) {
  return path.endsWith(".zh-cn.md")
    ? path.replace(/\.zh-cn\.md$/, ".md")
    : path.replace(/\.md$/, ".zh-cn.md");
}

function hasPairName(path) {
  if (!path.endsWith(".md")) return false;
  const english = path.endsWith(".zh-cn.md") ? counterpart(path) : path;
  const stem = posix.basename(english).slice(0, -3);
  return stem.length > 0 && !/\.zh-cn$/i.test(stem)
    && counterpart(counterpart(path)) === path;
}

function workingDocuments(root, report) {
  const tracked = git(root, ["ls-files", "--stage", "-z"], "cannot list tracked files")
    .split("\0").filter(Boolean)
    .map((entry) => ({ mode: entry.slice(0, 6), path: entry.slice(entry.indexOf("\t") + 1) }))
    .filter(({ path }) => /\.md$/i.test(path));
  const documents = new Map();
  for (const { mode, path } of tracked) {
    try {
      const stat = lstatSync(join(root, path));
      if (!stat.isFile() || !["100644", "100755"].includes(mode)) {
        report(path, "file-type", "expected a regular file, not a symbolic link or directory");
        documents.set(path, null);
      } else {
        documents.set(path, readFileSync(join(root, path), "utf8"));
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new CommandError(`${path}: [read] cannot read tracked file`);
      }
      // A working-tree deletion is absent even before it is staged.
    }
  }
  return documents;
}

function exclusionList(content, path, files, report) {
  const text = (content ?? "").replace(/\r\n/g, "\n");
  const block = text.match(/^<!-- bilingual-exclusions:start -->\n```json\n([\s\S]*?)\n```\n<!-- bilingual-exclusions:end -->$/m);
  if (!block || text.split(startMarker).length !== 2 || text.split(endMarker).length !== 2) {
    report(path, "exclusion-block", "expected exactly one marked JSON exclusion block");
    return new Set();
  }
  let entries;
  try {
    entries = JSON.parse(block[1]);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    report(path, "exclusion-format", "exclusions must be a JSON array of path/reason objects");
    return new Set();
  }
  if (!Array.isArray(entries)) {
    report(path, "exclusion-format", "exclusions must be a JSON array of path/reason objects");
    return new Set();
  }
  const result = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      report(path, "exclusion-format", `entry ${index + 1} must be a path/reason object`);
      continue;
    }
    const excluded = entry.path;
    if (typeof excluded !== "string" || !hasPairName(excluded)
      || excluded.endsWith(".zh-cn.md") || excluded.startsWith("/")
      || excluded.trim() !== excluded || /[\\:*?[\]{}\x00-\x1f\x7f]/.test(excluded)
      || posix.normalize(excluded) !== excluded || excluded.split("/").includes("..")) {
      report(path, "exclusion-path", `entry ${index + 1} must name an exact repository-relative English .md path`);
      continue;
    }
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      report(path, "exclusion-reason", `a nonempty reason is required for ${excluded}`);
    }
    if (result.has(excluded)) {
      report(path, "exclusion-duplicate", `duplicate path ${excluded}`);
    }
    result.add(excluded);
    if (!files.has(excluded)) {
      report(path, "exclusion-stale", `excluded file does not exist: ${excluded}`);
    }
    if (files.has(counterpart(excluded))) {
      report(path, "exclusion-paired", `excluded file already has a counterpart: ${excluded}`);
    }
  }
  return result;
}

function exclusions(documents, files, report) {
  const lists = policies.map((path) => exclusionList(documents.get(path), path, files, report));
  if (JSON.stringify([...lists[0]].sort()) !== JSON.stringify([...lists[1]].sort())) {
    report(policies[0], "exclusion-mismatch", `paths must match ${policies[1]}`);
  }
  return new Set([...lists[0]].filter((path) => lists[1].has(path)));
}

function checkNavigation(content, path, report) {
  const fail = () => report(path, "navigation", `expected top language navigation to ${counterpart(path)}`);
  const [title, navigation] = content.replace(/^\uFEFF/, "").split(/\r?\n/)
    .map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!/^# \S/.test(title ?? "") || title.includes("<!--")) return fail();
  const pattern = path.endsWith(".zh-cn.md")
    ? /^> 简体中文（主要版本） \| \[English\]\(([^()\s]+)\)$/
    : /^> (?:English \| \[简体中文\]\(([^()\s]+)\)|\[简体中文（主要版本）\]\(([^()\s]+)\) \| English)$/;
  const match = (navigation ?? "").match(pattern);
  if (!match) return fail();
  const target = (match[1] ?? match[2]).replace(/^\.\//, "");
  if (target.includes("&")) {
    return report(path, "navigation-encoding", "raw & is not allowed; encode a literal & as %26 in the sibling filename");
  }
  if (!/^(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$/.test(target)) return fail();
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return fail();
  }
  if (/[/\\\x00-\x1f\x7f]/.test(decoded) || decoded !== posix.basename(counterpart(path))) {
    fail();
  }
}

function checkChanges(root, ref, documents, excluded, report) {
  const commit = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    "cannot resolve --base to a commit; fetch the required history").trim();
  const bases = git(root, ["merge-base", "--all", commit, "HEAD"],
    "cannot find merge base with HEAD; fetch the required history").trim().split("\n");
  if (bases.length !== 1) {
    throw new CommandError(".: [git] expected a unique merge base with HEAD");
  }
  const base = bases[0];
  const baseFiles = new Set(paths(git(root, ["ls-tree", "-r", "--name-only", "-z", base],
    "cannot list base files")));
  const basePolicies = new Map(policies.filter((path) => baseFiles.has(path))
    .map((path) => [path, git(root, ["show", `${base}:${path}`], `cannot read base policy ${path}`)]));
  // Pre-contract bases have no machine-readable exemptions; never infer them from current policy.
  const legacy = policies.every((path) => {
    const text = basePolicies.get(path) ?? "";
    return !text.includes(startMarker) && !text.includes(endMarker);
  });
  const baseExcluded = legacy ? new Set() : exclusions(basePolicies, baseFiles,
    (path, code, message) => report(path, code, `base policy: ${message}`));
  // Disable rename heuristics so both old and new paths must satisfy the same pairing rule.
  const changed = new Set(paths(git(root,
    ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, "--"],
    "cannot compare working tree with merge base")));
  for (const path of changed) {
    // Current invalid names are diagnosed separately; deleted invalid names have no valid mapping.
    if (!hasPairName(path)) continue;
    const required = (baseFiles.has(path) && !baseExcluded.has(path))
      || (documents.has(path) && !excluded.has(path));
    if (required && !changed.has(counterpart(path))) {
      report(path, "unilateral-change", `counterpart must also change: ${counterpart(path)}`);
    }
  }
}

function main(args) {
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(usage);
    return 0;
  }
  if (args.length !== 0 && !(args.length === 2 && args[0] === "--base"
    && args[1] && !args[1].startsWith("-"))) {
    throw new CommandError(`.: [usage] ${usage.trim()}`);
  }
  const root = git(process.cwd(), ["rev-parse", "--show-toplevel"], "run inside a Git repository").trim();
  if (git(root, ["ls-files", "--unmerged", "-z"], "cannot inspect index conflicts")) {
    throw new CommandError(".: [git] resolve index conflicts before checking documentation");
  }
  const diagnostics = new Set();
  const report = (path, code, message) => diagnostics.add(`${path}: [${code}] ${message}`);
  const documents = workingDocuments(root, report);
  const excluded = exclusions(documents, documents, report);
  for (const [path, content] of documents) {
    if (!hasPairName(path)) {
      report(path, "document-name", "use a nonempty English stem with .md or one lowercase .zh-cn.md suffix; rename this file and its counterpart");
      continue;
    }
    if (excluded.has(path)) continue;
    const other = counterpart(path);
    if (!documents.has(other)) {
      report(path, "missing-counterpart", `expected ${other}`);
    }
    if (content !== null) checkNavigation(content, path, report);
  }
  if (args.length === 2) {
    checkChanges(root, args[1], documents, excluded, report);
  }
  if (diagnostics.size > 0) {
    process.stderr.write(`${[...diagnostics].sort().join("\n")}\n`);
    return 1;
  }
  process.stdout.write("Bilingual documentation check passed.\n");
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CommandError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
