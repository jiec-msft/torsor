import { Worker } from "node:worker_threads";

export async function holdSqliteWriter(databasePath: string): Promise<() => Promise<void>> {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    parentPort.postMessage("locked");
    parentPort.once("message", () => {
      database.exec("ROLLBACK");
      database.close();
      parentPort.close();
    });
  `, { eval: true, workerData: databasePath });
  const exited = new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`SQLite lock worker exited: ${code}`)));
    worker.once("error", reject);
  });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });
  let released = false;
  return async () => {
    if (!released) { released = true; worker.postMessage("release"); }
    await exited;
  };
}
