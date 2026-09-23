import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import type { PhysicalWorktreeBinding } from "@torsor/kernel";

export interface WorktreeRegistration {
  readonly worktreeId: string;
  readonly runId: string;
  readonly directoryName: string;
  readonly baseRevision: string;
}

export function canonicalDirectory(path: string): { path: string; identity: string } {
  const absolute = resolve(path);
  let component = parse(absolute).root;
  for (const name of absolute.slice(component.length).split(sep).filter(Boolean)) {
    component = join(component, name);
    const stat = lstatSync(component, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Worktree directory components must be real directories, not links.");
    }
  }
  const canonical = pathKey(realpathSync.native(absolute));
  if (canonical !== pathKey(absolute)) {
    throw new Error("Worktree path aliases are not supported.");
  }
  const stat = lstatSync(canonical, { bigint: true });
  return { path: canonical, identity: `${stat.dev}:${stat.ino}` };
}

export function readPlainFile(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4096n) {
    throw new Error("Expected a small, unlinked regular metadata file.");
  }
  return readFileSync(path, "utf8").trim();
}

export function inspectWorktree(
  rootPath: string, repositoryPath: string, input: WorktreeRegistration,
): PhysicalWorktreeBinding {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.directoryName)) {
    throw new Error("Worktree directoryName must be one safe path component.");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseRevision)) {
    throw new Error("Worktree base must be a full immutable commit ID.");
  }
  const root = canonicalDirectory(rootPath);
  const repository = canonicalDirectory(repositoryPath);
  const directory = canonicalDirectory(join(root.path, input.directoryName));
  if (dirname(directory.path) !== root.path || isWithin(repository.path, directory.path)) {
    throw new Error("Managed Worktrees must be outside the source repository.");
  }
  const common = canonicalDirectory(join(repository.path, ".git"));
  const gitFile = join(directory.path, ".git");
  const link = readPlainFile(gitFile);
  if (!link.startsWith("gitdir: ")) throw new Error("Expected a linked detached Git worktree.");
  const admin = canonicalDirectory(resolve(directory.path, link.slice(8)));
  if (dirname(admin.path) !== pathKey(join(common.path, "worktrees"))) {
    throw new Error("Git worktree belongs to another repository.");
  }
  const commonTarget = canonicalDirectory(resolve(admin.path, readPlainFile(join(admin.path, "commondir"))));
  if (commonTarget.path !== common.path ||
      pathKey(resolve(admin.path, readPlainFile(join(admin.path, "gitdir")))) !== pathKey(gitFile) ||
      readPlainFile(join(admin.path, "HEAD")) !== input.baseRevision) {
    throw new Error("Git worktree identity or detached base revision changed.");
  }
  return {
    worktreeId: input.worktreeId, runId: input.runId,
    repositoryId: createHash("sha256").update(`${common.path}\n${common.identity}`).digest("hex"),
    repositoryPath: repository.path, baseRevision: input.baseRevision,
    directoryPath: directory.path, directoryIdentity: directory.identity,
  };
}

export function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isWithin(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest === "" || (!isAbsolute(rest) && rest !== ".." && !rest.startsWith(`..${sep}`));
}
