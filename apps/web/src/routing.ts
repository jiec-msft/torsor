export type ViewName = "threads" | "activity" | "agents";
export type DetailPanel = "status" | "run";

export interface WindowRoute {
  readonly projectId: string;
  readonly view: ViewName;
  readonly channelId: string | null;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly detailPanel: DetailPanel;
  readonly channelsOpen: boolean;
  readonly detailOpen: boolean;
}

export function readRoute(
  location: Pick<Location, "search"> = window.location,
  defaultProjectId = "project-sample",
): WindowRoute {
  const query = new URLSearchParams(location.search);
  const view = query.get("view");
  const defaultPanels =
    typeof window !== "undefined" && window.innerWidth >= 1100
      ? "channels,detail"
      : "";
  const panels = new Set(
    (query.get("panels") ?? defaultPanels).split(",").filter(Boolean),
  );
  return {
    projectId: query.get("project") || defaultProjectId,
    view: view === "activity" || view === "agents" ? view : "threads",
    channelId: query.get("channel"),
    threadId: query.get("thread"),
    runId: query.get("run"),
    detailPanel: query.get("panel") === "run" ? "run" : "status",
    channelsOpen: panels.has("channels"),
    detailOpen: panels.has("detail"),
  };
}

export function writeRoute(
  route: WindowRoute,
  mode: "push" | "replace" = "push",
): void {
  const query = new URLSearchParams();
  query.set("project", route.projectId);
  if (route.view !== "threads") {
    query.set("view", route.view);
  }
  if (route.channelId) {
    query.set("channel", route.channelId);
  }
  if (route.threadId) {
    query.set("thread", route.threadId);
  }
  if (route.runId) {
    query.set("run", route.runId);
  }
  if (route.detailPanel !== "status") {
    query.set("panel", route.detailPanel);
  }
  const panels = [
    route.channelsOpen ? "channels" : null,
    route.detailOpen ? "detail" : null,
  ].filter(Boolean);
  query.set("panels", panels.join(","));
  const next = `${window.location.pathname}?${query.toString()}${window.location.hash}`;
  window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", next);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
