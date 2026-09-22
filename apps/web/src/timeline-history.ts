import type { ActivityEvent, RunProjection } from "./types.js";

export type ActivityWindow = RunProjection["activity"];

export interface ActivityPage {
  readonly items: readonly ActivityEvent[];
  readonly hasMore: boolean;
  readonly nextCursor: number | null;
}

export function activityPath(
  runId: string,
  beforeSequence: number,
  afterSequence?: number,
): string {
  const query = new URLSearchParams({
    beforeSequence: String(beforeSequence),
    limit: "100",
  });
  if (afterSequence !== undefined) {
    query.set("afterSequence", String(afterSequence));
  }
  return `/api/v1/runs/${encodeURIComponent(runId)}/activity?${query}`;
}

export function mergeActivity(
  runId: string,
  windows: readonly ActivityWindow[],
): ActivityWindow {
  const byId = new Map<string, ActivityEvent>();
  const bySequence = new Map<number, string>();
  let earliest: ActivityWindow | undefined;
  for (const window of windows) {
    if (window.earliestSequence !== null &&
      (!earliest || window.earliestSequence < earliest.earliestSequence!)) {
      earliest = window;
    }
    for (const item of window.items) {
      if (item.runId !== runId ||
        (byId.has(item.id) && byId.get(item.id)!.sequence !== item.sequence) ||
        (bySequence.has(item.sequence) && bySequence.get(item.sequence) !== item.id)) {
        throw new Error("Inconsistent Run activity identity.");
      }
      byId.set(item.id, item);
      bySequence.set(item.sequence, item.id);
    }
  }
  const items = [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  return {
    items,
    hasEarlier: earliest?.hasEarlier ?? false,
    earliestSequence: items[0]?.sequence ?? null,
    latestSequence: items.at(-1)?.sequence ?? null,
  };
}

export function historyWindow(page: ActivityPage): ActivityWindow {
  return {
    items: page.items,
    hasEarlier: page.hasMore,
    earliestSequence: page.items[0]?.sequence ?? null,
    latestSequence: page.items.at(-1)?.sequence ?? null,
  };
}

export function mergeRunTimeline(
  current: RunProjection | null,
  incoming: RunProjection,
): RunProjection {
  const previous = current?.run.id === incoming.run.id ? current : null;
  return {
    ...(previous && previous.run.revision > incoming.run.revision ? previous : incoming),
    activity: mergeActivity(incoming.run.id, [
      ...(previous ? [previous.activity] : []),
      incoming.activity,
    ]),
  };
}

export function validateActivityPage(
  page: ActivityPage,
  runId: string,
  before: number,
  after?: number,
): void {
  let previous = after ?? 0;
  if (page.items.length > 100) {
    throw new Error("Activity page exceeded its requested limit.");
  }
  for (const item of page.items) {
    if (item.runId !== runId || !Number.isSafeInteger(item.sequence) ||
      item.sequence <= previous || item.sequence >= before) {
      throw new Error("Activity page has invalid sequence bounds.");
    }
    previous = item.sequence;
  }
  const cursor = after === undefined
    ? page.items[0]?.sequence
    : page.items.at(-1)?.sequence;
  if (page.hasMore && (cursor === undefined || page.nextCursor !== cursor)) {
    throw new Error("Activity page did not advance its cursor.");
  }
}

// Capture the upper boundary once: reconnect must not chase a growing stream.
export async function readActivityGap(
  runId: string,
  previous: ActivityWindow | undefined,
  next: ActivityWindow,
  read: (path: string) => Promise<ActivityPage>,
  isCurrent: () => boolean,
): Promise<readonly ActivityEvent[]> {
  const items: ActivityEvent[] = [];
  if (!previous || next.earliestSequence === null) {
    return items;
  }
  let after = previous.latestSequence ?? 0;
  const before = next.earliestSequence;
  while (after + 1 < before && isCurrent()) {
    const page = await read(activityPath(runId, before, after));
    validateActivityPage(page, runId, before, after);
    items.push(...page.items);
    if (!page.hasMore) {
      break;
    }
    after = page.nextCursor!;
  }
  return items;
}
