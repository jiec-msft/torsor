import {
  copyFile,
  cp,
  mkdir,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const loggingRoot = join(packageRoot, "..", "operational-logging");
const nodeModules = join(packageRoot, "node_modules");
const scopeDirectory = join(nodeModules, "@torsor");
const target = join(scopeDirectory, "operational-logging");

const mode = process.argv[2];
if (mode === "prepare") {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const manifest = JSON.parse(
    await readFile(join(loggingRoot, "package.json"), "utf8"),
  );
  await writeFile(
    join(target, "package.json"),
    `${JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      license: manifest.license,
      type: manifest.type,
      main: manifest.main,
      types: manifest.types,
      exports: manifest.exports,
      files: manifest.files,
      engines: manifest.engines,
    }, null, 2)}\n`,
    "utf8",
  );
  await copyFile(join(repositoryRoot, "LICENSE"), join(target, "LICENSE"));
  await cp(join(loggingRoot, "dist"), join(target, "dist"), {
    recursive: true,
  });
} else if (mode === "cleanup") {
  await rm(target, { recursive: true, force: true });
  await rmdir(scopeDirectory).catch(ignoreMissingOrNonempty);
  await rmdir(nodeModules).catch(ignoreMissingOrNonempty);
} else {
  throw new Error("Expected prepare or cleanup mode.");
}

function ignoreMissingOrNonempty(error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTEMPTY")
  ) {
    return;
  }
  throw error;
}
