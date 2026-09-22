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

export interface LockObservation {
  readonly observedAt: number;
  readonly alive: readonly boolean[];
  readonly stopRequestedAt: readonly number[];
}

export async function observeLockedChildren(
  databasePath: string, pids: readonly number[], stops: BigInt64Array,
) {
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync(workerData.databasePath);
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE");
    const lockedAt = Date.now();
    parentPort.postMessage({ type: "locked", lockedAt });
    const observe = setTimeout(() => {
      parentPort.postMessage({
        type: "observation", observedAt: Date.now(),
        alive: workerData.pids.map((pid) => {
          try { process.kill(pid, 0); return true; }
          catch (error) { if (error.code === "ESRCH") return false; throw error; }
        }),
        stopRequestedAt: workerData.pids.map((_, index) => Number(Atomics.load(workerData.stops, index))),
      });
    }, 1800);
    const unlock = () => {
      clearTimeout(observe);
      clearTimeout(deadline);
      database.exec("ROLLBACK");
      database.close();
      parentPort.close();
    };
    const deadline = setTimeout(unlock, 6500);
    parentPort.once("message", unlock);
  `, { eval: true, workerData: { databasePath, pids, stops } });
  const released = new Promise<void>((resolve, reject) => {
    worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Observer exited: ${code}`)));
    worker.once("error", reject);
  });
  const observation = new Promise<LockObservation>((resolve, reject) => {
    worker.on("message", (message) => { if (message.type === "observation") resolve(message); });
    worker.once("error", reject);
  });
  const lockedAt = await new Promise<number>((resolve, reject) => {
    worker.on("message", (message) => { if (message.type === "locked") resolve(message.lockedAt); });
    worker.once("error", reject);
  });
  return {
    lockedAt, observation, released,
    async release() { worker.postMessage("release"); await released; },
  };
}
