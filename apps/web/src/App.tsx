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

import type { WebController, WebState } from "./controller";
import {
  readRoute,
  type ViewName,
  type WindowRoute,
  writeRoute,
} from "./routing";
import {
  latestMessageBody,
  type Activation,
  type AgentStatus,
  type Run,
  type RunProjection,
  type ThreadProjection,
} from "./types";

const defaultProjectId =
  import.meta.env.VITE_TORSOR_PROJECT_ID ?? "project-sample";

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
  const compactPanels = useMediaQuery("(max-width: 1099px)");
  const modalDrawerOpen =
    compactPanels && (route.channelsOpen || route.detailOpen);

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
      requestAnimationFrame(() => panel?.focus());
      return;
    }
    const closedDrawer = previousDrawer.current;
    previousDrawer.current = null;
    if (closedDrawer) {
      requestAnimationFrame(() => {
        (closedDrawer === "channels"
          ? channelsToggleRef.current
          : detailToggleRef.current
        )?.focus();
      });
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
            state={state}
            route={route}
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
          <AgentOverview state={state} onSelectRun={selectRun} />
        )}
      </main>
      <DetailPanel
        panelRef={detailPanelRef}
        modal={compactPanels && route.detailOpen}
        route={route}
        state={state}
        onClose={() => updateRoute(setRoute, { ...route, detailOpen: false })}
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
  onExchange,
}: {
  readonly state: WebState;
  readonly projectId: string;
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
  onClose,
  onSelectChannel,
  onSelectThread,
  onStartThread,
}: {
  readonly panelRef: Ref<HTMLElement>;
  readonly modal: boolean;
  readonly route: WindowRoute;
  readonly state: WebState;
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
  state,
  route,
  onSelectRun,
  onReply,
}: {
  readonly state: WebState;
  readonly route: WindowRoute;
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
          <p>{latestMessageBody(root)}</p>
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
                  <p>{latestMessageBody(message)}</p>
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
          onSend={onReply}
        />
      </div>
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
  state,
  onSelectRun,
}: {
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
                <Fact>{agent.nonterminalRunCount ?? 0} nonterminal runs</Fact>
                <Fact>{agent.liveRunActivationCount ?? 0} run activations</Fact>
                <Fact>
                  {agent.liveAttentionActivationCount ?? 0} attention activations
                </Fact>
              </div>
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
  panelRef,
  modal,
  route,
  state,
  onClose,
  onSelectRun,
  onSelectThread,
}: {
  readonly panelRef: Ref<HTMLElement>;
  readonly modal: boolean;
  readonly route: WindowRoute;
  readonly state: WebState;
  readonly onClose: () => void;
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
        <RunDetail state={state} />
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

function RunDetail({ state }: { readonly state: WebState }) {
  if (state.loadingRun) {
    return <FullLoading label="Loading atomic Run projection" />;
  }
  const projection = state.run;
  if (!projection) {
    return (
      <EmptyState
        icon={<CircleDot aria-hidden="true" />}
        title="Run unavailable"
        detail="Select a Run from the conversation or project status."
      />
    );
  }
  const agent = agentName(state.agents, projection.run.ownerAgentId);
  return (
    <div className="detail-scroll run-detail">
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
      <DetailSection title="Activity" count={projection.activity.items.length}>
        {projection.activity.items.length ? (
          projection.activity.items.map((event) => (
            <div className="activity-event" key={event.id}>
              <StatusDot tone="active" />
              <span>
                <strong>{event.kind}</strong>
                <small>
                  sequence {event.sequence} · {formatTime(event.createdAt)}
                </small>
                <code>{summarizePayload(event.payload)}</code>
              </span>
            </div>
          ))
        ) : (
          <p className="compact-empty">No visible Run activity.</p>
        )}
      </DetailSection>
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
  onSend,
}: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly buttonLabel: string;
  readonly agents: readonly AgentStatus[];
  readonly pending: boolean;
  readonly onSend: (
    body: string,
    targetAgentIds?: readonly string[],
  ) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [agentId, setAgentId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body) {
      textAreaRef.current?.focus();
      return;
    }
    setError(null);
    try {
      await onSend(body, agentId ? [agentId] : undefined);
      setDraft("");
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : "The message could not be sent.",
      );
      textAreaRef.current?.focus();
    }
  };

  return (
    <form className="command-composer" onSubmit={submit}>
      <label htmlFor={`${id}-body`}>{label}</label>
      <textarea
        id={`${id}-body`}
        ref={textAreaRef}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
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
          value={agentId}
          onChange={(event) => setAgentId(event.target.value)}
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
          disabled={pending || !draft.trim()}
        >
          {pending ? (
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
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
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
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
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

function summarizePayload(payload: unknown): string {
  const text = JSON.stringify(payload);
  if (!text) {
    return "No payload";
  }
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}
