export type TaskStatus = "open" | "in_progress" | "in_review" | "done";

export const DEPLOYING_HUMAN = {
  name: "Jie Chen",
  initials: "JC",
} as const;

export interface ThreadReply {
  id: string;
  author: "human" | "agent";
  authorName: string;
  time: string;
  body: string;
  agentMeta?: Message["agentMeta"];
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reactedByHuman?: boolean;
}

export interface MessageArtifact {
  kind?: "plan" | "output";
  label: string;
  title: string;
  detail: string;
}

export interface Message {
  id: string;
  author: "human" | "agent";
  authorName: string;
  role: string;
  time: string;
  body: string;
  recipient?: string;
  agentMeta?: {
    model: string;
    tokens: number;
    latency: number;
  };
  reactions?: MessageReaction[];
  threadCount?: number;
  threadReplies?: ThreadReply[];
  sessionId?: string;
  artifact?: MessageArtifact;
  taskDraft?: {
    title: string;
    summary: string;
  };
}

export interface ArtifactCardContent {
  badge: "PLAN" | "OUTPUT";
  label: string;
  title: string;
  detail: string;
}

export function getArtifactCardContent(
  artifact: MessageArtifact,
): ArtifactCardContent {
  return {
    badge: artifact.kind === "plan" ? "PLAN" : "OUTPUT",
    label: artifact.label,
    title: artifact.title,
    detail: artifact.detail,
  };
}

export interface Task {
  id: string;
  title: string;
  summary: string;
  status: TaskStatus;
  sourceMessageId?: string;
  activeAgentId?: string;
  runIds: string[];
}

export interface Run {
  id: string;
  taskId: string;
  agentId: string;
  status: "running" | "failed" | "completed";
  attempt: number;
  recordedAt?: string;
  updatedAt?: string;
}

export interface Result {
  id: string;
  runId: string;
  taskId: string;
  summary: string;
  reviewState: "pending" | "changes_requested" | "approved";
  recordedAt?: string;
  updatedAt?: string;
}

export interface Decision {
  id: string;
  title: string;
  detail: string;
  sourceMessageId: string;
  recordedAt: string;
}

export interface ExternalEffect {
  id: string;
  taskId: string;
  title: string;
  detail: string;
  status: "uncertain" | "confirmed";
  recordedAt?: string;
  updatedAt?: string;
}

export interface Workspace {
  messages: Message[];
  tasks: Task[];
  runs: Run[];
  results: Result[];
  decisions: Decision[];
  externalEffects: ExternalEffect[];
}

export interface WorkspaceCounts {
  taskCount: number;
  reviewCount: number;
  pendingActionCount: number;
}

export type AgentStatus = "running" | "idle" | "queued" | "error" | "stopped";

export type TaskDisplayState =
  | "in-progress"
  | "in-review"
  | "done"
  | "queued"
  | "failed";

export interface AgentSummary {
  id: string;
  name: string;
  role: string;
  presence: string;
  status: AgentStatus;
  model: string;
  responseTokens: number;
  responseLatency: number;
  activity?: string;
  metrics?: {
    tokenCount?: number;
    activeDurationMinutes?: number;
    progressPercent?: number;
  };
}

export interface AgentDisplayItem {
  id: string;
  name: string;
  status: AgentSummary["status"];
  model: string;
  activity: string;
  taskCount: number;
  runCount: number;
  tokenCount?: number;
  activeDurationMinutes?: number;
  progressPercent?: number;
}

export interface Workstream {
  id: string;
  name: string;
  conversationTitle: string;
  context: string;
  glyph: "package" | "branch";
  handoffNote?: string;
  taskAgentId: string;
  sampleArtifact: MessageArtifact;
  workspace: Workspace;
  agents: AgentSummary[];
}

export function getAgentStatusItems(
  workstream: Workstream,
): AgentSummary[] {
  return workstream.agents;
}

export function getSampleMessageArtifact(
  workstream: Workstream,
): MessageArtifact {
  return workstream.sampleArtifact;
}

export function getAgentActivity(agent: AgentSummary): string {
  if (agent.activity) {
    return agent.activity;
  }
  if (agent.status === "error") {
    return "Run stopped · durable state preserved";
  }
  if (agent.status === "stopped") {
    return "Session stopped · durable state preserved";
  }
  if (agent.status === "idle") {
    return `${agent.role} · available for work`;
  }
  return `${agent.role} · ${agent.presence}`;
}

export function getAgentMessagingUnavailableReason(
  agent: AgentSummary,
): string | undefined {
  return agent.status === "error" || agent.status === "stopped"
    ? `${agent.name} cannot receive messages while its status is ${agent.status}.`
    : undefined;
}

export function getMessageTargetUnavailableReason(
  workstream: Workstream,
  target: string,
): string | undefined {
  if (target === "All agents") {
    return workstream.agents.some(
      (agent) => !getAgentMessagingUnavailableReason(agent),
    )
      ? undefined
      : "No Agent is available to receive messages in this workstream.";
  }

  const agent = workstream.agents.find((item) => item.name === target);
  return agent
    ? getAgentMessagingUnavailableReason(agent)
    : "The selected Agent is not available in this workstream.";
}

function getMessageResponder(
  workstream: Workstream,
  target: string,
): AgentSummary {
  const targetUnavailableReason = getMessageTargetUnavailableReason(
    workstream,
    target,
  );
  if (targetUnavailableReason) {
    throw new Error(targetUnavailableReason);
  }

  const availableAgents = workstream.agents.filter(
    (agent) => agent.status !== "error" && agent.status !== "stopped",
  );
  const responder =
    target === "All agents"
      ? availableAgents.find((agent) => agent.status === "running") ??
        availableAgents[0]
      : workstream.agents.find((agent) => agent.name === target);

  if (!responder) {
    throw new Error("The selected Agent is not available in this workstream.");
  }

  return responder;
}

export interface PendingAgentResponse {
  workstreamId: string;
  target: string;
  responder: AgentSummary;
}

function createPendingAgentResponse(
  workstream: Workstream,
  target: string,
): PendingAgentResponse {
  return {
    workstreamId: workstream.id,
    target,
    responder: getMessageResponder(workstream, target),
  };
}

export interface StartedAgentResponse {
  workstream: Workstream;
  pending: PendingAgentResponse;
}

export type AgentResponseCompletion =
  | {
      status: "completed";
      workstream: Workstream;
    }
  | {
      status: "canceled";
      workstream: Workstream;
      reason: string;
    };

export function startAgentResponse(
  workstream: Workstream,
  body: string,
  target: string,
  artifact?: MessageArtifact,
): StartedAgentResponse {
  const pending = createPendingAgentResponse(workstream, target);
  const responder = pending.responder;

  return {
    workstream: {
      ...workstream,
      workspace: sendHumanMessage(
        workstream.workspace,
        body,
        target,
        artifact,
      ),
      agents: workstream.agents.map((agent) =>
        agent.id === responder.id && agent.status !== "running"
          ? {
              ...agent,
              status: "running",
              presence: "Responding now",
              activity:
                target === "All agents"
                  ? "Responding to the shared workstream"
                  : "Responding to a direct message",
            }
          : agent,
      ),
    },
    pending,
  };
}

export function completeAgentResponse(
  workstream: Workstream,
  pending: PendingAgentResponse,
): AgentResponseCompletion {
  if (pending.workstreamId !== workstream.id) {
    throw new Error("The pending response belongs to another workstream.");
  }
  const responder = workstream.agents.find(
    (agent) => agent.id === pending.responder.id,
  );
  if (!responder) {
    return {
      status: "canceled",
      workstream,
      reason: "The responding Agent no longer exists in this workstream.",
    };
  }
  const unavailableReason = getAgentMessagingUnavailableReason(responder);
  if (unavailableReason) {
    return {
      status: "canceled",
      workstream,
      reason: unavailableReason,
    };
  }
  const workspace = appendAgentResponse(
    workstream.workspace,
    pending.target,
    responder,
  );
  const hasRunningRun = workspace.runs.some(
    (run) => run.agentId === responder.id && run.status === "running",
  );

  return {
    status: "completed",
    workstream: {
      ...workstream,
      workspace,
      agents: workstream.agents.map((agent) =>
        agent.id === responder.id &&
        !hasRunningRun &&
        pending.responder.status !== "running"
          ? {
              ...agent,
              status: pending.responder.status,
              presence: pending.responder.presence,
              activity: pending.responder.activity,
            }
          : agent,
      ),
    },
  };
}

export interface ProductState {
  workstreams: Workstream[];
  selectedWorkstreamId: string;
}

export const PUBLIC_SNAPSHOT_FILENAME =
  "torsor-public-prototype-snapshot.json";

export function getAuthoritySummary(workstream: Workstream): string {
  return [
    "Torsor authority summary",
    `Workstream: ${workstream.name}`,
    `Deploying human: ${DEPLOYING_HUMAN.name}`,
    "Human approval is required to complete durable work.",
    "Agent runs may investigate and submit evidence locally.",
    "Uncertain external effects require reconciliation before retry.",
  ].join("\n");
}

export function getConversationContextSummary(
  workstream: Workstream,
): string {
  const counts = getWorkspaceCounts(workstream.workspace);
  return [
    "Torsor conversation context",
    `Workstream: ${workstream.name}`,
    `Context: ${workstream.context}`,
    `Tasks: ${counts.taskCount}`,
    `Runs: ${workstream.workspace.runs.length}`,
    `Pending human actions: ${counts.pendingActionCount}`,
  ].join("\n");
}

export function getPublicPrototypeSnapshot(product: ProductState): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      product,
    },
    null,
    2,
  );
}

export type WorkspaceObjectType =
  | "workstream"
  | "message"
  | "task"
  | "run"
  | "result"
  | "decision"
  | "effect";

export interface WorkspaceObjectTarget {
  type: WorkspaceObjectType;
  id: string;
}

export interface WorkspaceDestination {
  workstreamId: string;
  selectedAgent: string | null;
  view: "conversation" | "tasks";
  target: WorkspaceObjectTarget;
}

export interface ProductNavigationItem {
  id: string;
  workstreamId: string;
  title: string;
  meta: string;
  destination: WorkspaceDestination;
}

export interface ProductNavigation {
  inboxItems: ProductNavigationItem[];
  pendingItems: ProductNavigationItem[];
  activityItems: ProductNavigationItem[];
  counts: {
    inbox: number;
    pending: number;
    recent: number;
  };
}

export interface ConversationContext {
  workstreamId: string;
  selectedAgent: string | null;
}

export interface ComposerState {
  composer: string;
  attachedArtifact: MessageArtifact | null;
  agentCommand: boolean;
  target: string;
  editingMessageId: string | null;
}

export interface MessageEditability {
  editable: boolean;
  reason?: string;
}

export function getMessageEditability(
  workspace: Workspace,
  messageId: string,
): MessageEditability {
  const message = workspace.messages.find((item) => item.id === messageId);
  if (!message) {
    return {
      editable: false,
      reason: "The selected message does not exist.",
    };
  }
  if (message.author === "agent") {
    return {
      editable: false,
      reason: "Only human messages can be edited.",
    };
  }
  const promoted =
    workspace.tasks.some((task) => task.sourceMessageId === messageId) ||
    workspace.decisions.some(
      (decision) => decision.sourceMessageId === messageId,
    );
  if (promoted) {
    return {
      editable: false,
      reason: "Promoted messages cannot be edited.",
    };
  }
  return { editable: true };
}

function getEditableHumanMessage(
  workspace: Workspace,
  messageId: string,
): Message {
  const editability = getMessageEditability(workspace, messageId);
  if (!editability.editable) {
    throw new Error(editability.reason);
  }
  const message = workspace.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error("The selected message does not exist.");
  }
  return message;
}

export function getComposerStateForMessageEdit(
  workspace: Workspace,
  messageId: string,
  state: ComposerState,
): ComposerState {
  const message = getEditableHumanMessage(workspace, messageId);

  return {
    composer: message.body,
    attachedArtifact: null,
    agentCommand: false,
    target: state.target,
    editingMessageId: message.id,
  };
}

export function getComposerStateAfterEditCancel(
  state: ComposerState,
): ComposerState {
  return {
    ...state,
    composer: "",
    attachedArtifact: null,
    agentCommand: false,
    editingMessageId: null,
  };
}

export function getComposerStateAfterConversationChange(
  state: ComposerState,
  previous: ConversationContext,
  next: ConversationContext,
): ComposerState {
  if (
    previous.workstreamId === next.workstreamId &&
    previous.selectedAgent === next.selectedAgent
  ) {
    return state;
  }

  return {
    composer: "",
    attachedArtifact: null,
    agentCommand: false,
    target: next.selectedAgent ?? "All agents",
    editingMessageId: null,
  };
}

export interface SearchResult {
  id: string;
  kind: "workstream" | "message" | "task";
  workstreamId: string;
  title: string;
  detail: string;
}

export type SearchDestination = WorkspaceDestination;

function getMessageSelectedAgent(
  workstream: Workstream,
  message: Message,
): string | null {
  if (
    message.author === "agent" &&
    workstream.agents.some((agent) => agent.name === message.authorName)
  ) {
    return message.authorName;
  }
  if (
    message.author === "human" &&
    message.recipient &&
    message.recipient !== "All agents"
  ) {
    return message.recipient;
  }
  return null;
}

export function getSearchDestination(
  product: ProductState,
  result: SearchResult,
): SearchDestination {
  const workstream = product.workstreams.find(
    (item) => item.id === result.workstreamId,
  );

  if (!workstream) {
    throw new Error("The search result workstream does not exist.");
  }
  if (result.kind === "workstream") {
    if (result.id !== workstream.id) {
      throw new Error("The search result workstream does not match.");
    }

    return {
      workstreamId: workstream.id,
      selectedAgent: null,
      view: "conversation",
      target: { type: "workstream", id: workstream.id },
    };
  }
  if (result.kind === "task") {
    if (!workstream.workspace.tasks.some((task) => task.id === result.id)) {
      throw new Error("The search result task does not exist.");
    }

    return {
      workstreamId: workstream.id,
      selectedAgent: null,
      view: "tasks",
      target: { type: "task", id: result.id },
    };
  }
  const message = workstream.workspace.messages.find(
    (item) => item.id === result.id,
  );

  if (!message) {
    throw new Error("The search result message does not exist.");
  }

  return {
    workstreamId: workstream.id,
    selectedAgent: getMessageSelectedAgent(workstream, message),
    view: "conversation",
    target: { type: "message", id: message.id },
  };
}

export interface AgentWorkspaceScope {
  runs: Run[];
  tasks: Task[];
  results: Result[];
  externalEffects: ExternalEffect[];
}

export interface WorkstreamLogItem {
  id: string;
  time: string;
  tone: "error" | "success" | "info" | "warning";
  message: string;
}

export function getAgentWorkspaceScope(
  workstream: Workstream,
  selectedAgent: string | null,
): AgentWorkspaceScope {
  const workspace = workstream.workspace;
  if (!selectedAgent) {
    return {
      runs: workspace.runs,
      tasks: workspace.tasks,
      results: workspace.results,
      externalEffects: workspace.externalEffects,
    };
  }

  const agent = workstream.agents.find((item) => item.name === selectedAgent);
  const runs = agent
    ? workspace.runs.filter((run) => run.agentId === agent.id)
    : [];
  const scopedRunIds = new Set(runs.map((run) => run.id));
  const scopedTaskIds = new Set(runs.map((run) => run.taskId));

  return {
    runs,
    tasks: workspace.tasks.filter((task) => scopedTaskIds.has(task.id)),
    results: workspace.results.filter((result) =>
      scopedRunIds.has(result.runId),
    ),
    externalEffects: workspace.externalEffects.filter((effect) =>
      scopedTaskIds.has(effect.taskId),
    ),
  };
}

export function getAgentDisplayItems(
  workstream: Workstream,
): AgentDisplayItem[] {
  return workstream.agents.map((agent) => {
    const scope = getAgentWorkspaceScope(workstream, agent.name);
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      model: agent.model,
      activity: getAgentActivity(agent),
      taskCount: scope.tasks.length,
      runCount: scope.runs.length,
      tokenCount: agent.metrics?.tokenCount,
      activeDurationMinutes: agent.metrics?.activeDurationMinutes,
      progressPercent: agent.metrics?.progressPercent,
    };
  });
}

export function getWorkstreamLogItems(
  workstream: Workstream,
  selectedAgent: string | null,
): WorkstreamLogItem[] {
  const { runs, externalEffects } = getAgentWorkspaceScope(
    workstream,
    selectedAgent,
  );
  const runItems: WorkstreamLogItem[] = runs.map((run) => ({
    id: run.id,
    time: run.updatedAt ?? run.recordedAt ?? "Earlier",
    tone:
      run.status === "failed"
        ? "error"
        : run.status === "completed"
          ? "success"
          : "info",
    message: `${getRunAgentName(workstream, run)} ${run.status} ${run.id} for ${run.taskId}`,
  }));
  const effectItems: WorkstreamLogItem[] = externalEffects.map((effect) => ({
    id: effect.id,
    time: effect.updatedAt ?? effect.recordedAt ?? "Earlier",
    tone: effect.status === "uncertain" ? "warning" : "success",
    message:
      effect.status === "uncertain"
        ? `external receipt uncertain: ${effect.title}`
        : `external receipt reconciled: ${effect.title}`,
  }));

  return [...runItems, ...effectItems].sort(
    (left, right) => getActivityRank(right.time) - getActivityRank(left.time),
  );
}

export function isMessageVisibleInAgentConversation(
  message: Message,
  selectedAgent: string | null,
): boolean {
  if (message.author === "agent") {
    return !selectedAgent || message.authorName === selectedAgent;
  }
  return (
    !message.recipient ||
    message.recipient === "All agents" ||
    message.recipient === selectedAgent
  );
}

export function getDisplayedExternalEffect(
  workspace: Workspace,
): ExternalEffect | undefined {
  return (
    workspace.externalEffects.find((effect) => effect.status === "uncertain") ??
    workspace.externalEffects
      .filter((effect) => effect.status === "confirmed")
      .at(-1)
  );
}

export function getWorkspaceCounts(workspace: Workspace): WorkspaceCounts {
  const reviewCount = workspace.results.filter(
    (result) => result.reviewState === "pending",
  ).length;

  return {
    taskCount: workspace.tasks.length,
    reviewCount,
    pendingActionCount: getExecutableHumanActions(workspace).length,
  };
}

interface ExecutableHumanAction {
  kind: "review" | "reconcile" | "retry" | "follow-up";
  target: WorkspaceObjectTarget;
  title: string;
  meta: string;
}

function getExecutableHumanActions(
  workspace: Workspace,
): ExecutableHumanAction[] {
  const reviewActions = workspace.results
    .filter((result) => result.reviewState === "pending")
    .map((result) => {
      const task = workspace.tasks.find((item) => item.id === result.taskId);
      return {
        kind: "review" as const,
        target: { type: "result" as const, id: result.id },
        title: `Review ${task?.title ?? result.summary}`,
        meta: "Human review",
      };
    });
  const reconciliationActions = workspace.externalEffects
    .filter((effect) => effect.status === "uncertain")
    .map((effect) => ({
      kind: "reconcile" as const,
      target: { type: "effect" as const, id: effect.id },
      title: `Reconcile ${effect.title}`,
      meta: "External effect",
    }));
  const taskActions = workspace.tasks.flatMap<ExecutableHumanAction>((task) => {
    const action = canRetryTask(workspace, task.id)
      ? ({
          kind: "retry" as const,
          title: `Retry ${task.title}`,
        })
      : canStartFollowUpRun(workspace, task.id)
        ? ({
            kind: "follow-up" as const,
            title: `Start follow-up for ${task.title}`,
          })
        : null;

    return action
      ? [
          {
            ...action,
            target: { type: "task", id: task.id },
            meta: "Durable task",
          },
        ]
      : [];
  });

  return [...reviewActions, ...reconciliationActions, ...taskActions];
}

function getActionItemsForWorkstream(
  workstream: Workstream,
): ProductNavigationItem[] {
  return getExecutableHumanActions(workstream.workspace).map((action) => ({
    id: `${workstream.id}:action:${action.kind}:${action.target.id}`,
    workstreamId: workstream.id,
    title: action.title,
    meta: `${workstream.name} · ${action.meta}`,
    destination: {
      workstreamId: workstream.id,
      selectedAgent: null,
      view: "tasks",
      target: action.target,
    },
  }));
}

export function getProductNavigation(
  product: ProductState,
): ProductNavigation {
  const actionItems = product.workstreams.flatMap(getActionItemsForWorkstream);
  const activityItems = product.workstreams
    .flatMap(getActivityItemsForWorkstream)
    .sort(
      (left, right) =>
        getActivityRank(right.time) - getActivityRank(left.time),
    )
    .map(({ time: _time, ...item }) => item);

  return {
    inboxItems: actionItems,
    pendingItems: actionItems,
    activityItems,
    counts: {
      inbox: actionItems.length,
      pending: actionItems.length,
      recent: activityItems.length,
    },
  };
}

interface TimedNavigationItem extends ProductNavigationItem {
  time: string;
}

function getActivityRank(time: string): number {
  if (time === "Now") {
    return Number.MAX_SAFE_INTEGER;
  }

  const match = /^(\d{2}):(\d{2})$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

export function getRunAgentName(
  workstream: Workstream,
  run: Run,
): string {
  return (
    workstream.agents.find((agent) => agent.id === run.agentId)?.name ??
    run.agentId
  );
}

function getActivityItemsForWorkstream(
  workstream: Workstream,
): TimedNavigationItem[] {
  const { workspace } = workstream;
  const resultItems: TimedNavigationItem[] = workspace.results.map((result) => {
    const task = workspace.tasks.find((item) => item.id === result.taskId);
    const time = result.updatedAt ?? result.recordedAt ?? "Earlier";
    const action =
      result.reviewState === "approved"
        ? "Result approved for"
        : result.reviewState === "changes_requested"
          ? "Changes requested for"
          : "Result submitted for";

    return {
      id: `${workstream.id}:activity:result:${result.id}`,
      workstreamId: workstream.id,
      title: `${action} ${task?.title ?? result.summary}`,
      meta: `${workstream.name} · ${time}`,
      time,
      destination: {
        workstreamId: workstream.id,
        selectedAgent: null,
        view: "tasks",
        target: { type: "result", id: result.id },
      },
    };
  });
  const effectItems: TimedNavigationItem[] = workspace.externalEffects.map((effect) => {
    const time = effect.updatedAt ?? effect.recordedAt ?? "Earlier";
    return {
      id: `${workstream.id}:activity:effect:${effect.id}`,
      workstreamId: workstream.id,
      title:
        effect.status === "confirmed"
          ? `External effect reconciled: ${effect.title}`
          : `External effect needs reconciliation: ${effect.title}`,
      meta: `${workstream.name} · ${time}`,
      time,
      destination: {
        workstreamId: workstream.id,
        selectedAgent: null,
        view: "tasks",
        target: { type: "effect", id: effect.id },
      },
    };
  });
  const runItems: TimedNavigationItem[] = workspace.runs.map((run) => {
    const time = run.updatedAt ?? run.recordedAt ?? "Earlier";
    const action =
      run.status === "running"
        ? "started"
        : run.status === "completed"
          ? "completed"
          : "stopped";
    return {
      id: `${workstream.id}:activity:run:${run.id}`,
      workstreamId: workstream.id,
      title: `${getRunAgentName(workstream, run)} ${action} ${run.id}`,
      meta: `${workstream.name} · ${time}`,
      time,
      destination: {
        workstreamId: workstream.id,
        selectedAgent: null,
        view: "tasks",
        target: { type: "run", id: run.id },
      },
    };
  });
  const decisionItems: TimedNavigationItem[] = workspace.decisions.map((decision) => ({
    id: `${workstream.id}:activity:decision:${decision.id}`,
    workstreamId: workstream.id,
    title: `Decision recorded: ${decision.title}`,
    meta: `${workstream.name} · ${decision.recordedAt}`,
    time: decision.recordedAt,
    destination: {
      workstreamId: workstream.id,
      selectedAgent: null,
      view: "tasks",
      target: { type: "decision" as const, id: decision.id },
    },
  }));
  const currentMessageItems: TimedNavigationItem[] = workspace.messages
    .filter((message) => message.time === "Now")
    .map((message) => ({
      id: `${workstream.id}:activity:message:${message.id}`,
      workstreamId: workstream.id,
      title: `${message.authorName} posted a message`,
      meta: `${workstream.name} · ${message.time}`,
      time: message.time,
      destination: {
        workstreamId: workstream.id,
        selectedAgent: getMessageSelectedAgent(workstream, message),
        view: "conversation" as const,
        target: { type: "message" as const, id: message.id },
      },
    }));

  return [
    ...resultItems,
    ...effectItems,
    ...runItems,
    ...decisionItems,
    ...currentMessageItems,
  ];
}

export function getTaskDisplayState(
  workspace: Workspace,
  taskId: string,
): TaskDisplayState {
  const task = workspace.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error("The selected task does not exist.");
  }
  if (task.status === "done") {
    return "done";
  }
  if (task.status === "in_review") {
    return "in-review";
  }
  if (
    workspace.runs.some(
      (run) => run.taskId === taskId && run.status === "running",
    )
  ) {
    return "in-progress";
  }
  if (getLatestRunForTask(workspace, taskId)?.status === "failed") {
    return "failed";
  }
  return "queued";
}

export function getLatestRunForTask(
  workspace: Workspace,
  taskId: string,
): Run | undefined {
  return workspace.runs
    .filter((run) => run.taskId === taskId)
    .reduce<Run | undefined>(
      (latest, run) =>
        !latest || run.attempt >= latest.attempt ? run : latest,
      undefined,
    );
}

export function canRetryTask(workspace: Workspace, taskId: string): boolean {
  if (!workspace.tasks.some((task) => task.id === taskId)) {
    throw new Error("The selected task does not exist.");
  }

  return (
    !workspace.externalEffects.some(
      (effect) => effect.taskId === taskId && effect.status === "uncertain",
    ) &&
    !workspace.runs.some(
      (run) => run.taskId === taskId && run.status === "running",
    ) && getLatestRunForTask(workspace, taskId)?.status === "failed"
  );
}

export function canStartFollowUpRun(
  workspace: Workspace,
  taskId: string,
): boolean {
  const task = workspace.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error("The selected task does not exist.");
  }

  const latestRun = getLatestRunForTask(workspace, taskId);

  return (
    task.status === "open" &&
    latestRun?.status === "completed" &&
    workspace.results.some(
      (result) =>
        result.taskId === taskId &&
        result.runId === latestRun.id &&
        result.reviewState === "changes_requested",
    ) &&
    !workspace.externalEffects.some(
      (effect) => effect.taskId === taskId && effect.status === "uncertain",
    ) &&
    !workspace.runs.some(
      (run) => run.taskId === taskId && run.status === "running",
    )
  );
}

function allocateRunId(workspace: Workspace): string {
  const existingRunIds = new Set(workspace.runs.map((run) => run.id));
  let maxNumericId = 0n;

  for (const runId of existingRunIds) {
    const match = /^run-(\d+)$/.exec(runId);
    if (match) {
      maxNumericId = maxNumericId > BigInt(match[1])
        ? maxNumericId
        : BigInt(match[1]);
    }
  }

  const runId = `run-${maxNumericId + 1n}`;
  if (existingRunIds.has(runId)) {
    throw new Error("Could not allocate a unique run ID.");
  }

  return runId;
}

export function getTaskActionTarget(
  workspace: Workspace,
  visibleTaskIds: string[],
  selectedTaskId: string | null,
  action: "retry" | "follow-up",
): string | undefined {
  const isEligible =
    action === "retry"
      ? (taskId: string) => canRetryTask(workspace, taskId)
      : (taskId: string) => canStartFollowUpRun(workspace, taskId);
  const eligibleTaskIds = visibleTaskIds.filter(isEligible);

  if (selectedTaskId) {
    return eligibleTaskIds.includes(selectedTaskId)
      ? selectedTaskId
      : undefined;
  }

  return eligibleTaskIds.length === 1 ? eligibleTaskIds[0] : undefined;
}

export function createInitialWorkspace(): Workspace {
  return {
    messages: [
      {
        id: "message-human-brief",
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "09:14",
        body: "Turn the release notes into a launch-ready update and verify the publish step.",
        taskDraft: {
          title: "Prepare the release update",
          summary: "Draft, verify, and prepare the release update for human approval.",
        },
      },
    ],
    tasks: [
      {
        id: "task-release-update",
        title: "Validate the release package",
        summary: "Confirm the package contents and record evidence for review.",
        status: "open",
        activeAgentId: "agent-nova",
        runIds: ["run-184", "run-185"],
      },
    ],
    runs: [
      {
        id: "run-184",
        taskId: "task-release-update",
        agentId: "agent-nova",
        status: "failed",
        attempt: 1,
        recordedAt: "09:18",
      },
      {
        id: "run-185",
        taskId: "task-release-update",
        agentId: "agent-nova",
        status: "running",
        attempt: 2,
        recordedAt: "09:22",
      },
    ],
    results: [],
    decisions: [],
    externalEffects: [],
  };
}

function getMessagePromotionTitle(message: Message): string {
  return message.body.length > 72
    ? `${message.body.slice(0, 69).trimEnd()}...`
    : message.body;
}

export function createTaskFromMessage(
  workspace: Workspace,
  messageId: string,
): Workspace {
  const message = workspace.messages.find((item) => item.id === messageId);

  if (!message) {
    throw new Error("The selected message does not exist.");
  }

  if (workspace.tasks.some((task) => task.sourceMessageId === messageId)) {
    throw new Error("This message already has a durable task.");
  }

  return {
    ...workspace,
    messages: workspace.messages.map((item) =>
      item.id === messageId ? { ...item, taskDraft: undefined } : item,
    ),
    tasks: [
      ...workspace.tasks,
      {
        id: `task-${messageId}`,
        title: getMessagePromotionTitle(message),
        summary: message.body,
        status: "open",
        sourceMessageId: message.id,
        runIds: [],
      },
    ],
  };
}

export function toggleMessageReaction(
  workspace: Workspace,
  messageId: string,
  emoji: string,
): Workspace {
  if (!workspace.messages.some((message) => message.id === messageId)) {
    throw new Error("The selected message does not exist.");
  }

  return {
    ...workspace,
    messages: workspace.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      const existingReaction = message.reactions?.find(
        (reaction) => reaction.emoji === emoji,
      );
      if (!existingReaction) {
        return {
          ...message,
          reactions: [
            ...(message.reactions ?? []),
            { emoji, count: 1, reactedByHuman: true },
          ],
        };
      }

      const reactedByHuman = !existingReaction.reactedByHuman;
      return {
        ...message,
        reactions: message.reactions?.map((reaction) =>
          reaction.emoji === emoji
            ? {
                ...reaction,
                reactedByHuman,
                count: Math.max(
                  0,
                  reaction.count + (reactedByHuman ? 1 : -1),
                ),
              }
            : reaction,
        ),
      };
    }),
  };
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length > 1
    ? `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`.toUpperCase()
    : name.slice(0, 1).toUpperCase();
}

export function getMessageReplySummary(message: Message): {
  count: number;
  lastReplyTime: string;
  authors: Array<{ name: string; initials: string }>;
} | null {
  const replies = message.threadReplies ?? [];
  const count = message.threadCount ?? replies.length;
  if (count === 0) {
    return null;
  }

  const authors = replies.reduce<Array<{ name: string; initials: string }>>(
    (items, reply) =>
      items.some((item) => item.name === reply.authorName)
        ? items
        : [
            ...items,
            {
              name: reply.authorName,
              initials: getInitials(reply.authorName),
            },
          ],
    [],
  );

  return {
    count,
    lastReplyTime: replies.at(-1)?.time ?? message.time,
    authors: authors.slice(-3),
  };
}

export function appendThreadReply(
  workspace: Workspace,
  messageId: string,
  body: string,
): Workspace {
  const text = body.trim();
  if (!text) {
    throw new Error("A thread reply cannot be empty.");
  }
  if (!workspace.messages.some((message) => message.id === messageId)) {
    throw new Error("The selected message does not exist.");
  }

  return {
    ...workspace,
    messages: workspace.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }

      const threadReplies = message.threadReplies ?? [];
      return {
        ...message,
        threadCount: (message.threadCount ?? threadReplies.length) + 1,
        threadReplies: [
          ...threadReplies,
          {
            id: `thread-${messageId}-${threadReplies.length + 1}`,
            author: "human",
            authorName: DEPLOYING_HUMAN.name,
            time: "Now",
            body: text,
          },
        ],
      };
    }),
  };
}

function failRun(workspace: Workspace, runId: string): Workspace {
  if (!workspace.runs.some((run) => run.id === runId)) {
    throw new Error("The selected run does not exist.");
  }

  return {
    ...workspace,
    runs: workspace.runs.map((run) =>
      run.id === runId ? { ...run, status: "failed", updatedAt: "Now" } : run,
    ),
  };
}

export function failTaskRun(
  workstream: Workstream,
  runId: string,
): Workstream {
  const run = workstream.workspace.runs.find((item) => item.id === runId);
  if (!run) {
    throw new Error("The selected run does not exist.");
  }
  if (run.status !== "running") {
    throw new Error("Only a running run can fail.");
  }
  if (!workstream.agents.some((agent) => agent.id === run.agentId)) {
    throw new Error("The run owner does not exist in this workstream.");
  }
  const workspace = failRun(workstream.workspace, runId);
  const hasAnotherRunningRun = workspace.runs.some(
    (item) => item.agentId === run.agentId && item.status === "running",
  );

  return {
    ...workstream,
    workspace,
    agents: workstream.agents.map((agent) =>
      agent.id === run.agentId && !hasAnotherRunningRun
        ? {
            ...agent,
            status: "error",
            presence: "Error · run stopped",
            activity: "Run stopped · durable state preserved",
          }
        : agent,
    ),
  };
}

function retryRun(
  workspace: Workspace,
  taskId: string,
  agentId: string,
): Workspace {
  const task = workspace.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error("The selected task does not exist.");
  }
  if (!canRetryTask(workspace, taskId)) {
    throw new Error("The selected task is not eligible for retry.");
  }

  const attempts =
    Math.max(
      0,
      ...workspace.runs
        .filter((run) => run.taskId === taskId)
        .map((run) => run.attempt),
    ) + 1;
  const runId = allocateRunId(workspace);

  return {
    ...workspace,
    tasks: workspace.tasks.map((item) =>
      item.id === taskId
        ? {
            ...item,
            activeAgentId: agentId,
            runIds: [...item.runIds, runId],
          }
        : item,
    ),
    runs: [
      ...workspace.runs,
      {
        id: runId,
        taskId,
        agentId,
        status: "running",
        attempt: attempts,
        recordedAt: "Now",
      },
    ],
  };
}

function getRunnableAgent(
  workstream: Workstream,
  agentId: string,
): AgentSummary {
  const agent = workstream.agents.find((item) => item.id === agentId);
  if (!agent) {
    throw new Error("The selected Agent does not exist in this workstream.");
  }
  const unavailableReason = getAgentRunUnavailableReason(workstream, agentId);
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }
  return agent;
}

export function getAgentRunUnavailableReason(
  workstream: Workstream,
  agentId: string,
): string | undefined {
  const agent = workstream.agents.find((item) => item.id === agentId);
  if (!agent) {
    return "The selected Agent does not exist in this workstream.";
  }
  return agent.status === "idle" || agent.status === "queued"
    ? undefined
    : `${agent.name} cannot start a run while its status is ${agent.status}.`;
}

function markAgentRunning(
  agents: AgentSummary[],
  agentId: string,
  activity: string,
): AgentSummary[] {
  return agents.map((agent) =>
    agent.id === agentId
      ? {
          ...agent,
          status: "running",
          presence: "Running now",
          activity,
        }
      : agent,
  );
}

export function retryTaskRun(
  workstream: Workstream,
  taskId: string,
  agentId: string,
): Workstream {
  const task = workstream.workspace.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error("The selected task does not exist.");
  }
  if (!canRetryTask(workstream.workspace, taskId)) {
    throw new Error("The selected task is not eligible for retry.");
  }
  getRunnableAgent(workstream, agentId);

  return {
    ...workstream,
    workspace: retryRun(workstream.workspace, taskId, agentId),
    agents: markAgentRunning(
      workstream.agents,
      agentId,
      `Working on ${task.title}`,
    ),
  };
}

function startFollowUpRun(
  workspace: Workspace,
  taskId: string,
  agentId: string,
): Workspace {
  const task = workspace.tasks.find((item) => item.id === taskId);

  if (!task) {
    throw new Error("The selected task does not exist.");
  }
  if (!canStartFollowUpRun(workspace, taskId)) {
    throw new Error("The selected task is not eligible for a follow-up run.");
  }

  const attempt =
    Math.max(
      0,
      ...workspace.runs
        .filter((run) => run.taskId === taskId)
        .map((run) => run.attempt),
    ) + 1;
  const runId = allocateRunId(workspace);

  return {
    ...workspace,
    tasks: workspace.tasks.map((item) =>
      item.id === taskId
        ? {
            ...item,
            activeAgentId: agentId,
            runIds: [...item.runIds, runId],
          }
        : item,
    ),
    runs: [
      ...workspace.runs,
      {
        id: runId,
        taskId,
        agentId,
        status: "running",
        attempt,
        recordedAt: "Now",
      },
    ],
  };
}

export function startTaskFollowUpRun(
  workstream: Workstream,
  taskId: string,
  agentId: string,
): Workstream {
  const task = workstream.workspace.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new Error("The selected task does not exist.");
  }
  if (!canStartFollowUpRun(workstream.workspace, taskId)) {
    throw new Error("The selected task is not eligible for a follow-up run.");
  }
  getRunnableAgent(workstream, agentId);

  return {
    ...workstream,
    workspace: startFollowUpRun(workstream.workspace, taskId, agentId),
    agents: markAgentRunning(
      workstream.agents,
      agentId,
      `Working on ${task.title}`,
    ),
  };
}

function submitResult(
  workspace: Workspace,
  runId: string,
  summary: string,
): Workspace {
  const run = workspace.runs.find((item) => item.id === runId);

  if (!run) {
    throw new Error("The selected run does not exist.");
  }

  return {
    ...workspace,
    tasks: workspace.tasks.map((task) =>
      task.id === run.taskId ? { ...task, status: "in_review" } : task,
    ),
    runs: workspace.runs.map((item) =>
      item.id === runId
        ? { ...item, status: "completed", updatedAt: "Now" }
        : item,
    ),
    results: [
      ...workspace.results,
      {
        id: `result-${workspace.results.length + 1}`,
        runId,
        taskId: run.taskId,
        summary,
        reviewState: "pending",
        recordedAt: "Now",
      },
    ],
  };
}

export function submitRunResult(
  workstream: Workstream,
  runId: string,
  summary: string,
): Workstream {
  const run = workstream.workspace.runs.find((item) => item.id === runId);
  if (!run) {
    throw new Error("The selected run does not exist.");
  }
  if (run.status !== "running") {
    throw new Error("Only a running run can submit a result.");
  }
  if (!workstream.agents.some((agent) => agent.id === run.agentId)) {
    throw new Error("The run owner does not exist in this workstream.");
  }
  const workspace = submitResult(workstream.workspace, runId, summary);
  const hasAnotherRunningRun = workspace.runs.some(
    (item) => item.agentId === run.agentId && item.status === "running",
  );

  return {
    ...workstream,
    workspace,
    agents: workstream.agents.map((agent) =>
      agent.id === run.agentId && !hasAnotherRunningRun
        ? {
            ...agent,
            status: "idle",
            presence: "Idle",
            activity: undefined,
          }
        : agent,
    ),
  };
}

export function approveResult(
  workspace: Workspace,
  resultId: string,
): Workspace {
  const result = workspace.results.find((item) => item.id === resultId);

  if (!result) {
    throw new Error("The selected result does not exist.");
  }

  return {
    ...workspace,
    tasks: workspace.tasks.map((task) =>
      task.id === result.taskId ? { ...task, status: "done" } : task,
    ),
    results: workspace.results.map((item) =>
      item.id === resultId
        ? { ...item, reviewState: "approved", updatedAt: "Now" }
        : item,
    ),
  };
}

export function requestChanges(
  workspace: Workspace,
  resultId: string,
): Workspace {
  const result = workspace.results.find((item) => item.id === resultId);

  if (!result) {
    throw new Error("The selected result does not exist.");
  }

  return {
    ...workspace,
    tasks: workspace.tasks.map((task) =>
      task.id === result.taskId ? { ...task, status: "open" } : task,
    ),
    results: workspace.results.map((item) =>
      item.id === resultId
        ? { ...item, reviewState: "changes_requested", updatedAt: "Now" }
        : item,
    ),
  };
}

export function recordDecision(
  workspace: Workspace,
  messageId: string,
): Workspace {
  const message = workspace.messages.find((item) => item.id === messageId);
  if (!message) {
    throw new Error("The selected message does not exist.");
  }
  if (
    workspace.decisions.some(
      (decision) => decision.sourceMessageId === messageId,
    )
  ) {
    throw new Error("This message already has a durable decision.");
  }

  return {
    ...workspace,
    decisions: [
      ...workspace.decisions,
      {
        id: `decision-${workspace.decisions.length + 1}`,
        title: getMessagePromotionTitle(message),
        detail: message.body,
        sourceMessageId: message.id,
        recordedAt: "Now",
      },
    ],
  };
}

export function reconcileExternalEffect(
  workspace: Workspace,
  effectId: string,
): Workspace {
  if (!workspace.externalEffects.some((effect) => effect.id === effectId)) {
    throw new Error("The selected external effect does not exist.");
  }

  return {
    ...workspace,
    externalEffects: workspace.externalEffects.map((effect) =>
      effect.id === effectId
        ? { ...effect, status: "confirmed", updatedAt: "Now" }
        : effect,
    ),
  };
}

export function createDemoWorkspace(): Workspace {
  const workspace = createInitialWorkspace();

  return {
    ...workspace,
    messages: [
      {
        id: "message-human-brief",
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "09:14",
        body: "Prepare the 0.8 release update. Keep the publish step separate until we can verify the external receipt.",
        reactions: [{ emoji: "✅", count: 2, reactedByHuman: false }],
        threadCount: 1,
        threadReplies: [
          {
            id: "thread-brief-1",
            author: "agent",
            authorName: "Nova",
            time: "09:15",
            body: "I will keep the external publish step separate.",
            agentMeta: { model: "sonnet-5", tokens: 96, latency: 280 },
          },
        ],
      },
      {
        id: "message-nova-plan",
        author: "agent",
        authorName: "Nova",
        role: "Implementation agent",
        sessionId: "session 01",
        time: "09:17",
        body: "I separated the durable task from the publish attempt. I will validate the package first, then submit evidence. Publishing stays blocked on explicit approval.",
        agentMeta: {
          model: "sonnet-5",
          tokens: 1240,
          latency: 1820,
        },
        artifact: {
          kind: "plan",
          label: "Proposed plan",
          title: "Validate → draft → submit for review",
          detail: "No external write is authorized in this run.",
        },
        reactions: [{ emoji: "👍", count: 2, reactedByHuman: false }],
        threadCount: 4,
        threadReplies: [
          {
            id: "thread-plan-1",
            author: "human",
            authorName: DEPLOYING_HUMAN.name,
            time: "09:18",
            body: "Keep publish reconciliation outside this plan.",
          },
          {
            id: "thread-plan-2",
            author: "agent",
            authorName: "Nova",
            time: "09:19",
            body: "Confirmed. This plan ends at a reviewable result.",
            agentMeta: { model: "sonnet-5", tokens: 180, latency: 390 },
          },
          {
            id: "thread-plan-3",
            author: "human",
            authorName: DEPLOYING_HUMAN.name,
            time: "09:20",
            body: "Add the package manifest to the evidence set.",
          },
          {
            id: "thread-plan-4",
            author: "agent",
            authorName: "Nova",
            time: "09:21",
            body: "Added. The manifest will stay attached to the run.",
            agentMeta: { model: "sonnet-5", tokens: 154, latency: 340 },
          },
        ],
      },
      {
        id: "message-nova-failure",
        author: "agent",
        authorName: "Nova",
        role: "Implementation agent",
        sessionId: "session 01 · ended",
        time: "09:31",
        body: "Run 184 stopped while reading the package manifest. The task remains open; no publish action started.",
        agentMeta: {
          model: "sonnet-5",
          tokens: 612,
          latency: 940,
        },
      },
      {
        id: "message-sable-resume",
        author: "agent",
        authorName: "Sable",
        role: "Replacement agent",
        sessionId: "session 02 · active",
        time: "09:38",
        body: "I resumed from the task record and run history. The package is valid, the release copy is drafted, and the prior failure is preserved as attempt 1.",
        agentMeta: {
          model: "sonnet-5",
          tokens: 3410,
          latency: 4230,
        },
        reactions: [
          { emoji: "👍", count: 2, reactedByHuman: false },
          { emoji: "💯", count: 1, reactedByHuman: false },
        ],
        threadCount: 4,
        threadReplies: [
          {
            id: "thread-sable-1",
            author: "human",
            authorName: DEPLOYING_HUMAN.name,
            time: "09:40",
            body: "Keep the package validation evidence attached to the run.",
          },
          {
            id: "thread-sable-2",
            author: "agent",
            authorName: "Sable",
            time: "09:41",
            body: "Confirmed. The evidence stays with run 185 and does not imply publish approval.",
            agentMeta: {
              model: "sonnet-5",
              tokens: 312,
              latency: 510,
            },
          },
          {
            id: "thread-sable-3",
            author: "human",
            authorName: DEPLOYING_HUMAN.name,
            time: "09:42",
            body: "Add the rollback note as separate durable work.",
          },
          {
            id: "thread-sable-4",
            author: "agent",
            authorName: "Sable",
            time: "09:43",
            body: "Done. The release result and rollback preparation remain independent.",
            agentMeta: {
              model: "sonnet-5",
              tokens: 248,
              latency: 430,
            },
          },
        ],
        artifact: {
          kind: "output",
          label: "Evidence bundle",
          title: "release-update.md + package-check.txt",
          detail: "2 files · deterministic sample · ready for human review",
        },
      },
      {
        id: "message-reviewer",
        author: "agent",
        authorName: "Keel",
        role: "Review agent",
        sessionId: "session 03 · active",
        time: "09:44",
        body: "The result matches the task. One external effect is still uncertain: the publish request lost its response after dispatch. Reconcile it before retrying.",
        agentMeta: {
          model: "haiku-4",
          tokens: 884,
          latency: 1260,
        },
      },
      {
        id: "message-human-followup",
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "09:47",
        body: "Prepare a short rollback note while I review the release update. Keep it as separate work so approval of the update does not imply rollback readiness.",
        taskDraft: {
          title: "Prepare a rollback note",
          summary:
            "Draft a concise rollback note with triggers, verification steps, and owner handoff.",
        },
      },
    ],
    tasks: [
      {
        ...workspace.tasks[0],
        title: "Prepare the 0.8 release update",
        summary:
          "Validate the package, draft the update, and deliver reviewable evidence.",
        status: "in_review",
        sourceMessageId: "message-human-brief",
        activeAgentId: "agent-sable",
      },
      {
        id: "task-publish-receipt",
        title: "Verify publish receipt",
        summary:
          "Determine whether the external publish request took effect before another attempt.",
        status: "open",
        activeAgentId: "agent-keel",
        runIds: ["run-186"],
      },
    ],
    runs: [
      {
        id: "run-184",
        taskId: "task-release-update",
        agentId: "agent-nova",
        status: "failed",
        attempt: 1,
        recordedAt: "09:31",
      },
      {
        id: "run-185",
        taskId: "task-release-update",
        agentId: "agent-sable",
        status: "completed",
        attempt: 2,
        recordedAt: "09:43",
      },
      {
        id: "run-186",
        taskId: "task-publish-receipt",
        agentId: "agent-keel",
        status: "failed",
        attempt: 1,
        recordedAt: "09:44",
      },
    ],
    results: [
      {
        id: "result-1",
        runId: "run-185",
        taskId: "task-release-update",
        summary:
          "Release update drafted and package evidence attached. Awaiting the deploying human.",
        reviewState: "pending",
        recordedAt: "09:44",
      },
    ],
    decisions: [
      {
        id: "decision-1",
        title: "Keep publish as a separate task",
        detail:
          "External delivery must not be implied by approving the release copy.",
        sourceMessageId: "message-human-brief",
        recordedAt: "09:19",
      },
    ],
    externalEffects: [
      {
        id: "effect-publish",
        taskId: "task-publish-receipt",
        title: "Publish request may have succeeded",
        detail:
          "The connection closed after dispatch and before a receipt was recorded.",
        status: "uncertain",
        recordedAt: "09:45",
      },
    ],
  };
}

export function createOnboardingWorkspace(): Workspace {
  return {
    messages: [
      {
        id: "message-onboarding-brief",
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "10:02",
        body: "Create a starter workspace that teaches the difference between a durable task and an agent run.",
        recipient: "All agents",
      },
      {
        id: "message-orbit-plan",
        author: "agent",
        authorName: "Orbit",
        role: "Product agent",
        sessionId: "session 04 · active",
        time: "10:05",
        body: "I will keep the explanation inside the workspace itself: one durable task, one visible run, and a clear next action for the deploying human.",
        agentMeta: {
          model: "sonnet-5",
          tokens: 920,
          latency: 1180,
        },
        artifact: {
          kind: "plan",
          label: "Workspace outline",
          title: "Start here → create work → review result",
          detail: "Three guided moments · local prototype content",
        },
      },
      {
        id: "message-human-onboarding-followup",
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "10:08",
        body: "Also make the empty state useful when no agent has started a run.",
        recipient: "Orbit",
      },
    ],
    tasks: [
      {
        id: "task-configure-starter",
        title: "Configure the starter workspace",
        summary:
          "Create guided copy and durable state examples for a first-time deploying human.",
        status: "open",
        sourceMessageId: "message-onboarding-brief",
        activeAgentId: "agent-orbit",
        runIds: ["run-201"],
      },
    ],
    runs: [
      {
        id: "run-201",
        taskId: "task-configure-starter",
        agentId: "agent-orbit",
        status: "running",
        attempt: 1,
        recordedAt: "10:05",
      },
    ],
    results: [],
    decisions: [
      {
        id: "decision-onboarding-1",
        title: "Teach with real durable objects",
        detail:
          "The starter flow uses actual prototype tasks and runs instead of a passive tour.",
        sourceMessageId: "message-orbit-plan",
        recordedAt: "10:06",
      },
    ],
    externalEffects: [],
  };
}

export function createDemoProduct(): ProductState {
  return {
    selectedWorkstreamId: "workstream-release",
    workstreams: [
      {
        id: "workstream-release",
        name: "Release 0.8",
        conversationTitle: "Launch readiness",
        context:
          "Prepare a reviewable release update while keeping external publishing explicit.",
        glyph: "package",
        handoffNote: "Nova ended. Sable continued from durable task state.",
        taskAgentId: "agent-orbit-release",
        sampleArtifact: {
          kind: "output",
          label: "Attached package observation",
          title: "package-observation.txt",
          detail: "Synthetic package evidence for Release 0.8.",
        },
        workspace: createDemoWorkspace(),
        agents: [
          {
            id: "agent-sable",
            name: "Sable",
            role: "Replacement agent",
            presence: "Running now",
            status: "running",
            model: "sonnet-5",
            responseTokens: 468,
            responseLatency: 720,
            activity: "Validating reviewable release evidence",
            metrics: {
              tokenCount: 48200,
              activeDurationMinutes: 72,
              progressPercent: 71,
            },
          },
          {
            id: "agent-keel",
            name: "Keel",
            role: "Review agent",
            presence: "Queued for review",
            status: "queued",
            model: "haiku-4",
            responseTokens: 356,
            responseLatency: 610,
            metrics: {
              tokenCount: 24100,
              activeDurationMinutes: 43,
            },
          },
          {
            id: "agent-nova",
            name: "Nova",
            role: "Implementation agent",
            presence: "Error · run stopped",
            status: "error",
            model: "sonnet-5",
            responseTokens: 522,
            responseLatency: 880,
            metrics: {
              tokenCount: 31800,
              activeDurationMinutes: 58,
            },
          },
          {
            id: "agent-orbit-release",
            name: "Orbit",
            role: "Product agent",
            presence: "Idle",
            status: "idle",
            model: "sonnet-5",
            responseTokens: 404,
            responseLatency: 690,
            metrics: {
              tokenCount: 12600,
              activeDurationMinutes: 22,
            },
          },
        ],
      },
      {
        id: "workstream-onboarding",
        name: "Onboarding flow",
        conversationTitle: "First-run handoff",
        context:
          "Teach the task and run model through a guided, durable workspace.",
        glyph: "branch",
        taskAgentId: "agent-orbit",
        sampleArtifact: {
          kind: "output",
          label: "Attached workspace observation",
          title: "starter-workspace-observation.txt",
          detail: "Synthetic onboarding evidence for Onboarding flow.",
        },
        workspace: createOnboardingWorkspace(),
        agents: [
          {
            id: "agent-orbit",
            name: "Orbit",
            role: "Product agent",
            presence: "Running now",
            status: "running",
            model: "sonnet-5",
            responseTokens: 404,
            responseLatency: 690,
            activity: "Product agent · Running now",
            metrics: {
              tokenCount: 18600,
              activeDurationMinutes: 37,
              progressPercent: 64,
            },
          },
          {
            id: "agent-keel-onboarding",
            name: "Keel",
            role: "Review agent",
            presence: "Idle",
            status: "idle",
            model: "haiku-4",
            responseTokens: 356,
            responseLatency: 610,
            metrics: {
              tokenCount: 6400,
              activeDurationMinutes: 12,
            },
          },
        ],
      },
    ],
  };
}

export function getSelectedWorkstream(product: ProductState): Workstream {
  const workstream = product.workstreams.find(
    (item) => item.id === product.selectedWorkstreamId,
  );

  if (!workstream) {
    throw new Error("The selected workstream does not exist.");
  }

  return workstream;
}

export function selectWorkstream(
  product: ProductState,
  workstreamId: string,
): ProductState {
  if (!product.workstreams.some((item) => item.id === workstreamId)) {
    throw new Error("The selected workstream does not exist.");
  }

  return {
    ...product,
    selectedWorkstreamId: workstreamId,
  };
}

export function updateSelectedWorkspace(
  product: ProductState,
  update: (workspace: Workspace) => Workspace,
): ProductState {
  return updateWorkspaceById(product, product.selectedWorkstreamId, update);
}

export function updateWorkstreamById(
  product: ProductState,
  workstreamId: string,
  update: (workstream: Workstream) => Workstream,
): ProductState {
  if (!product.workstreams.some((workstream) => workstream.id === workstreamId)) {
    throw new Error("The selected workstream does not exist.");
  }

  return {
    ...product,
    workstreams: product.workstreams.map((workstream) =>
      workstream.id === workstreamId ? update(workstream) : workstream,
    ),
  };
}

export function updateWorkspaceById(
  product: ProductState,
  workstreamId: string,
  update: (workspace: Workspace) => Workspace,
): ProductState {
  return updateWorkstreamById(product, workstreamId, (workstream) => ({
    ...workstream,
    workspace: update(workstream.workspace),
  }));
}

export function searchProduct(
  product: ProductState,
  query: string,
): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();

  if (!normalized) {
    return [];
  }

  return product.workstreams.flatMap((workstream) => {
    const results: SearchResult[] = [];

    if (
      `${workstream.name} ${workstream.conversationTitle} ${workstream.context}`
        .toLocaleLowerCase()
        .includes(normalized)
    ) {
      results.push({
        id: workstream.id,
        kind: "workstream",
        workstreamId: workstream.id,
        title: workstream.name,
        detail: workstream.context,
      });
    }

    for (const message of workstream.workspace.messages) {
      if (
        `${message.authorName} ${message.body}`
          .toLocaleLowerCase()
          .includes(normalized)
      ) {
        results.push({
          id: message.id,
          kind: "message",
          workstreamId: workstream.id,
          title: message.authorName,
          detail: message.body,
        });
      }
    }

    for (const task of workstream.workspace.tasks) {
      if (
        `${task.title} ${task.summary}`.toLocaleLowerCase().includes(normalized)
      ) {
        results.push({
          id: task.id,
          kind: "task",
          workstreamId: workstream.id,
          title: task.title,
          detail: task.summary,
        });
      }
    }

    return results;
  });
}

function sendHumanMessage(
  workspace: Workspace,
  body: string,
  recipient: string,
  artifact?: MessageArtifact,
): Workspace {
  const text = body.trim();

  if (!text) {
    throw new Error("Enter a message before sending.");
  }

  return {
    ...workspace,
    messages: [
      ...workspace.messages,
      {
        id: `message-human-${workspace.messages.length + 1}`,
        author: "human",
        authorName: DEPLOYING_HUMAN.name,
        role: "Deploying human",
        time: "Now",
        body: text,
        recipient,
        artifact,
      },
    ],
  };
}

export function updateHumanMessage(
  workspace: Workspace,
  messageId: string,
  body: string,
): Workspace {
  getEditableHumanMessage(workspace, messageId);
  const text = body.trim();
  if (!text) {
    throw new Error("Enter message text before saving.");
  }

  return {
    ...workspace,
    messages: workspace.messages.map((message) =>
      message.id === messageId
        ? { ...message, body: text, taskDraft: undefined }
        : message,
    ),
  };
}

function appendAgentResponse(
  workspace: Workspace,
  target: string,
  responder: AgentSummary,
): Workspace {
  const unavailableReason = getAgentMessagingUnavailableReason(responder);
  if (unavailableReason) {
    throw new Error(unavailableReason);
  }
  const agentName = target === "All agents" ? responder.name : target;

  if (agentName !== responder.name) {
    throw new Error("The responder does not match the message target.");
  }

  return {
    ...workspace,
    messages: [
      ...workspace.messages,
      {
        id: `message-agent-${workspace.messages.length + 1}`,
        author: "agent",
        authorName: agentName,
        role: responder.role,
        agentMeta: {
          model: responder.model,
          tokens: responder.responseTokens,
          latency: responder.responseLatency,
        },
        sessionId: "active session",
        time: "Now",
        body:
          target === "All agents"
            ? `${agentName} is taking the next step. I checked the durable state first, so the task, run history, and pending review remain the source of truth.`
            : `I checked the durable state before responding. I can continue this work without relying on another agent session's memory.`,
      },
    ],
  };
}

export function createLocalTask(
  workspace: Workspace,
  title: string,
  summary: string,
): Workspace {
  const normalizedTitle = title.trim();

  if (!normalizedTitle) {
    throw new Error("Enter a task title.");
  }

  return {
    ...workspace,
    tasks: [
      ...workspace.tasks,
      {
        id: `task-local-${workspace.tasks.length + 1}`,
        title: normalizedTitle,
        summary: summary.trim() || "No summary provided.",
        status: "open",
        runIds: [],
      },
    ],
  };
}

export function createLocalWorkstream(
  product: ProductState,
  name: string,
): ProductState {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Enter a workstream name.");
  }

  const id = `workstream-local-${product.workstreams.length + 1}`;
  const workspace: Workspace = {
    messages: [
      {
        id: `message-${id}-welcome`,
        author: "agent",
        authorName: "Torsor",
        role: "Workspace guide",
        time: "Now",
        body: "This workstream is ready. Start with a message or create a durable task when the commitment is clear.",
      },
    ],
    tasks: [],
    runs: [],
    results: [],
    decisions: [],
    externalEffects: [],
  };

  return {
    ...product,
    selectedWorkstreamId: id,
    workstreams: [
      ...product.workstreams,
      {
        id,
        name: normalizedName,
        conversationTitle: "New workstream",
        context: "A local discovery workstream awaiting its first durable task.",
        glyph: "branch",
        taskAgentId: `agent-${id}-orbit`,
        sampleArtifact: {
          kind: "output",
          label: "Attached workstream observation",
          title: "workstream-observation.txt",
          detail: `Synthetic local evidence for ${normalizedName}.`,
        },
        workspace,
        agents: [
          {
            id: `agent-${id}-orbit`,
            name: "Orbit",
            role: "Product agent",
            presence: "Idle",
            status: "idle",
            model: "sonnet-5",
            responseTokens: 404,
            responseLatency: 690,
          },
        ],
      },
    ],
  };
}
