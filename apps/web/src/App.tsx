import {
  Activity,
  AlertTriangle,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Hash,
  LogOut,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radio,
  RefreshCw,
  Send,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ApiError } from "./api";
import type { WebController, WebState } from "./controller";
import { LiveTimeline } from "./LiveTimeline";
import { RunComposer } from "./RunComposer";
import { RunControls } from "./RunControls";
import {
  readRoute,
  type ViewName,
  type WindowRoute,
  writeRoute,
} from "./routing";
import {
  latestMessageBody,
  latestMessageRevision,
  type Activation,
  type AgentStatus,
  type JsonValue,
  type Message,
  type Run,
  type RunProjection,
  type ThreadProjection,
} from "./types";

const defaultProjectId =
  import.meta.env.VITE_TORSOR_PROJECT_ID ?? "project-sample";

interface ComposerValue {
  readonly draft: string;
  readonly agentId: string;
}

type ComposerValueUpdater = (current: ComposerValue) => ComposerValue;

const emptyComposerValue: ComposerValue = { draft: "", agentId: "" };

export function TorsorApp({ controller }: { readonly controller: WebController }) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [route, setRoute] = useWindowRoute();
  const resumedProject = useRef<string | null>(null);
  const loadedChannel = useRef<string | null>(null);
  const loadedThread = useRef<string | null>(null);
  const loadedRun = useRef<string | null>(null);
  const channelsPanelRef = useRef<HTMLElement>(null);
  const detailPanelRef = useRef<HTMLElement>(null);
  const channelsToggleRef = useRef<HTMLButtonElement>(null);
  const detailToggleRef = useRef<HTMLButtonElement>(null);
  const previousDrawer = useRef<"channels" | "detail" | null>(null);
  const [composerValues, setComposerValues] = useState<
    Readonly<Record<string, ComposerValue>>
  >({});
  const compactPanels = useMediaQuery("(max-width: 1099px)");
  const modalDrawerOpen =
    compactPanels && (route.channelsOpen || route.detailOpen);
  const startComposerKey = `start:${route.projectId}:${route.channelId ?? ""}`;
  const replyComposerKey = `reply:${route.projectId}:${route.threadId ?? ""}`;
  const updateComposer = (
    key: string,
    update: ComposerValueUpdater,
  ): void => {
    setComposerValues((currentValues) => {
      const current = currentValues[key] ?? emptyComposerValue;
      const next = update(current);
      if (
        next.draft === current.draft &&
        next.agentId === current.agentId
      ) {
        return currentValues;
      }
      return { ...currentValues, [key]: next };
    });
  };

  useEffect(() => {
    if (resumedProject.current === route.projectId) {
      return;
    }
    const projectChanged = resumedProject.current !== null;
    resumedProject.current = route.projectId;
    loadedChannel.current = null;
    loadedThread.current = null;
    loadedRun.current = null;
    if (projectChanged) {
      controller.clearThread();
      controller.clearRun();
    }
    void controller.resume(route.projectId).catch(() => undefined);
  }, [controller, route.projectId]);

  useEffect(() => {
    if (state.session !== "ready") {
      loadedChannel.current = null;
      loadedThread.current = null;
      loadedRun.current = null;
    }
  }, [state.session]);

  useEffect(() => {
    if (
      state.session !== "ready" ||
      !state.bootstrap ||
      state.bootstrap.project.id !== route.projectId
    ) {
      return;
    }
    const channelId =
      route.channelId &&
      state.bootstrap.channels.some((channel) => channel.id === route.channelId)
        ? route.channelId
        : state.bootstrap.channels[0]?.id ?? null;
    if (channelId && channelId !== route.channelId) {
      updateRoute(setRoute, { ...route, channelId }, "replace");
      return;
    }
    if (channelId && loadedChannel.current !== channelId) {
      loadedChannel.current = channelId;
      void controller.loadThreads(channelId);
    }
  }, [controller, route, setRoute, state.bootstrap, state.session]);

  useEffect(() => {
    if (
      state.session !== "ready" ||
      state.bootstrap?.project.id !== route.projectId ||
      state.loadingThreads ||
      state.threadsChannelId !== route.channelId
    ) {
      return;
    }
    const routeThreadExists =
      route.threadId !== null &&
      state.threads.some((thread) => thread.threadRootId === route.threadId);
    const threadId = routeThreadExists
      ? route.threadId
      : state.threads[0]?.threadRootId ?? null;
    if (threadId === route.threadId) {
      return;
    }
    updateRoute(
      setRoute,
      { ...route, threadId, runId: null, detailPanel: "status" },
      "replace",
    );
  }, [
    route,
    setRoute,
    state.loadingThreads,
    state.bootstrap,
    state.session,
    state.threads,
    state.threadsChannelId,
  ]);

  useEffect(() => {
    if (
      state.session !== "ready" ||
      state.bootstrap?.project.id !== route.projectId
    ) {
      return;
    }
    if (!route.threadId) {
      if (loadedThread.current) {
        loadedThread.current = null;
        controller.clearThread();
      }
      return;
    }
    if (loadedThread.current !== route.threadId) {
      loadedThread.current = route.threadId;
      void controller.loadThread(route.threadId);
    }
  }, [
    controller,
    route.projectId,
    route.threadId,
    state.bootstrap,
    state.session,
  ]);

  useEffect(() => {
    if (
      state.session !== "ready" ||
      state.bootstrap?.project.id !== route.projectId
    ) {
      return;
    }
    if (!route.runId) {
      if (loadedRun.current) {
        loadedRun.current = null;
        controller.clearRun();
      }
      return;
    }
    if (loadedRun.current !== route.runId) {
      loadedRun.current = route.runId;
      void controller.loadRun(route.runId);
    }
  }, [
    controller,
    route.projectId,
    route.runId,
    state.bootstrap,
    state.session,
  ]);

  useEffect(() => {
    if (compactPanels && route.channelsOpen && route.detailOpen) {
      updateRoute(
        setRoute,
        { ...route, detailOpen: false },
        "replace",
      );
    }
  }, [compactPanels, route, setRoute]);

  useEffect(() => {
    if (!compactPanels) {
      previousDrawer.current = null;
      return;
    }
    const openDrawer = route.channelsOpen
      ? "channels"
      : route.detailOpen
        ? "detail"
        : null;
    if (openDrawer) {
      previousDrawer.current = openDrawer;
      const panel =
        openDrawer === "channels"
          ? channelsPanelRef.current
          : detailPanelRef.current;
      const frame = requestAnimationFrame(() => {
        if (panel && !panel.contains(document.activeElement)) {
          panel.focus();
        }
      });
      return () => cancelAnimationFrame(frame);
    }
    const closedDrawer = previousDrawer.current;
    previousDrawer.current = null;
    if (closedDrawer) {
      const frame = requestAnimationFrame(() => {
        (closedDrawer === "channels"
          ? channelsToggleRef.current
          : detailToggleRef.current
        )?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [compactPanels, route.channelsOpen, route.detailOpen]);

  useEffect(() => {
    const closeDrawers = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      if (route.channelsOpen || route.detailOpen) {
        updateRoute(setRoute, {
          ...route,
          channelsOpen: false,
          detailOpen: false,
        });
      }
    };
    window.addEventListener("keydown", closeDrawers);
    return () => window.removeEventListener("keydown", closeDrawers);
  }, [route, setRoute]);

  if (state.session !== "ready") {
    return (
      <SessionGate
        state={state}
        projectId={route.projectId}
        hasUnknownOutcome={controller.hasUnknownCollaborationOutcome}
        onExchange={async (token, projectId) => {
          const next = { ...route, projectId };
          updateRoute(setRoute, next, "replace");
          await controller.exchangeSession(token, projectId);
        }}
      />
    );
  }

  const selectView = (view: ViewName) => {
    updateRoute(setRoute, { ...route, view });
  };
  const selectChannel = (channelId: string) => {
    loadedChannel.current = null;
    loadedThread.current = null;
    loadedRun.current = null;
    controller.clearThread();
    controller.clearRun();
    updateRoute(setRoute, {
      ...route,
      view: "threads",
      channelId,
      threadId: null,
      runId: null,
      detailPanel: "status",
    });
  };
  const selectThread = (threadId: string, channelId = route.channelId) => {
    loadedThread.current = null;
    loadedRun.current = null;
    controller.clearRun();
    updateRoute(setRoute, {
      ...route,
      view: "threads",
      channelId,
      threadId,
      runId: null,
      detailPanel: "status",
      channelsOpen: window.innerWidth >= 1100 && route.channelsOpen,
      detailOpen: window.innerWidth >= 1100 && route.detailOpen,
    });
  };
  const selectRun = (runId: string, threadId: string, channelId: string) => {
    loadedThread.current = null;
    loadedRun.current = null;
    updateRoute(setRoute, {
      ...route,
      view: "threads",
      channelId,
      threadId,
      runId,
      detailPanel: "run",
      detailOpen: true,
      channelsOpen: window.innerWidth >= 1100 && route.channelsOpen,
    });
  };

  return (
    <div
      className={[
        "workbench",
        route.channelsOpen ? "channels-open" : "channels-closed",
        route.detailOpen ? "detail-open" : "detail-closed",
      ].join(" ")}
    >
      <a
        className="skip-link"
        href="#main-content"
        inert={modalDrawerOpen || undefined}
      >
        Skip to conversation
      </a>
      <Rail
        route={route}
        state={state}
        inert={modalDrawerOpen}
        onSelectView={selectView}
      />
      <ChannelsPanel
        panelRef={channelsPanelRef}
        modal={compactPanels && route.channelsOpen}
        route={route}
        state={state}
        composerValue={composerValues[startComposerKey] ?? emptyComposerValue}
        onComposerChange={(update) =>
          updateComposer(startComposerKey, update)
        }
        onClose={() =>
          updateRoute(setRoute, { ...route, channelsOpen: false })
        }
        onSelectChannel={selectChannel}
        onSelectThread={selectThread}
        onStartThread={(body, targetAgentIds) =>
          controller.startThread({
            channelId: route.channelId!,
            body,
            ...(targetAgentIds ? { targetAgentIds } : {}),
          })
        }
      />
      <main
        className="primary-surface"
        id="main-content"
        inert={modalDrawerOpen || undefined}
      >
        <WorkbenchHeader
          channelsToggleRef={channelsToggleRef}
          detailToggleRef={detailToggleRef}
          route={route}
          state={state}
          onToggleChannels={() =>
            updateRoute(setRoute, {
              ...route,
              channelsOpen: !route.channelsOpen,
              detailOpen:
                compactPanels && !route.channelsOpen
                  ? false
                  : route.detailOpen,
            })
          }
          onToggleDetail={() =>
            updateRoute(setRoute, {
              ...route,
              detailOpen: !route.detailOpen,
              channelsOpen:
                compactPanels && !route.detailOpen
                  ? false
                  : route.channelsOpen,
            })
          }
          onSignOut={() => void controller.signOut()}
        />
        {state.connection !== "live" ? (
          <div className="mobile-connection">
            <ConnectionBadge state={state.connection} />
          </div>
        ) : null}
        {state.queryError ? (
          <div className="query-error" role="alert">
            <AlertTriangle aria-hidden="true" size={16} />
            <span>{state.queryError}</span>
          </div>
        ) : null}
        {route.view === "threads" ? (
          <Conversation
            controller={controller}
            state={state}
            route={route}
            composerValue={
              composerValues[replyComposerKey] ?? emptyComposerValue
            }
            onComposerChange={(update) =>
              updateComposer(replyComposerKey, update)
            }
            onSelectRun={selectRun}
            onReply={(body, targetAgentIds) =>
              controller.replyToThread({
                threadRootId: state.thread!.threadRootId,
                expectedThreadCursor: state.thread!.cursor,
                body,
                ...(targetAgentIds ? { targetAgentIds } : {}),
              })
            }
          />
        ) : route.view === "activity" ? (
          <ActivityCenter state={state} onSelectRun={selectRun} onSelectThread={selectThread} />
        ) : (
          <AgentOverview
            controller={controller}
            state={state}
            onSelectRun={selectRun}
          />
        )}
      </main>
      <DetailPanel
        controller={controller}
        panelRef={detailPanelRef}
        modal={compactPanels && route.detailOpen}
        route={route}
        state={state}
        onClose={() => updateRoute(setRoute, { ...route, detailOpen: false })}
        onLoadEarlier={() => { void controller.loadEarlierRunActivity(); }}
        onRefreshRun={() => { if (route.runId) void controller.loadRun(route.runId); }}
        onSelectRun={selectRun}
        onSelectThread={selectThread}
      />
      {(route.channelsOpen || route.detailOpen) && (
        <button
          className="drawer-scrim"
          type="button"
          tabIndex={-1}
          aria-label="Close open panels"
          onClick={() =>
            updateRoute(setRoute, {
              ...route,
              channelsOpen: false,
              detailOpen: false,
            })
          }
        />
      )}
    </div>
  );
}

function SessionGate({
  state,
  projectId,
  hasUnknownOutcome,
  onExchange,
}: {
  readonly state: WebState;
  readonly projectId: string;
  readonly hasUnknownOutcome: boolean;
  readonly onExchange: (token: string, projectId: string) => Promise<void>;
}) {
  const tokenRef = useRef<HTMLInputElement>(null);
  const [project, setProject] = useState(projectId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const token = tokenRef.current?.value ?? "";
    if (tokenRef.current) {
      tokenRef.current.value = "";
    }
    if (!token) {
      tokenRef.current?.focus();
      return;
    }
    await onExchange(token, project).catch(() => undefined);
  };

  return (
    <main className="session-screen">
      <section className="session-card" aria-labelledby="session-title">
        <Brand />
        <div className="session-copy">
          <p className="eyebrow">Local Human session</p>
          <h1 id="session-title">Connect to Torsor</h1>
          <p>
            Exchange the configured local credential for a browser session.
            The credential is discarded immediately; the CSRF token remains in
            this window session.
          </p>
        </div>
        {state.session === "expired" ? (
          <div className="session-notice" role="status">
            <Clock3 aria-hidden="true" size={16} />
            The browser session expired or was revoked. Connect again.
            Run drafts and submission identities are retained in this window.
            A lost response may have committed; reconnect to recover it.
            Run control recovery is retained across reconnect and reload in this window.
            {hasUnknownOutcome
              ? " Outcome unknown. Reconnect to retry the same collaboration request."
              : null}
          </div>
        ) : null}
        {state.authError ? (
          <div className="session-error" role="alert">
            <AlertTriangle aria-hidden="true" size={16} />
            {state.authError}
          </div>
        ) : null}
        <form className="session-form" onSubmit={submit}>
          <label htmlFor="project-id">Project ID</label>
          <input
            id="project-id"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
          <label htmlFor="local-token">Local bearer credential</label>
          <input
            id="local-token"
            ref={tokenRef}
            type="password"
            autoComplete="current-password"
            required
          />
          <button
            className="primary-button"
            type="submit"
            disabled={
              state.session === "exchanging" || state.session === "loading"
            }
          >
            {state.session === "exchanging" || state.session === "loading" ? (
              <RefreshCw className="spin" aria-hidden="true" size={17} />
            ) : (
              <ShieldCheck aria-hidden="true" size={17} />
            )}
            {state.session === "loading" ? "Loading project" : "Connect"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Rail({
  route,
  state,
  inert,
  onSelectView,
}: {
  readonly route: WindowRoute;
  readonly state: WebState;
  readonly inert: boolean;
  readonly onSelectView: (view: ViewName) => void;
}) {
  const openAttentionCount = state.attentions.length;
  return (
    <aside
      className="rail"
      aria-label="Primary views"
      inert={inert || undefined}
    >
      <Brand compact />
      <nav>
        <RailButton
          active={route.view === "threads"}
          label="Threads"
          icon={<MessageSquareText aria-hidden="true" />}
          onClick={() => onSelectView("threads")}
        />
        <RailButton
          active={route.view === "activity"}
          label="Activity"
          count={openAttentionCount}
          icon={<Activity aria-hidden="true" />}
          onClick={() => onSelectView("activity")}
        />
        <RailButton
          active={route.view === "agents"}
          label="Agents"
          icon={<Bot aria-hidden="true" />}
          onClick={() => onSelectView("agents")}
        />
      </nav>
      <div className="rail-spacer" />
      <div
        className={`rail-connection connection-${state.connection}`}
        title={`Server connection: ${state.connection}`}
      >
        <Radio aria-hidden="true" size={14} />
        <span>{state.connection}</span>
      </div>
    </aside>
  );
}

function RailButton({
  active,
  label,
  count,
  icon,
  onClick,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly count?: number;
  readonly icon: ReactNode;
  readonly onClick: () => void;
}) {
  return (
    <button
      className={`rail-button ${active ? "active" : ""}`}
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {count ? <b aria-label={`${count} open attentions`}>{count}</b> : null}
    </button>
  );
}

function ChannelsPanel({
  panelRef,
  modal,
  route,
  state,
  composerValue,
  onComposerChange,
  onClose,
  onSelectChannel,
  onSelectThread,
  onStartThread,
}: {
  readonly panelRef: Ref<HTMLElement>;
  readonly modal: boolean;
  readonly route: WindowRoute;
  readonly state: WebState;
  readonly composerValue: ComposerValue;
  readonly onComposerChange: (update: ComposerValueUpdater) => void;
  readonly onClose: () => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly onStartThread: (
    body: string,
    targetAgentIds?: readonly string[],
  ) => Promise<void>;
}) {
  return (
    <aside
      ref={panelRef}
      className="channels-panel"
      id="channels-panel"
      aria-label="Channels and threads"
      aria-modal={modal || undefined}
      role={modal ? "dialog" : undefined}
      tabIndex={modal ? -1 : undefined}
      onKeyDown={modal ? trapDrawerFocus : undefined}
    >
      <div className="panel-title">
        <div>
          <strong>{state.bootstrap?.project.name}</strong>
          <small>{state.bootstrap?.project.id}</small>
        </div>
        <IconButton label="Collapse channels" onClick={onClose}>
          <ChevronLeft aria-hidden="true" />
        </IconButton>
      </div>
      <section className="channel-section" aria-labelledby="channels-title">
        <div className="section-label" id="channels-title">
          Channels
          <span>{state.bootstrap?.channels.length ?? 0}</span>
        </div>
        <div className="channel-list">
          {state.bootstrap?.channels.map((channel) => (
            <button
              className={`channel-button ${
                channel.id === route.channelId ? "active" : ""
              }`}
              type="button"
              key={channel.id}
              aria-current={channel.id === route.channelId ? "true" : undefined}
              onClick={() => onSelectChannel(channel.id)}
            >
              <Hash aria-hidden="true" size={15} />
              <span>{channel.name}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="thread-section" aria-labelledby="threads-title">
        <div className="section-label" id="threads-title">
          Threads
          <span>{state.threads.length}</span>
        </div>
        <div className="thread-list">
          {state.loadingThreads &&
          state.threadsChannelId !== route.channelId ? (
            <LoadingRows label="Loading threads" />
          ) : state.threads.length === 0 ? (
            <p className="compact-empty">No threads in this channel.</p>
          ) : (
            state.threads.map((thread) => {
              const root = thread.messages[0];
              const active = thread.threadRootId === route.threadId;
              return (
                <button
                  className={`thread-button ${active ? "active" : ""}`}
                  type="button"
                  key={thread.threadRootId}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelectThread(thread.threadRootId)}
                >
                  <StatusDot
                    tone={thread.runs.some((run) => run.state === "Active")
                      ? "active"
                      : thread.attentions.some(
                            (attention) => attention.status === "Open",
                          )
                        ? "attention"
                        : "idle"}
                  />
                  <span>
                    <strong>{latestMessageBody(root) || "Untitled thread"}</strong>
                    <small>
                      {thread.messages.length - 1} replies · {thread.runs.length} runs
                    </small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
      {route.channelId ? (
        <div className="new-thread">
          <CommandComposer
            id="start-thread"
            label="Start a thread"
            placeholder="Describe durable work or ask a question…"
            buttonLabel="Start"
            agents={state.agents}
            pending={state.commandPending}
            value={composerValue}
            onChange={onComposerChange}
            onSend={onStartThread}
          />
        </div>
      ) : null}
    </aside>
  );
}

function WorkbenchHeader({
  channelsToggleRef,
  detailToggleRef,
  route,
  state,
  onToggleChannels,
  onToggleDetail,
  onSignOut,
}: {
  readonly channelsToggleRef: Ref<HTMLButtonElement>;
  readonly detailToggleRef: Ref<HTMLButtonElement>;
  readonly route: WindowRoute;
  readonly state: WebState;
  readonly onToggleChannels: () => void;
  readonly onToggleDetail: () => void;
  readonly onSignOut: () => void;
}) {
  const channel = state.bootstrap?.channels.find(
    (candidate) => candidate.id === route.channelId,
  );
  const title =
    route.view === "activity"
      ? "Activity"
      : route.view === "agents"
        ? "Agents"
        : latestMessageBody(state.thread?.messages[0]) || "Conversation";
  return (
    <header className="workbench-header">
      <IconButton
        buttonRef={channelsToggleRef}
        label={route.channelsOpen ? "Collapse channels" : "Expand channels"}
        ariaExpanded={route.channelsOpen}
        controls="channels-panel"
        onClick={onToggleChannels}
      >
        {route.channelsOpen ? (
          <PanelLeftClose aria-hidden="true" />
        ) : (
          <PanelLeftOpen aria-hidden="true" />
        )}
      </IconButton>
      <div className="location">
        <strong>{title}</strong>
        <span>
          {state.bootstrap?.project.name}
          {channel ? ` / #${channel.name}` : " / global projection"}
        </span>
      </div>
      <ConnectionBadge state={state.connection} />
      <IconButton
        buttonRef={detailToggleRef}
        label={route.detailOpen ? "Collapse detail panel" : "Expand detail panel"}
        ariaExpanded={route.detailOpen}
        controls="detail-panel"
        onClick={onToggleDetail}
      >
        {route.detailOpen ? (
          <PanelRightClose aria-hidden="true" />
        ) : (
          <PanelRightOpen aria-hidden="true" />
        )}
      </IconButton>
      <IconButton label="Sign out" onClick={onSignOut}>
        <LogOut aria-hidden="true" />
      </IconButton>
    </header>
  );
}

function Conversation({
  controller,
  state,
  route,
  composerValue,
  onComposerChange,
  onSelectRun,
  onReply,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly route: WindowRoute;
  readonly composerValue: ComposerValue;
  readonly onComposerChange: (update: ComposerValueUpdater) => void;
  readonly onSelectRun: (runId: string, threadId: string, channelId: string) => void;
  readonly onReply: (
    body: string,
    targetAgentIds?: readonly string[],
  ) => Promise<void>;
}) {
  const selectedThread =
    route.threadId && state.thread?.threadRootId === route.threadId
      ? state.thread
      : null;
  if (state.loadingThread && !selectedThread) {
    return <FullLoading label="Loading atomic thread projection" />;
  }
  if (!route.threadId || !selectedThread) {
    return (
      <EmptyState
        icon={<MessageSquareText aria-hidden="true" />}
        title="Select or start a thread"
        detail="The conversation remains beside status and execution facts as work changes."
      />
    );
  }
  const [root, ...replies] = selectedThread.messages;
  if (!root) {
    return (
      <EmptyState
        icon={<MessageSquareText aria-hidden="true" />}
        title="This thread has no visible messages"
        detail="Refresh the projection or select another thread."
      />
    );
  }
  const runByCause = new Map(
    selectedThread.runs.map((run) => [run.id, run] as const),
  );
  return (
    <div className="conversation">
      <div className="conversation-scroll">
        <article className="root-message">
          <MessageHeader message={root} agents={state.agents} root />
          <MessageRevisionControls
            controller={controller}
            state={state}
            message={root}
          />
          <div className="fact-row">
            <Fact>{selectedThread.cursor} thread cursor</Fact>
            <Fact>{selectedThread.attentions.length} attentions</Fact>
            <Fact>{selectedThread.runs.length} runs</Fact>
          </div>
        </article>
        <ol className="reply-list" aria-label="Thread replies">
          {replies.map((message) => {
            const causedRun = message.causedByRunId
              ? runByCause.get(message.causedByRunId)
              : undefined;
            return (
              <li key={message.id}>
                <article className="reply-message">
                  <MessageHeader message={message} agents={state.agents} />
                  <MessageRevisionControls
                    controller={controller}
                    state={state}
                    message={message}
                  />
                  {causedRun ? (
                    <RunLink
                      run={causedRun}
                      agents={state.agents}
                      onClick={() =>
                        onSelectRun(
                          causedRun.id,
                          selectedThread.threadRootId,
                          selectedThread.channelId,
                        )
                      }
                    />
                  ) : null}
                </article>
              </li>
            );
          })}
        </ol>
        {replies.length === 0 ? (
          <p className="reply-empty">No replies yet. Add the next public message below.</p>
        ) : null}
        {selectedThread.runs.length ? (
          <section className="thread-runs" aria-labelledby="thread-runs-title">
            <div className="section-label" id="thread-runs-title">
              Runs from this thread
            </div>
            {selectedThread.runs.map((run) => (
              <RunLink
                key={run.id}
                run={run}
                agents={state.agents}
                onClick={() =>
                  onSelectRun(
                    run.id,
                    selectedThread.threadRootId,
                    selectedThread.channelId,
                  )
                }
              />
            ))}
          </section>
        ) : null}
      </div>
      <div className="reply-composer">
        <CommandComposer
          id="reply-thread"
          label="Reply to thread"
          placeholder="Add a public reply…"
          buttonLabel="Reply"
          agents={state.agents}
          pending={state.commandPending}
          value={composerValue}
          onChange={onComposerChange}
          onSend={onReply}
        />
      </div>
    </div>
  );
}

function MessageRevisionControls({
  controller,
  state,
  message,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly message: Message;
}) {
  const latest = latestMessageRevision(message);
  const recoveredEdit = controller.pendingMessageEdit(message.id);
  const recoveredDelete = controller.pendingMessageDelete(message.id);
  const [editing, setEditing] = useState(recoveredEdit !== null);
  const [confirmingDelete, setConfirmingDelete] = useState(
    recoveredDelete !== null,
  );
  const [draft, setDraft] = useState(
    recoveredEdit?.body ?? latest?.body ?? "",
  );
  const [targets, setTargets] = useState<readonly string[]>(
    recoveredEdit?.targetAgentIds ?? latest?.targetAgentIds ?? [],
  );
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(
    recoveredEdit
      ? "Outcome unknown. Retry same edit."
      : recoveredDelete
        ? "Outcome unknown. Retry same delete."
        : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [frozenEdit, setFrozenEdit] = useState<{
    readonly messageId: string;
    readonly threadRootId: string;
    readonly expectedMessageRevision: number;
    readonly body: string;
    readonly targetAgentIds: readonly string[];
  } | null>(recoveredEdit);
  const [frozenDelete, setFrozenDelete] = useState<{
    readonly messageId: string;
    readonly threadRootId: string;
    readonly expectedMessageRevision: number;
  } | null>(recoveredDelete);
  const canMutate =
    state.session === "ready" &&
    controller.principalId === message.authorPrincipalId &&
    latest !== undefined &&
    !latest.tombstone;

  const submitEdit = async () => {
    const request =
      frozenEdit ?? {
        messageId: message.id,
        threadRootId: message.threadRootId,
        expectedMessageRevision: message.latestRevision,
        body: draft,
        targetAgentIds: targets,
      };
    if (!request.body.trim()) {
      setError("Message body must not be empty.");
      return;
    }
    setFrozenEdit(request);
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const outcome = await controller.editMessage(request);
      setStatus(
        outcome.refreshed
          ? "Message revision committed."
          : "Committed; projections could not be refreshed.",
      );
      setFrozenEdit(null);
      setEditing(false);
    } catch (caught) {
      const retained = controller.pendingMessageEdit(message.id);
      if (isUncertainUiError(caught) || retained) {
        setFrozenEdit(retained ?? request);
        setStatus("Outcome unknown. Retry same edit.");
      } else {
        setError(
          caught instanceof Error ? caught.message : "Message edit failed.",
        );
        setFrozenEdit(null);
      }
    } finally {
      setPending(false);
    }
  };

  const submitDelete = async () => {
    const request =
      frozenDelete ?? {
        messageId: message.id,
        threadRootId: message.threadRootId,
        expectedMessageRevision: message.latestRevision,
      };
    setFrozenDelete(request);
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const outcome = await controller.deleteMessage(request);
      setStatus(
        outcome.refreshed
          ? "Message tombstone committed."
          : "Committed; projections could not be refreshed.",
      );
      setFrozenDelete(null);
      setConfirmingDelete(false);
    } catch (caught) {
      const retained = controller.pendingMessageDelete(message.id);
      if (isUncertainUiError(caught) || retained) {
        setFrozenDelete(retained ?? request);
        setStatus("Outcome unknown. Retry same delete.");
      } else {
        setError(
          caught instanceof Error ? caught.message : "Message deletion failed.",
        );
        setFrozenDelete(null);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="message-revisions">
      {latest?.tombstone ? (
        <p>
          <em>Message deleted; immutable history retained.</em>
        </p>
      ) : (
        <p>{latest?.body ?? latestMessageBody(message)}</p>
      )}
      {canMutate ? (
        <div className="fact-row">
          <button
            type="button"
            disabled={pending || frozenDelete !== null}
            onClick={() => {
              setDraft(latest.body);
              setTargets(latest.targetAgentIds);
              setEditing(true);
              setConfirmingDelete(false);
              setError(null);
            }}
          >
            Edit message
          </button>
          <button
            type="button"
            disabled={pending || frozenEdit !== null}
            onClick={() => {
              setConfirmingDelete(true);
              setEditing(false);
              setError(null);
            }}
          >
            Delete message
          </button>
        </div>
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submitEdit();
          }}
        >
          <label>
            Revised message
            <textarea
              value={draft}
              disabled={pending || frozenEdit !== null}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <fieldset disabled={pending || frozenEdit !== null}>
            <legend>Notify Agents in this revision</legend>
            {state.agents.map((agent) => (
              <label key={agent.id}>
                <input
                  type="checkbox"
                  checked={targets.includes(agent.id)}
                  onChange={(event) =>
                    setTargets(
                      event.currentTarget.checked
                        ? [...targets, agent.id].sort()
                        : targets.filter((target) => target !== agent.id),
                    )
                  }
                />
                {agent.name}
              </label>
            ))}
          </fieldset>
          <button type="submit" disabled={pending}>
            {frozenEdit ? "Retry same edit" : "Save revision"}
          </button>
          <button
            type="button"
            disabled={pending || frozenEdit !== null}
            onClick={() => setEditing(false)}
          >
            Cancel edit
          </button>
        </form>
      ) : null}
      {confirmingDelete ? (
        <div role="group" aria-label="Confirm Message deletion">
          <p>
            This creates a tombstone. Revision history, Attention, and RunInput
            references remain.
          </p>
          <button type="button" disabled={pending} onClick={() => void submitDelete()}>
            {frozenDelete ? "Retry same delete" : "Confirm tombstone"}
          </button>
          <button
            type="button"
            disabled={pending || frozenDelete !== null}
            onClick={() => setConfirmingDelete(false)}
          >
            Cancel deletion
          </button>
        </div>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <details>
        <summary>Revision history ({message.revisions.length})</summary>
        <ol>
          {message.revisions.map((revision) => (
            <li key={revision.id}>
              <strong>Revision {revision.revision}</strong>{" "}
              <time dateTime={revision.createdAt}>{revision.createdAt}</time>
              <p>
                {revision.tombstone
                  ? "Tombstone"
                  : revision.body}
              </p>
              <small>
                Mentions:{" "}
                {revision.targetAgentIds.length
                  ? revision.targetAgentIds
                      .map((target) => agentName(state.agents, target))
                      .join(", ")
                  : "none"}
              </small>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function ActivityCenter({
  state,
  onSelectRun,
  onSelectThread,
}: {
  readonly state: WebState;
  readonly onSelectRun: (runId: string, threadId: string, channelId: string) => void;
  readonly onSelectThread: (threadId: string, channelId: string) => void;
}) {
  const activeRuns = state.runs.filter(({ run }) =>
    run.state === "Active" || run.state === "Waiting",
  );
  const completedRuns = state.runs.filter(({ run }) =>
    ["Completed", "Failed", "Cancelled"].includes(run.state),
  );
  return (
    <div className="projection-page">
      <PageIntro
        title="Activity across threads"
        detail="Human-relevant Attention and Run facts, linked back to their source conversation."
        facts={[
          `${state.attentions.length} need review`,
          `${activeRuns.length} active`,
          `${completedRuns.length} settled`,
        ]}
      />
      <div className="activity-grid">
        <ProjectionGroup title="Needs you" count={state.attentions.length}>
          {state.attentions.length ? (
            state.attentions.map((attention) => (
              <button
                className="projection-item"
                type="button"
                key={attention.id}
                onClick={() =>
                  onSelectThread(attention.threadRootId, attention.channelId)
                }
              >
                <AlertTriangle aria-hidden="true" size={16} />
                <span>
                  <strong>{attention.triggerKind}</strong>
                  <small>
                    Attention {shortId(attention.id)} · target{" "}
                    {agentName(state.agents, attention.targetAgentId)}
                  </small>
                </span>
                <ChevronRight aria-hidden="true" size={15} />
              </button>
            ))
          ) : (
            <p className="compact-empty">No open Attention facts.</p>
          )}
        </ProjectionGroup>
        <ProjectionGroup title="Running now" count={activeRuns.length}>
          {activeRuns.length ? (
            activeRuns.map(({ run }) => (
              <ActivityRun
                key={run.id}
                run={run}
                agents={state.agents}
                onClick={() =>
                  onSelectRun(run.id, run.threadRootId, run.homeChannelId)
                }
              />
            ))
          ) : (
            <p className="compact-empty">No active Runs.</p>
          )}
        </ProjectionGroup>
        <ProjectionGroup title="Recently settled" count={completedRuns.length}>
          {completedRuns.length ? (
            completedRuns.slice(0, 12).map(({ run }) => (
              <ActivityRun
                key={run.id}
                run={run}
                agents={state.agents}
                onClick={() =>
                  onSelectRun(run.id, run.threadRootId, run.homeChannelId)
                }
              />
            ))
          ) : (
            <p className="compact-empty">No settled Runs.</p>
          )}
        </ProjectionGroup>
      </div>
    </div>
  );
}

function AgentOverview({
  controller,
  state,
  onSelectRun,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly onSelectRun: (runId: string, threadId: string, channelId: string) => void;
}) {
  return (
    <div className="projection-page">
      <PageIntro
        title="Agents"
        detail="Stable identities with authoritative Run and Attention activation status."
        facts={[
          `${state.agents.filter((agent) => agent.status === "active").length} active`,
          `${state.agents.filter((agent) => agent.status === "waiting").length} waiting`,
          `${state.agents.filter((agent) => agent.status === "idle").length} idle`,
        ]}
      />
      <div className="agent-grid">
        {state.agents.map((agent) => {
          const runs = state.runs.filter(
            ({ run }) => run.ownerAgentId === agent.id,
          );
          const attentionOnly =
            (agent.liveAttentionActivationCount ?? 0) > 0 &&
            (agent.liveRunActivationCount ?? 0) === 0;
          return (
            <article className="agent-card" key={agent.id}>
              <div className="agent-card-head">
                <Avatar label={agent.name} />
                <span>
                  <strong>{agent.name}</strong>
                  <small>
                    {attentionOnly
                      ? "Attention activation"
                      : `${agent.status ?? "idle"} · ${
                          agent.liveActivationCount ?? 0
                        } live activations`}
                  </small>
                </span>
                <StatusPill
                  label={attentionOnly ? "Attention-only" : agent.status ?? "idle"}
                  tone={
                    attentionOnly
                      ? "attention"
                      : agent.status === "active"
                        ? "active"
                        : "idle"
                  }
                />
              </div>
              <div className="agent-metrics">
                <Fact>config revision {agent.configRevision}</Fact>
                <Fact>{agent.nonterminalRunCount ?? 0} nonterminal runs</Fact>
                <Fact>{agent.liveRunActivationCount ?? 0} run activations</Fact>
                <Fact>
                  {agent.liveAttentionActivationCount ?? 0} attention activations
                </Fact>
              </div>
              <AgentConfigControl
                controller={controller}
                state={state}
                agent={agent}
              />
              <div className="agent-run-list">
                {runs.length ? (
                  runs.slice(0, 8).map(({ run }) => (
                    <button
                      type="button"
                      key={run.id}
                      onClick={() =>
                        onSelectRun(run.id, run.threadRootId, run.homeChannelId)
                      }
                    >
                      <StatusDot tone={runTone(run.state)} />
                      <span>
                        <strong>{shortId(run.id)}</strong>
                        <small>{run.state}</small>
                      </span>
                      <ChevronRight aria-hidden="true" size={15} />
                    </button>
                  ))
                ) : (
                  <p className="compact-empty">No Runs for this Agent.</p>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function DetailPanel({
  controller,
  panelRef,
  modal,
  route,
  state,
  onClose,
  onLoadEarlier,
  onRefreshRun,
  onSelectRun,
  onSelectThread,
}: {
  readonly controller: WebController;
  readonly panelRef: Ref<HTMLElement>;
  readonly modal: boolean;
  readonly route: WindowRoute;
  readonly state: WebState;
  readonly onClose: () => void;
  readonly onLoadEarlier: () => void;
  readonly onRefreshRun: () => void;
  readonly onSelectRun: (runId: string, threadId: string, channelId: string) => void;
  readonly onSelectThread: (threadId: string, channelId: string) => void;
}) {
  return (
    <aside
      ref={panelRef}
      className="detail-panel"
      id="detail-panel"
      aria-label="Status and detail"
      aria-modal={modal || undefined}
      role={modal ? "dialog" : undefined}
      tabIndex={modal ? -1 : undefined}
      onKeyDown={modal ? trapDrawerFocus : undefined}
    >
      <div className="panel-title">
        <div>
          <strong>{route.detailPanel === "run" ? "Run detail" : "Project status"}</strong>
          <small>Server facts</small>
        </div>
        <IconButton label="Collapse detail panel" onClick={onClose}>
          <ChevronRight aria-hidden="true" />
        </IconButton>
      </div>
      {route.detailPanel === "run" && route.runId ? (
        <>
          <RunDetail state={state} onLoadEarlier={onLoadEarlier} onRefresh={onRefreshRun}
            controls={
              <>
                <RunControls key={route.runId} controller={controller} state={state} runId={route.runId} />
                <RunConfigAdoption
                  key={`${route.runId}-config`}
                  controller={controller}
                  state={state}
                  runId={route.runId}
                />
              </>
            } />
          <RunComposer
            key={route.runId}
            controller={controller}
            state={state}
            runId={route.runId}
            onOpenThread={onSelectThread}
          />
        </>
      ) : (
        <StatusDetail
          state={state}
          onSelectRun={onSelectRun}
          onSelectThread={onSelectThread}
        />
      )}
    </aside>
  );
}

function AgentConfigControl({
  controller,
  state,
  agent,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly agent: AgentStatus;
}) {
  const recovered = controller.pendingAgentConfigUpdate(agent.id);
  const [editing, setEditing] = useState(recovered !== null);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(recovered?.config ?? agent.config, null, 2),
  );
  const [frozen, setFrozen] = useState<{
    readonly agentId: string;
    readonly expectedAgentConfigRevision: number;
    readonly config: JsonValue;
  } | null>(recovered);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(
    recovered ? "Outcome unknown. Retry same config update." : null,
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    let request = frozen;
    if (!request) {
      try {
        request = {
          agentId: agent.id,
          expectedAgentConfigRevision: agent.configRevision,
          config: JSON.parse(draft) as JsonValue,
        };
      } catch {
        setError("Agent config must be valid JSON.");
        return;
      }
    }
    setFrozen(request);
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const outcome = await controller.updateAgentConfig(request);
      setStatus(
        outcome.refreshed
          ? "Agent config revision committed."
          : "Committed; projections could not be refreshed.",
      );
      setFrozen(null);
      setEditing(false);
    } catch (caught) {
      const retained = controller.pendingAgentConfigUpdate(agent.id);
      if (isUncertainUiError(caught) || retained) {
        setFrozen(retained ?? request);
        setStatus("Outcome unknown. Retry same config update.");
      } else {
        setError(
          caught instanceof Error ? caught.message : "Config update failed.",
        );
        setFrozen(null);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="agent-config-control">
      <pre>{JSON.stringify(agent.config, null, 2)}</pre>
      {state.session === "ready" ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setDraft(JSON.stringify(agent.config, null, 2));
            setEditing(true);
            setError(null);
          }}
        >
          Update config
        </button>
      ) : null}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Non-secret Agent config JSON
            <textarea
              value={draft}
              disabled={pending || frozen !== null}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <button type="submit" disabled={pending}>
            {frozen ? "Retry same config update" : "Create config revision"}
          </button>
          <button
            type="button"
            disabled={pending || frozen !== null}
            onClick={() => setEditing(false)}
          >
            Cancel config update
          </button>
        </form>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

function RunConfigAdoption({
  controller,
  state,
  runId,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly runId: string;
}) {
  const run = state.run?.run.id === runId ? state.run.run : null;
  const agent = state.agents.find(
    (candidate) => candidate.id === run?.ownerAgentId,
  );
  const recovered = controller.pendingRunConfigAdoption(runId);
  const [frozen, setFrozen] = useState<{
    readonly runId: string;
    readonly threadRootId: string;
    readonly expectedRunRevision: number;
    readonly expectedAgentConfigRevision: number;
    readonly targetAgentConfigRevision: number;
  } | null>(recovered);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(
    recovered ? "Outcome unknown. Retry same config adoption." : null,
  );
  const [error, setError] = useState<string | null>(null);
  if (!run || !agent) {
    return null;
  }
  const nonterminal =
    run.state === "Active" || run.state === "Waiting";
  const eligible =
    state.session === "ready" &&
    nonterminal &&
    agent.configRevision > run.agentConfigRevision;

  const submit = async () => {
    const request =
      frozen ?? {
        runId: run.id,
        threadRootId: run.threadRootId,
        expectedRunRevision: run.revision,
        expectedAgentConfigRevision: agent.configRevision,
        targetAgentConfigRevision: agent.configRevision,
      };
    setFrozen(request);
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const outcome = await controller.adoptRunConfig(request);
      setStatus(
        outcome.refreshed
          ? "Run config adoption committed; existing Activations are unchanged."
          : "Committed; projections could not be refreshed.",
      );
      setFrozen(null);
    } catch (caught) {
      const retained = controller.pendingRunConfigAdoption(run.id);
      if (isUncertainUiError(caught) || retained) {
        setFrozen(retained ?? request);
        setStatus("Outcome unknown. Retry same config adoption.");
      } else {
        setError(
          caught instanceof Error ? caught.message : "Config adoption failed.",
        );
        setFrozen(null);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-label="Run Agent configuration">
      <div className="fact-row">
        <Fact>Run config {run.agentConfigRevision}</Fact>
        <Fact>Agent current config {agent.configRevision}</Fact>
      </div>
      <p>
        Existing Activations remain pinned to their recorded configuration.
      </p>
      {eligible || frozen ? (
        <button type="button" disabled={pending} onClick={() => void submit()}>
          {frozen ? "Retry same adoption" : "Adopt current config"}
        </button>
      ) : (
        <p className="compact-empty">
          {!nonterminal
            ? "Terminal Runs cannot adopt configuration."
            : "No newer Agent config revision is available."}
        </p>
      )}
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function isUncertainUiError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500;
}

function StatusDetail({
  state,
  onSelectRun,
  onSelectThread,
}: {
  readonly state: WebState;
  readonly onSelectRun: (runId: string, threadId: string, channelId: string) => void;
  readonly onSelectThread: (threadId: string, channelId: string) => void;
}) {
  const activeRuns = state.runs.filter(
    ({ run }) => run.state === "Active" || run.state === "Waiting",
  );
  return (
    <div className="detail-scroll">
      <DetailSection title="Connection">
        <div className="status-line">
          <ConnectionBadge state={state.connection} />
          <span className="mono">{state.lastEventId ?? "No event cursor"}</span>
        </div>
        {state.connection === "reconnecting" ? (
          <p className="stale-note">
            Projections may be stale. Native EventSource is reconnecting with
            its last received event ID.
          </p>
        ) : null}
      </DetailSection>
      <DetailSection title="Open attention" count={state.attentions.length}>
        {state.attentions.length ? (
          state.attentions.map((attention) => (
            <button
              className="detail-link"
              type="button"
              key={attention.id}
              onClick={() =>
                onSelectThread(attention.threadRootId, attention.channelId)
              }
            >
              <AlertTriangle aria-hidden="true" size={15} />
              <span>
                <strong>{attention.triggerKind}</strong>
                <small>
                  {agentName(state.agents, attention.targetAgentId)} · revision{" "}
                  {attention.revision}
                </small>
              </span>
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          ))
        ) : (
          <p className="compact-empty">No open Attention facts.</p>
        )}
      </DetailSection>
      <DetailSection title="Active runs" count={activeRuns.length}>
        {activeRuns.length ? (
          activeRuns.map(({ run }) => (
            <button
              className="detail-link"
              type="button"
              key={run.id}
              onClick={() =>
                onSelectRun(run.id, run.threadRootId, run.homeChannelId)
              }
            >
              <CircleDot aria-hidden="true" size={15} />
              <span>
                <strong>
                  {agentName(state.agents, run.ownerAgentId)} · {shortId(run.id)}
                </strong>
                <small>
                  {run.state} · revision {run.revision}
                </small>
              </span>
              <ChevronRight aria-hidden="true" size={14} />
            </button>
          ))
        ) : (
          <p className="compact-empty">No active Runs.</p>
        )}
      </DetailSection>
      <DetailSection title="Agents" count={state.agents.length}>
        {state.agents.map((agent) => {
          const attentionOnly =
            (agent.liveAttentionActivationCount ?? 0) > 0 &&
            (agent.liveRunActivationCount ?? 0) === 0;
          return (
            <div className="agent-status-row" key={agent.id}>
              <StatusDot
                tone={
                  attentionOnly
                    ? "attention"
                    : agent.status === "active"
                      ? "active"
                      : "idle"
                }
              />
              <span>
                <strong>{agent.name}</strong>
                <small>
                  {attentionOnly
                    ? "Attention-only activity"
                    : `${agent.status ?? "idle"} · ${
                        agent.nonterminalRunCount ?? 0
                      } nonterminal`}
                </small>
              </span>
            </div>
          );
        })}
      </DetailSection>
    </div>
  );
}

function RunDetail({ state, onLoadEarlier, onRefresh, controls }: {
  readonly state: WebState;
  readonly onLoadEarlier: () => void;
  readonly onRefresh: () => void;
  readonly controls: ReactNode;
}) {
  if (state.loadingRun && !state.run) {
    return <div className="detail-scroll run-detail">{controls}<FullLoading label="Loading atomic Run projection" /></div>;
  }
  const projection = state.run;
  if (!projection) {
    return (
      <div className="detail-scroll run-detail">
        {controls}
        <EmptyState
          icon={<CircleDot aria-hidden="true" />}
          title="Run unavailable"
          detail="Select a Run from the conversation or project status."
        />
      </div>
    );
  }
  const agent = agentName(state.agents, projection.run.ownerAgentId);
  return (
    <div className="detail-scroll run-detail">
      {controls}
      <section className="run-summary">
        <div className="run-summary-title">
          <Avatar label={agent} />
          <span>
            <strong>{agent}</strong>
            <small>{projection.run.id}</small>
          </span>
          <StatusPill
            label={projection.run.state}
            tone={runTone(projection.run.state)}
          />
        </div>
        <div className="fact-row">
          <Fact>revision {projection.run.revision}</Fact>
          <Fact>generation {projection.run.activationGeneration}</Fact>
        </div>
        {projection.run.terminalReason ? (
          <p className="terminal-reason">{projection.run.terminalReason}</p>
        ) : null}
      </section>
      <LiveTimeline
        projection={projection}
        connection={state.connection}
        loadingHistory={state.loadingRunHistory}
        historyError={state.runHistoryError}
        refreshError={state.runRefreshError}
        refreshing={state.loadingRun}
        onLoadEarlier={onLoadEarlier}
        onRefresh={onRefresh}
      />
      <details className="run-diagnostics">
        <summary>Run diagnostics</summary>
      <DetailSection title="RunInputs" count={projection.inputs.length}>
        {projection.inputs.length ? (
          projection.inputs.map((input) => (
            <div className="fact-card" key={input.id}>
              <div>
                <strong>Input {input.sequence}</strong>
                <StatusPill
                  label={input.disposition}
                  tone={input.disposition === "Pending" ? "attention" : "idle"}
                />
              </div>
              <small>{input.messageRevisionId}</small>
              {input.dispositionReason ? <p>{input.dispositionReason}</p> : null}
            </div>
          ))
        ) : (
          <p className="compact-empty">No RunInputs.</p>
        )}
      </DetailSection>
      <DetailSection title="Activations" count={projection.activations.length}>
        {projection.activations.length ? (
          projection.activations.map((activation) => (
            <ActivationCard activation={activation} key={activation.id} />
          ))
        ) : (
          <p className="compact-empty">No Activations.</p>
        )}
      </DetailSection>
      <DetailSection
        title="Provider attempts"
        count={projection.providerAttempts.length}
      >
        {projection.providerAttempts.length ? (
          projection.providerAttempts.map((attempt) => (
            <div className="fact-card" key={attempt.id}>
              <div>
                <strong>{attempt.adapter}</strong>
                <StatusPill
                  label={attempt.status}
                  tone={
                    attempt.status === "Started" ||
                    attempt.status === "Acknowledged"
                      ? "active"
                      : attempt.status === "Failed" ||
                          attempt.status === "Unknown"
                        ? "attention"
                        : "idle"
                  }
                />
              </div>
              <small>
                v{attempt.adapterVersion} · {attempt.runInputIds.length} inputs
              </small>
              {attempt.detail ? <p>{attempt.detail}</p> : null}
            </div>
          ))
        ) : (
          <p className="compact-empty">No Provider attempts.</p>
        )}
      </DetailSection>
      </details>
    </div>
  );
}

function CommandComposer({
  id,
  label,
  placeholder,
  buttonLabel,
  agents,
  pending,
  value,
  onChange,
  onSend,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly agents: readonly AgentStatus[];
  readonly pending: boolean;
  readonly value: ComposerValue;
  readonly onChange: (update: ComposerValueUpdater) => void;
  readonly onSend: (
    body: string,
    targetAgentIds?: readonly string[],
  ) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = value.draft.trim();
    if (!body) {
      textAreaRef.current?.focus();
      return;
    }
    setError(null);
    setSubmitting(true);
    const submittedDraft = value.draft;
    const submittedAgentId = value.agentId;
    try {
      await onSend(body, submittedAgentId ? [submittedAgentId] : undefined);
      onChange((current) =>
        current.draft === submittedDraft &&
        current.agentId === submittedAgentId
          ? { ...current, draft: "" }
          : current,
      );
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "The message could not be sent.",
      );
      textAreaRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="command-composer" onSubmit={submit}>
      <label htmlFor={`${id}-body`}>{label}</label>
      <textarea
        id={`${id}-body`}
        ref={textAreaRef}
        value={value.draft}
        onChange={(event) => {
          const draft = event.target.value;
          onChange((current) => ({ ...current, draft }));
        }}
        placeholder={placeholder}
        rows={3}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p className="composer-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : null}
      <div className="composer-actions">
        <label htmlFor={`${id}-agent`}>Notify</label>
        <select
          id={`${id}-agent`}
          value={value.agentId}
          onChange={(event) => {
            const agentId = event.target.value;
            onChange((current) => ({ ...current, agentId }));
          }}
        >
          <option value="">No Agent</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <button
          className="send-button"
          type="submit"
          disabled={pending || submitting || !value.draft.trim()}
        >
          {pending || submitting ? (
            <RefreshCw className="spin" aria-hidden="true" size={15} />
          ) : (
            <Send aria-hidden="true" size={15} />
          )}
          {buttonLabel}
        </button>
      </div>
    </form>
  );
}

function MessageHeader({
  message,
  agents,
  root = false,
}: {
  readonly message: ThreadProjection["messages"][number];
  readonly agents: readonly AgentStatus[];
  readonly root?: boolean;
}) {
  const author = message.authorAgentId
    ? agentName(agents, message.authorAgentId)
    : "Human";
  return (
    <header className="message-header">
      <Avatar label={author} human={!message.authorAgentId} />
      <span>
        <strong>{author}</strong>
        <small>{root ? "Root message" : `Reply ${message.threadCursor}`}</small>
      </span>
      <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
    </header>
  );
}

function RunLink({
  run,
  agents,
  onClick,
}: {
  readonly run: Run;
  readonly agents: readonly AgentStatus[];
  readonly onClick: () => void;
}) {
  return (
    <button className="run-link" type="button" onClick={onClick}>
      <StatusDot tone={runTone(run.state)} />
      <span>
        <strong>
          {agentName(agents, run.ownerAgentId)} · {shortId(run.id)}
        </strong>
        <small>
          {run.state} · revision {run.revision}
        </small>
      </span>
      <ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}

function ActivityRun({
  run,
  agents,
  onClick,
}: {
  readonly run: Run;
  readonly agents: readonly AgentStatus[];
  readonly onClick: () => void;
}) {
  return (
    <button className="projection-item" type="button" onClick={onClick}>
      <StatusDot tone={runTone(run.state)} />
      <span>
        <strong>
          {agentName(agents, run.ownerAgentId)} · {shortId(run.id)}
        </strong>
        <small>
          {run.state} · updated {formatTime(run.updatedAt)}
        </small>
      </span>
      <ChevronRight aria-hidden="true" size={15} />
    </button>
  );
}

function PageIntro({
  title,
  detail,
  facts,
}: {
  readonly title: string;
  readonly detail: string;
  readonly facts: readonly string[];
}) {
  return (
    <header className="page-intro">
      <div>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      <div className="page-facts">
        {facts.map((fact) => (
          <Fact key={fact}>{fact}</Fact>
        ))}
      </div>
    </header>
  );
}

function ProjectionGroup({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="projection-group">
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      <div>{children}</div>
    </section>
  );
}

function DetailSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: ReactNode;
}) {
  return (
    <section className="detail-section">
      <div className="section-label">
        {title}
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <div className="empty-state">
      <span>{icon}</span>
      <h1>{title}</h1>
      <p>{detail}</p>
    </div>
  );
}

function FullLoading({ label }: { readonly label: string }) {
  return (
    <div className="full-loading" role="status">
      <RefreshCw className="spin" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function LoadingRows({ label }: { readonly label: string }) {
  return (
    <div className="loading-rows" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

function ConnectionBadge({
  state,
}: {
  readonly state: WebState["connection"];
}) {
  return (
    <span className={`connection-badge connection-${state}`} aria-live="polite">
      <StatusDot tone={state === "live" ? "active" : "attention"} />
      {state === "reconnecting" ? "Stale · reconnecting" : state}
    </span>
  );
}

function StatusPill({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone: "active" | "attention" | "idle";
}) {
  return <span className={`status-pill status-${tone}`}>{label}</span>;
}

function StatusDot({
  tone,
}: {
  readonly tone: "active" | "attention" | "idle";
}) {
  return <i className={`status-dot status-${tone}`} aria-hidden="true" />;
}

function Fact({ children }: { readonly children: ReactNode }) {
  return <span className="fact">{children}</span>;
}

function Avatar({
  label,
  human = false,
}: {
  readonly label: string;
  readonly human?: boolean;
}) {
  return (
    <span className={`avatar ${human ? "human" : ""}`} aria-hidden="true">
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

function IconButton({
  buttonRef,
  label,
  onClick,
  children,
  ariaExpanded,
  controls,
}: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly ariaExpanded?: boolean;
  readonly controls?: string;
}) {
  return (
    <button
      ref={buttonRef}
      className="icon-button"
      type="button"
      aria-label={label}
      aria-expanded={ariaExpanded}
      aria-controls={controls}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Brand({ compact = false }: { readonly compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "compact" : ""}`} aria-label="Torsor">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact ? (
        <span>
          <strong>Torsor</strong>
          <small>Human control surface</small>
        </span>
      ) : null}
    </div>
  );
}

function useWindowRoute(): [
  WindowRoute,
  React.Dispatch<React.SetStateAction<WindowRoute>>,
] {
  const [route, setRoute] = useState(() => readRoute(window.location, defaultProjectId));
  useEffect(() => {
    const sync = () => setRoute(readRoute(window.location, defaultProjectId));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return [route, setRoute];
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function trapDrawerFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") {
    return;
  }
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("inert"));
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (document.activeElement === event.currentTarget) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function updateRoute(
  setRoute: React.Dispatch<React.SetStateAction<WindowRoute>>,
  route: WindowRoute,
  mode: "push" | "replace" = "push",
): void {
  setRoute(route);
  writeRoute(route, mode);
}

function agentName(agents: readonly AgentStatus[], agentId: string): string {
  return agents.find((agent) => agent.id === agentId)?.name ?? shortId(agentId);
}

function ActivationCard({
  activation,
}: {
  readonly activation: Activation;
}) {
  const now = useActivationClock(activation);
  const status = activationStatus(activation, now);
  return (
    <div className="fact-card">
      <div>
        <strong>
          {activation.attentionId ? "Attention" : "Run"} activation
        </strong>
        <StatusPill label={status.label} tone={status.tone} />
      </div>
      <small>{activation.id}</small>
      <p>{formatActivationTimeRange(activation, status.label)}</p>
    </div>
  );
}

function useActivationClock(activation: Activation): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (
      activation.outcome ||
      activation.revokedAt ||
      activation.finishedAt
    ) {
      return;
    }
    const expiresAt = Date.parse(activation.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return;
    }
    const currentTime = Date.now();
    const remaining = expiresAt - currentTime;
    if (remaining <= 0) {
      if (now < expiresAt) {
        setNow(currentTime);
      }
      return;
    }
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [
    activation.expiresAt,
    activation.finishedAt,
    activation.id,
    activation.outcome,
    activation.revokedAt,
    now,
  ]);
  return now;
}

function activationStatus(activation: Activation, now: number): {
  readonly label: string;
  readonly tone: "active" | "attention" | "idle";
} {
  if (activation.outcome) {
    return { label: activation.outcome, tone: "idle" };
  }
  if (activation.revokedAt) {
    return { label: "Revoked", tone: "idle" };
  }
  const expiresAt = Date.parse(activation.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return { label: "Unconfirmed", tone: "attention" };
  }
  return expiresAt > now
    ? { label: "Live", tone: "active" }
    : { label: "Expired", tone: "idle" };
}

function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function runTone(state: Run["state"]): "active" | "attention" | "idle" {
  if (state === "Active") {
    return "active";
  }
  if (state === "Waiting" || state === "Failed") {
    return "attention";
  }
  return "idle";
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatActivationTimeRange(
  activation: Activation,
  status: string,
): string {
  const terminalAt = activation.finishedAt ?? activation.revokedAt;
  const end = terminalAt
    ? formatTime(terminalAt)
    : status === "Live"
      ? "live"
      : status === "Expired"
        ? `expired ${formatTime(activation.expiresAt)}`
        : status.toLowerCase();
  return `${formatTime(activation.startedAt)} → ${end}`;
}
