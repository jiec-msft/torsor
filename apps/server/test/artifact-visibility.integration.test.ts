import { afterEach, describe, expect, it } from "vitest";
import { artifactHttpFixture, readSseUntil } from "./fixtures/artifact-scope.js";

const fixtures: Awaited<ReturnType<typeof artifactHttpFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function setup(equalBytes = false) {
  const fixture = await artifactHttpFixture(equalBytes);
  fixtures.push(fixture);
  return fixture;
}

async function get(origin: string, path: string, token?: string) {
  return fetch(`${origin}/api/v1/${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function refusal(response: Response) {
  const body = await response.json() as { error: { requestId: string; code: string; message: string } };
  expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
  expect(body.error.requestId).toMatch(/^[\da-f-]{36}$/);
  const { requestId: _requestId, ...error } = body.error;
  const headers = Object.fromEntries([...response.headers].filter(([name]) =>
    !["date", "connection", "keep-alive", "x-request-id"].includes(name),
  ));
  return { status: response.status, headers, error };
}

describe("Artifact HTTP/SSE visibility (MVP 23.2, 35.3)", () => {
  it.each([true, false])("makes random and same-Thread foreign IDs indistinguishable with equal bytes = %s", async (equal) => {
    const f = await setup(equal);
    for (const owned of f.reports) {
      for (const suffix of ["", "/content"]) {
        const absent = await refusal(await get(f.origin, `artifacts/random-absent${suffix}`, owned.token));
        expect(absent).toMatchObject({
          status: 404, error: { code: "not_found", message: "The Artifact was not found." },
          headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
        });
        for (const foreign of [...f.reports, f.foreignProject].filter((report) => report !== owned)) {
          expect(await refusal(await get(f.origin, `artifacts/${foreign.artifact.id}${suffix}`, owned.token))).toEqual(absent);
        }
        expect(f.reads).toBe(0);
      }
      const current = await get(f.origin, `threads/${f.scopes.threadId}`, owned.token);
      expect((await current.json()).thread.artifacts).toEqual([owned.artifact]);
      const history = await get(f.origin, `channels/channel-general/threads?projectId=project-sample&snapshot=${f.end}&limit=1`, owned.token);
      expect((await history.json()).items[0].artifacts).toEqual([owned.artifact]);
      const old = await get(f.origin, `channels/channel-general/threads?projectId=project-sample&snapshot=${f.before}`, owned.token);
      expect((await old.json()).items[0].artifacts).toEqual([]);
      const runs = await get(f.origin, `projects/project-sample/runs?snapshot=${f.end}`, owned.token);
      const runItems = (await runs.json()).items;
      expect(runItems).toHaveLength(1);
      expect(runItems[0].artifacts).toEqual([owned.artifact]);
    }
    for (const suffix of ["", "/content"]) {
      const absent = await refusal(await get(f.origin, `artifacts/random-absent${suffix}`, f.foreignProject.token));
      expect(absent.status).toBe(404);
      for (const foreign of f.reports) {
        expect(await refusal(await get(f.origin, `artifacts/${foreign.artifact.id}${suffix}`, f.foreignProject.token))).toEqual(absent);
      }
    }
    expect(f.reads).toBe(0);
    for (const token of ["synthetic-human", "synthetic-runtime"]) {
      expect((await (await get(f.origin, `threads/${f.scopes.threadId}`, token)).json()).thread.artifacts).toHaveLength(4);
      for (const report of [...f.reports, f.foreignProject]) {
        expect(await (await get(f.origin, `artifacts/${report.artifact.id}`, token)).json()).toEqual({ artifact: report.artifact });
        const content = await get(f.origin, `artifacts/${report.artifact.id}/content`, token);
        expect(content.status).toBe(200);
        expect(await content.text()).toBe(report.content.toString());
      }
      expect((await get(f.origin, "artifacts/random-absent", token)).status).toBe(404);
    }
  });

  it.each(["expired", "revoked", "missing-activation", "unauthenticated"] as const)(
    "chooses deterministic %s errors before descriptor/content existence",
    async (state) => {
      const f = await setup();
      const parent = f.reports[0]!;
      if (state === "expired") f.expire();
      if (state === "revoked") await f.kernel.execute({
        type: "CancelRun", idempotencyKey: "revoke", runId: parent.run.runId,
        expectedRunRevision: 1, reason: "Synthetic revocation.",
      }, { principalId: "principal-human" });
      const token = state === "unauthenticated" ? undefined
        : state === "missing-activation" ? "synthetic-unscoped" : parent.token;
      const expectedStatus = state === "expired" || state === "revoked" ? 409 : 401;
      const absent = await refusal(await get(f.origin, "artifacts/random-absent", token));
      expect(absent.status).toBe(expectedStatus);
      for (const id of ["random-absent", ...[...f.reports, f.foreignProject].map((report) => report.artifact.id)]) {
        for (const suffix of ["", "/content"]) {
          expect(await refusal(await get(f.origin, `artifacts/${id}${suffix}`, token))).toEqual(absent);
        }
      }
      expect(f.reads).toBe(0);
    },
  );

  it.each([true, false])("advances filtered SSE tails and reconnects without replaying foreign reports (equal bytes = %s)", async (equal) => {
    const f = await setup(equal);
    for (const owned of f.reports) {
      const frames = await readSseUntil(f.origin, owned.token, f.before, (frames) =>
        frames.some((frame) => frame.includes(`id: ${f.end}\n`)),
      );
      const events = frames.filter((frame) => frame.includes("event: torsor")).map((frame) =>
        JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)),
      );
      expect(events.map((event) => event.entityId)).toEqual([owned.artifact.id]);
      const last = frames.find((frame) => frame.includes(`id: ${f.end}\n`))!;
      if (owned !== f.reports.at(-1)) {
        expect(last).toBe(`id: ${f.end}\nevent: checkpoint\ndata: ${JSON.stringify({ cursor: f.end })}`);
      }
      for (const foreign of f.reports.filter((report) => report !== owned)) {
        expect(frames.join("\n")).not.toContain(foreign.artifact.id);
        if (!equal) expect(frames.join("\n")).not.toContain(foreign.artifact.contentDigest);
      }
      const reconnected = await readSseUntil(f.origin, owned.token, f.before,
        (frames) => frames.some((frame) => frame.startsWith(": heartbeat")), f.end!);
      expect(reconnected.every((frame) => frame.startsWith(": heartbeat"))).toBe(true);
    }
    const human = await readSseUntil(f.origin, "synthetic-human", f.before, (frames) =>
      frames.some((frame) => frame.includes(`id: ${f.end}\n`)),
    );
    expect(human.filter((frame) => frame.includes("event: torsor"))).toHaveLength(4);
  });
});
