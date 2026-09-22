import { LocalArtifactStorage, TorsorKernel } from "../../dist/index.js";

const [databasePath, root, mode, inputJson, contextJson] = process.argv.slice(2);
const local = await LocalArtifactStorage.open(root);
const kernel = TorsorKernel.open({
  databasePath,
  artifactStorage: {
    read: local.read.bind(local),
    async put(digest, content) {
      await local.put(digest, content);
      if (mode === "stored") process.exit(77);
    },
  },
});
globalThis[Symbol.for("torsor.kernel.command-before-commit")] = ({ commandType }) => {
  if (mode === "transaction" && commandType === "PublishArtifact") process.exit(77);
};
const input = JSON.parse(inputJson);
await kernel.finalizeReport(
  { ...input, content: Buffer.from(input.content, "utf8") },
  JSON.parse(contextJson),
);
// Simulate losing the response, without closing the Kernel connection.
process.exit(77);
