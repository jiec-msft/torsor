import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clipboard,
  Clock3,
  Command,
  Download,
  FileCheck2,
  FilePlus2,
  GitBranch,
  History,
  Inbox,
  ListFilter,
  ListTodo,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Play,
  Plus,
  Reply,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Terminal,
  TriangleAlert,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import {
  appendThreadReply,
  approveResult,
  canRetryTask,
  canStartFollowUpRun,
  completeAgentResponse,
  createDemoProduct,
  createLocalTask,
  createLocalWorkstream,
  createTaskFromMessage,
  DEPLOYING_HUMAN,
  getAuthoritySummary,
  getAgentDisplayItems,
  getAgentMessagingUnavailableReason,
  getAgentRunUnavailableReason,
  getAgentWorkspaceScope,
  getAgentStatusItems,
  getArtifactCardContent,
  getComposerStateAfterConversationChange,
  getComposerStateAfterEditCancel,
  getComposerStateForMessageEdit,
  getConversationContextSummary,
  getMessageEditability,
  getMessageReplySummary,
  getMessageTargetUnavailableReason,
  getProductNavigation,
  getPublicPrototypeSnapshot,
  getRunAgentName,
  getSampleMessageArtifact,
  getSearchDestination,
  getSelectedWorkstream,
  getTaskActionTarget,
  getTaskDisplayState,
  getWorkstreamLogItems,
  getWorkspaceCounts,
  isMessageVisibleInAgentConversation,
  reconcileExternalEffect,
  recordDecision,
  requestChanges,
  retryTaskRun,
  searchProduct,
  selectWorkstream,
  startAgentResponse,
  startTaskFollowUpRun,
  toggleMessageReaction,
  updateHumanMessage,
  updateSelectedWorkspace,
  updateWorkstreamById,
  type AgentDisplayItem,
  type Message,
  type MessageArtifact,
  type PendingAgentResponse,
  type ProductState,
  type Result,
  type Run,
  type SearchResult,
  type Task,
  type TaskDisplayState,
  type Workspace,
  type WorkspaceCounts,
  type WorkspaceDestination,
  type WorkspaceObjectTarget,
  type Workstream,
  PUBLIC_SNAPSHOT_FILENAME,
} from "./domain/workspace";

type MobileView = "threads" | "conversation" | "state";
type OverlayKind =
  | "search"
  | "inbox"
  | "pending"
  | "activity"
  | "authority"
  | "artifact"
  | "workspace-menu"
  | "preferences"
  | "profile-menu"
  | "conversation-menu"
  | "message-menu"
  | "agent-picker"
  | "create-workstream"
  | "create-task"
  | "attach";

interface OverlayState {
  kind: OverlayKind;
  artifactTitle?: string;
  artifactDetail?: string;
  messageId?: string;
}

const agentColorTones = ["blue", "green", "violet", "amber"] as const;

function getWorkspaceObjectElementId(target: WorkspaceObjectTarget): string {
  return `workspace-object-${target.type}-${target.id}`;
}

function getAgentColor(name: string) {
  const colorIndex = Array.from(name).reduce(
    (total, character) => total + character.codePointAt(0)!,
    0,
  );
  return agentColorTones[colorIndex % agentColorTones.length];
}

function formatAgentMetrics(item: AgentDisplayItem): string {
  const parts = [
    `${item.taskCount} task${item.taskCount === 1 ? "" : "s"}`,
    `${item.runCount} run${item.runCount === 1 ? "" : "s"}`,
  ];

  if (item.tokenCount !== undefined) {
    const tokens =
      item.tokenCount >= 1000
        ? `${Number((item.tokenCount / 1000).toFixed(1))}k`
        : item.tokenCount.toLocaleString();
    parts.push(`${tokens} tokens`);
  }
  if (item.activeDurationMinutes !== undefined) {
    const hours = Math.floor(item.activeDurationMinutes / 60);
    const minutes = item.activeDurationMinutes % 60;
    parts.push(hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`);
  }

  return parts.join(" · ");
}

function StatusMark({
  tone,
  label,
}: {
  tone: "success" | "danger" | "warning" | "info" | "neutral";
  label: string;
}) {
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "danger" || tone === "warning"
        ? TriangleAlert
        : tone === "info"
          ? Activity
          : CircleDashed;

  return (
    <span className={`status status-${tone}`}>
      <Icon aria-hidden="true" size={14} />
      {label}
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
  disabled = false,
  title,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className={`avatar avatar-${getAgentColor(name)}`}>
      {name.slice(0, 1)}
    </span>
  );
}

function LeftPanel({
  product,
  current,
  selectedAgent,
  onSelectWorkstream,
  onSelectAgent,
  onOpen,
}: {
  product: ProductState;
  current: Workstream;
  selectedAgent: string | null;
  onSelectWorkstream: (id: string) => void;
  onSelectAgent: (name: string | null) => void;
  onOpen: (kind: OverlayKind) => void;
}) {
  const navigation = getProductNavigation(product);

  return (
    <aside className="left-panel" aria-label="Workstreams and conversations">
      <div className="brand-row">
        <BrandMark />
        <div>
          <strong>Torsor</strong>
          <small className="workspace-presence">
            <span className="live-dot" />
            {DEPLOYING_HUMAN.name} · online
          </small>
        </div>
        <IconButton
          label="Open workspace menu"
          onClick={() => onOpen("workspace-menu")}
        >
          <ChevronDown aria-hidden="true" size={17} />
        </IconButton>
      </div>

      <button
        className="search-box"
        type="button"
        onClick={() => onOpen("search")}
      >
        <Search aria-hidden="true" size={17} />
        <span>Search local work</span>
        <kbd>Ctrl K</kbd>
      </button>

      <nav className="primary-nav" aria-label="Workspace views">
        <button type="button" onClick={() => onOpen("inbox")}>
          <Inbox aria-hidden="true" size={18} />
          Inbox
          <span className="count">{navigation.counts.inbox}</span>
        </button>
        <button type="button" onClick={() => onOpen("pending")}>
          <ListTodo aria-hidden="true" size={18} />
          Pending actions
          <span className="count count-warn">
            {navigation.counts.pending}
          </span>
        </button>
        <button type="button" onClick={() => onOpen("activity")}>
          <History aria-hidden="true" size={18} />
          Recent activity
          <span className="count">{navigation.counts.recent}</span>
        </button>
      </nav>

      <section className="nav-section">
        <div className="section-heading">
          <span>Channels</span>
          <IconButton
            label="Create workstream"
            onClick={() => onOpen("create-workstream")}
          >
            <Plus aria-hidden="true" size={17} />
          </IconButton>
        </div>
        <div className="workstream-list">
          {product.workstreams.map((workstream) => {
            const counts = getWorkspaceCounts(workstream.workspace);
            const selected = workstream.id === current.id;
            return (
              <button
                className={`workstream ${selected ? "active" : ""}`}
                type="button"
                key={workstream.id}
                aria-pressed={selected}
                onClick={() => onSelectWorkstream(workstream.id)}
              >
                <span className="workstream-glyph">
                  {workstream.glyph === "package" ? (
                    <Box aria-hidden="true" size={17} />
                  ) : (
                    <GitBranch aria-hidden="true" size={17} />
                  )}
                </span>
                <span>
                  <strong># {workstream.name.toLowerCase().replaceAll(" ", "-")}</strong>
                  <small>
                    {counts.taskCount} tasks · {counts.reviewCount} review
                    {counts.reviewCount === 1 ? "" : "s"}
                  </small>
                </span>
                {counts.pendingActionCount > 0 && (
                  <span className="workstream-pending">
                    {counts.pendingActionCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="nav-section conversations">
        <div className="section-heading">
          <span>Direct messages</span>
          <span className="section-count">{current.agents.length}</span>
        </div>
        {current.agents.map((agent) => (
          <button
            className={`agent-row ${
              selectedAgent === agent.name ? "selected" : ""
            }`}
            type="button"
            key={agent.id}
            onClick={() => onSelectAgent(agent.name)}
            aria-pressed={selectedAgent === agent.name}
          >
            <Avatar name={agent.name} />
            <span>
              <strong>{agent.name}</strong>
              <small>{agent.role}</small>
            </span>
            <span className={agent.status === "running" ? "presence" : ""}>
              {agent.presence}
            </span>
          </button>
        ))}
      </section>

      <section className="nav-section agent-threads">
        <div className="section-heading">
          <span>Shared thread</span>
        </div>
        <button
          className={`agent-row ${selectedAgent === null ? "selected" : ""}`}
          type="button"
          onClick={() => onSelectAgent(null)}
          aria-pressed={selectedAgent === null}
        >
          <span className="all-agent-avatar">
            <MessageSquareText aria-hidden="true" size={15} />
          </span>
          <span>
            <strong>
              workstream/{current.name.toLowerCase().replaceAll(" ", "-")}
            </strong>
            <small>Shared channel context</small>
          </span>
          <span>{current.workspace.messages.length}</span>
        </button>
      </section>

      <div className="agent-status-strip" aria-label="Agent status">
        {getAgentStatusItems(current).map((agent) => (
          <span
            className={`mini-agent status-${agent.status}`}
            key={agent.id}
            title={`${agent.name}: ${agent.status}`}
          >
            <i />
            {agent.name.slice(0, 1)}
          </span>
        ))}
        <small>agent status</small>
      </div>
      <button
        className="human-card"
        type="button"
        onClick={() => onOpen("profile-menu")}
      >
        <span
          className="human-avatar"
          role="img"
          aria-label={DEPLOYING_HUMAN.name}
        >
          {DEPLOYING_HUMAN.initials}
        </span>
        <span>
          <strong>{DEPLOYING_HUMAN.name}</strong>
          <small>Deploying human · online</small>
        </span>
        <MoreHorizontal aria-hidden="true" size={18} />
      </button>
    </aside>
  );
}

function MessageAvatar({
  name,
  human,
}: {
  name: string;
  human: boolean;
}) {
  if (human) {
    return (
      <span className="message-avatar human-message-avatar">
        <UserRound aria-hidden="true" size={19} />
      </span>
    );
  }

  return (
    <span className={`message-avatar avatar-${getAgentColor(name)}`}>
      <Bot aria-hidden="true" size={19} />
    </span>
  );
}

function TypingIndicator({ agent }: { agent: string }) {
  return (
    <div className="typing-row" role="status" aria-live="polite">
      <Avatar name={agent} />
      <div>
        <strong>{agent} is reading durable state</strong>
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

function ThreadPane({
  message,
  reply,
  onReplyChange,
  onSubmit,
  onClose,
}: {
  message: Message;
  reply: string;
  onReplyChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <aside className="thread-pane" aria-label={`Thread for ${message.authorName}`}>
      <header>
        <div>
          <strong>Thread</strong>
          <small>{message.threadCount ?? 0} replies · local conversation</small>
        </div>
        <IconButton label="Close thread" onClick={onClose}>
          <X aria-hidden="true" size={18} />
        </IconButton>
      </header>
      <div className="thread-scroll">
        <article className={`thread-original message-${message.author}`}>
          <MessageAvatar
            name={message.authorName}
            human={message.author === "human"}
          />
          <div>
            <div className="message-meta">
              <strong>{message.authorName}</strong>
              {message.agentMeta && (
                <>
                  <span className="model-label">{message.agentMeta.model}</span>
                  <span className="technical-meta">
                    {message.agentMeta.tokens.toLocaleString()} tokens
                  </span>
                  <span className="technical-meta">
                    {(message.agentMeta.latency / 1000).toFixed(1)}s
                  </span>
                </>
              )}
              <time>{message.time}</time>
            </div>
            <p>{message.body}</p>
          </div>
        </article>
        <div className="thread-divider">
          <span />
          {message.threadCount ?? 0} replies
          <span />
        </div>
        {(message.threadReplies ?? []).map((item) => (
          <article className={`thread-reply message-${item.author}`} key={item.id}>
            <MessageAvatar
              name={item.authorName}
              human={item.author === "human"}
            />
            <div>
              <div className="message-meta">
                <strong>{item.authorName}</strong>
                {item.agentMeta && (
                  <>
                    <span className="model-label">{item.agentMeta.model}</span>
                    <span className="technical-meta">
                      {item.agentMeta.tokens.toLocaleString()} tokens
                    </span>
                    <span className="technical-meta">
                      {(item.agentMeta.latency / 1000).toFixed(1)}s
                    </span>
                  </>
                )}
                <time>{item.time}</time>
              </div>
              <p>{item.body}</p>
            </div>
          </article>
        ))}
      </div>
      <form className="thread-composer" onSubmit={submit}>
        <label htmlFor="thread-reply">Reply in thread</label>
        <div>
          <textarea
            id="thread-reply"
            rows={2}
            value={reply}
            onChange={(event) => onReplyChange(event.target.value)}
            placeholder="Write a reply…"
          />
          <button
            className="send-button"
            type="submit"
            aria-label="Send thread reply"
            disabled={!reply.trim()}
          >
            <ArrowUp aria-hidden="true" size={18} />
          </button>
        </div>
      </form>
    </aside>
  );
}

function CenterPanel({
  current,
  selectedAgent,
  target,
  composer,
  attachedArtifact,
  typingAgent,
  notice,
  agentCommand,
  revealMessageId,
  threadMessage,
  threadReply,
  editingMessage,
  onComposerChange,
  onToggleCommand,
  onCancelEdit,
  onThreadReplyChange,
  onSubmitThreadReply,
  onCloseThread,
  onOpenThread,
  onEditMessage,
  onOpenMessageMenu,
  onSubmit,
  onCreateTask,
  onReact,
  onRecordDecision,
  onOpen,
  onShowState,
  onMessageRevealed,
}: {
  current: Workstream;
  selectedAgent: string | null;
  target: string;
  composer: string;
  attachedArtifact: MessageArtifact | null;
  typingAgent: string | null;
  notice: string;
  agentCommand: boolean;
  revealMessageId: string | null;
  threadMessage: Message | null;
  threadReply: string;
  editingMessage: Message | null;
  onComposerChange: (value: string) => void;
  onToggleCommand: () => void;
  onCancelEdit: () => void;
  onThreadReplyChange: (value: string) => void;
  onSubmitThreadReply: () => void;
  onCloseThread: () => void;
  onOpenThread: (messageId: string) => void;
  onEditMessage: (messageId: string) => void;
  onOpenMessageMenu: (messageId: string) => void;
  onSubmit: () => void;
  onCreateTask: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  onRecordDecision: (messageId: string) => void;
  onOpen: (kind: OverlayKind, artifact?: { title: string; detail: string }) => void;
  onShowState: () => void;
  onMessageRevealed: () => void;
}) {
  const typing = typingAgent !== null;
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const messages = current.workspace.messages.filter((message) =>
    isMessageVisibleInAgentConversation(message, selectedAgent),
  );
  const messageTargetUnavailableReason = editingMessage
    ? undefined
    : getMessageTargetUnavailableReason(current, target);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: typing ? "smooth" : "auto",
    });
  }, [messages.length, typing]);

  useEffect(() => {
    if (!revealMessageId) {
      return;
    }

    const message = messageRefs.current.get(revealMessageId);
    if (!message) {
      return;
    }

    message.scrollIntoView({ block: "center" });
    message.focus({ preventScroll: true });
    onMessageRevealed();
  }, [
    current.id,
    messages.length,
    onMessageRevealed,
    revealMessageId,
    selectedAgent,
  ]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <main
      className={`center-panel ${threadMessage ? "thread-open" : ""}`}
      id="main-content"
    >
      <header className="conversation-header">
        <div>
          <div className="header-kicker">
            <span className="live-dot" />
            {current.name}
            {selectedAgent && <span>with {selectedAgent}</span>}
          </div>
          <h1>
            {selectedAgent ? `${selectedAgent} conversation` : current.conversationTitle}
          </h1>
          <p>{current.context}</p>
        </div>
        <div className="header-actions">
          <div className="participants" aria-label="Active agent sessions">
            {current.agents.slice(0, 4).map((agent) => (
              <Avatar name={agent.name} key={agent.id} />
            ))}
          </div>
          <button className="quiet-button" type="button" onClick={onShowState}>
            <PanelRight aria-hidden="true" size={17} />
            Work state
          </button>
          <IconButton
            label="Open conversation menu"
            onClick={() => onOpen("conversation-menu")}
          >
            <MoreHorizontal aria-hidden="true" size={20} />
          </IconButton>
        </div>
      </header>

      <div className="context-strip">
        <ShieldCheck aria-hidden="true" size={17} />
        <span>Messages stay conversational until you create durable work.</span>
        <button type="button" onClick={() => onOpen("authority")}>
          View authority
        </button>
      </div>

      <div className="message-list" ref={messageListRef}>
        <div className="timeline-date">
          <span>Today</span>
        </div>
        {messages.length === 0 ? (
          <div className="empty-thread">
            <MessageSquareText aria-hidden="true" size={24} />
            <strong>No direct messages yet</strong>
            <p>Send a message to start this agent-specific thread.</p>
          </div>
        ) : (
          messages.map((message) => {
            const linkedTask = current.workspace.tasks.some(
              (task) => task.sourceMessageId === message.id,
            );
            const recordedDecision = current.workspace.decisions.some(
              (decision) => decision.sourceMessageId === message.id,
            );
            const editability = getMessageEditability(
              current.workspace,
              message.id,
            );
            const promotionBlocked = editingMessage?.id === message.id;
            const replySummary = getMessageReplySummary(message);
            const artifactContent = message.artifact
              ? getArtifactCardContent(message.artifact)
              : null;
            return (
              <article
                className={`message message-${message.author}`}
                key={message.id}
                data-message-id={message.id}
                ref={(element) => {
                  if (element) {
                    messageRefs.current.set(message.id, element);
                  } else {
                    messageRefs.current.delete(message.id);
                  }
                }}
                tabIndex={-1}
                aria-label={`Message from ${message.authorName} at ${message.time}`}
              >
                <MessageAvatar
                  name={message.authorName}
                  human={message.author === "human"}
                />
                <div className="message-content">
                <div className="message-meta">
                  <strong>{message.authorName}</strong>
                  {message.agentMeta && (
                    <span className="model-label">{message.agentMeta.model}</span>
                  )}
                  {message.agentMeta && (
                    <>
                      <span className="technical-meta">
                        {message.agentMeta.tokens.toLocaleString()} tokens
                      </span>
                      <span className="technical-meta">
                        {(message.agentMeta.latency / 1000).toFixed(1)}s
                      </span>
                    </>
                  )}
                  <time>{message.time}</time>
                  <span>{message.role}</span>
                  {message.sessionId && (
                    <span className="session-label">{message.sessionId}</span>
                  )}
                  {message.recipient && (
                    <span className="recipient-label">to {message.recipient}</span>
                  )}
                </div>
                <p>{message.body}</p>

                {message.artifact && artifactContent && (
                  <div className={`inline-artifact artifact-${message.artifact.kind ?? "output"}`}>
                    <div className="artifact-heading">
                      <span>
                        <Terminal aria-hidden="true" size={14} />
                        <b>{artifactContent.badge}</b>
                        {artifactContent.label}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          onOpen("artifact", {
                            title: message.artifact!.title,
                            detail: message.artifact!.detail,
                          })
                        }
                      >
                        Open
                      </button>
                    </div>
                    <div className="artifact-body">
                      <strong>{artifactContent.title}</strong>
                      <p>{artifactContent.detail}</p>
                    </div>
                  </div>
                )}

                {message.author === "human" && (
                  <div className="durable-actions">
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => onCreateTask(message.id)}
                      disabled={Boolean(linkedTask) || promotionBlocked}
                      title={
                        linkedTask
                          ? "This message is already linked to a durable task."
                          : promotionBlocked
                            ? "Save or cancel this edit before creating a task."
                          : undefined
                      }
                    >
                      {linkedTask ? (
                        <Check aria-hidden="true" size={16} />
                      ) : (
                        <ListTodo aria-hidden="true" size={16} />
                      )}
                      {linkedTask ? "Task created" : "Create task"}
                    </button>
                    <button
                      className="action-button"
                      type="button"
                      onClick={() => onRecordDecision(message.id)}
                      disabled={Boolean(recordedDecision) || promotionBlocked}
                      title={
                        recordedDecision
                          ? "This message is already linked to a durable decision."
                          : promotionBlocked
                            ? "Save or cancel this edit before recording a decision."
                          : undefined
                      }
                    >
                      {recordedDecision ? (
                        <Check aria-hidden="true" size={16} />
                      ) : (
                        <ShieldCheck aria-hidden="true" size={16} />
                      )}
                      {recordedDecision ? "Decision recorded" : "Record decision"}
                    </button>
                  </div>
                )}

                {message.reactions && message.reactions.length > 0 && (
                  <div className="message-reactions" aria-label="Message reactions">
                    {message.reactions.map((reaction) => (
                    <button
                      className={reaction.reactedByHuman ? "reacted" : ""}
                      type="button"
                      key={reaction.emoji}
                      onClick={() => onReact(message.id, reaction.emoji)}
                      aria-label={`${reaction.emoji} reaction, ${reaction.count}`}
                      aria-pressed={reaction.reactedByHuman ?? false}
                    >
                      <span aria-hidden="true">{reaction.emoji}</span>
                      {reaction.count}
                    </button>
                    ))}
                  </div>
                )}

                {replySummary ? (
                  <div className="reply-summary">
                    <button
                      className="reply-authors"
                      type="button"
                      onClick={() => onOpenThread(message.id)}
                      aria-label={`Open thread with ${replySummary.count} replies`}
                    >
                      {replySummary.authors.map((author) => (
                        <span key={author.name} title={author.name}>
                          {author.initials}
                        </span>
                      ))}
                    </button>
                    <button
                      className="reply-link"
                      type="button"
                      onClick={() => onOpenThread(message.id)}
                    >
                      {replySummary.count} replies
                    </button>
                    <span>Last reply {replySummary.lastReplyTime}</span>
                  </div>
                ) : (
                  <button
                    className="thread-hover-affordance"
                    type="button"
                    onClick={() => onOpenThread(message.id)}
                  >
                    <Reply aria-hidden="true" size={13} />
                    reply in thread
                  </button>
                )}
              </div>

              <div className="message-hover-actions" aria-label="Message actions">
                {editability.editable && (
                  <IconButton
                    label={`Edit ${message.authorName}'s message`}
                    onClick={() => onEditMessage(message.id)}
                  >
                    <SquarePen aria-hidden="true" size={15} />
                  </IconButton>
                )}
                <IconButton
                  label="More message actions"
                  onClick={() => onOpenMessageMenu(message.id)}
                >
                  <MoreHorizontal aria-hidden="true" size={16} />
                </IconButton>
              </div>
              </article>
            );
          })
        )}

        {current.handoffNote && !selectedAgent && (
          <div className="handoff-marker">
            <span className="handoff-line" />
            <div>
              <RefreshCw aria-hidden="true" size={16} />
              {current.handoffNote}
            </div>
            <span className="handoff-line" />
          </div>
        )}
        {typingAgent && <TypingIndicator agent={typingAgent} />}
      </div>

      <div className="composer-wrap">
        <div className="live-notice" aria-live="polite">
          {notice}
        </div>
        <form
          className={`composer ${agentCommand ? "command-mode" : ""} ${
            editingMessage ? "edit-mode" : ""
          }`}
          aria-busy={typing && !editingMessage}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {attachedArtifact && !editingMessage && (
            <div className="attachment-chip">
              <FileCheck2 aria-hidden="true" size={15} />
              {attachedArtifact.title}
              <span>ready to send</span>
            </div>
          )}
          <div className="composer-mode-row">
            {editingMessage ? (
              <>
                <span className="editing-indicator">
                  <SquarePen aria-hidden="true" size={14} />
                  Editing message to{" "}
                  {editingMessage.recipient ?? "the shared workstream"}
                </span>
                <button type="button" onClick={onCancelEdit}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className={agentCommand ? "active" : ""}
                  aria-pressed={agentCommand}
                  onClick={onToggleCommand}
                >
                  <Terminal aria-hidden="true" size={14} />
                  {agentCommand ? "Agent command" : "Message"}
                </button>
                <span>
                  {messageTargetUnavailableReason ??
                    (agentCommand
                      ? "Direct request; create durable work explicitly."
                      : "Conversation remains non-durable.")}
                </span>
              </>
            )}
          </div>
          <label htmlFor="message-input">
            {editingMessage
              ? "Edit message"
              : agentCommand
                ? "Send an agent command"
                : "Message agents"}
          </label>
          <textarea
            id="message-input"
            name="message"
            autoComplete="off"
            rows={2}
            value={composer}
            onChange={(event) => onComposerChange(event.target.value)}
            onKeyDown={handleKeyDown}
            disabled={Boolean(messageTargetUnavailableReason)}
            title={messageTargetUnavailableReason}
            placeholder={
              editingMessage
                ? "Update this message…"
                : messageTargetUnavailableReason
                  ? messageTargetUnavailableReason
                  : agentCommand
                    ? `Ask ${target} to investigate or draft…`
                    : `Message ${target}…`
            }
          />
          <div className="composer-bottom">
            <div>
              {!editingMessage && (
                <>
                  <IconButton
                    label="Add artifact"
                    onClick={() => onOpen("attach")}
                  >
                    <Plus aria-hidden="true" size={20} />
                  </IconButton>
                  <button
                    className="agent-picker"
                    type="button"
                    onClick={() => onOpen("agent-picker")}
                  >
                    <Sparkles aria-hidden="true" size={17} />
                    {target}
                    <ChevronDown aria-hidden="true" size={15} />
                  </button>
                </>
              )}
            </div>
            <button
              className="send-button"
              type="submit"
              aria-label={editingMessage ? "Save message edit" : "Send message"}
              disabled={
                !composer.trim() ||
                (!editingMessage &&
                  (typing || Boolean(messageTargetUnavailableReason)))
              }
              title={
                messageTargetUnavailableReason ??
                (!composer.trim()
                  ? editingMessage
                    ? "Enter message text before saving."
                    : "Enter a message before sending."
                  : typing && !editingMessage
                    ? "Wait for the current response."
                    : undefined)
              }
            >
              {typing && !editingMessage ? (
                <RefreshCw className="spin" aria-hidden="true" size={19} />
              ) : (
                <ArrowUp aria-hidden="true" size={20} />
              )}
            </button>
          </div>
        </form>
        <p className="composer-hint">
          {editingMessage
            ? "Enter to save · Shift + Enter for a new line"
            : messageTargetUnavailableReason ??
              "Enter to send · Shift + Enter for a new line"}
        </p>
      </div>
      {threadMessage && (
        <ThreadPane
          message={threadMessage}
          reply={threadReply}
          onReplyChange={onThreadReplyChange}
          onSubmit={onSubmitThreadReply}
          onClose={onCloseThread}
        />
      )}
    </main>
  );
}

function TaskCard({
  task,
  activeAgentName,
  visualStatus,
  selected,
  focused,
  onSelect,
}: {
  task: Task;
  activeAgentName: string;
  visualStatus: TaskDisplayState;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const target = { type: "task", id: task.id } as const;

  return (
    <button
      className={`state-card task-card task-${visualStatus} ${selected ? "selected" : ""}`}
      type="button"
      aria-expanded={selected}
      aria-current={focused ? "true" : undefined}
      id={getWorkspaceObjectElementId(target)}
      onClick={onSelect}
    >
      <div className="card-topline">
        <span className="state-id">{task.id.replace("task-", "T-")}</span>
        <span className="task-status-label">{visualStatus.replace("-", " ")}</span>
      </div>
      <h3>{task.title}</h3>
      {selected && <p>{task.summary}</p>}
      <div className="card-foot">
        <span>
          <Bot aria-hidden="true" size={15} />
          {activeAgentName}
        </span>
        <span>{task.runIds.length} attempts</span>
      </div>
    </button>
  );
}

function RunRow({
  run,
  agentName,
  focused,
}: {
  run: Run;
  agentName: string;
  focused: boolean;
}) {
  const target = { type: "run", id: run.id } as const;

  return (
    <div
      className={`run-row ${focused ? "destination-focused" : ""}`}
      aria-current={focused ? "true" : undefined}
      id={getWorkspaceObjectElementId(target)}
    >
      <span className={`run-icon run-${run.status}`}>
        {run.status === "failed" ? (
          <X aria-hidden="true" size={14} />
        ) : run.status === "completed" ? (
          <Check aria-hidden="true" size={14} />
        ) : (
          <Play aria-hidden="true" size={13} />
        )}
      </span>
      <div>
        <strong>
          {run.id} · attempt {run.attempt}
        </strong>
        <small>{agentName}</small>
      </div>
      <StatusMark
        tone={
          run.status === "failed"
            ? "danger"
            : run.status === "completed"
              ? "success"
              : "info"
        }
        label={run.status}
      />
    </div>
  );
}

function ReviewCard({
  result,
  focused,
  onApprove,
  onRequestChanges,
}: {
  result: Result;
  focused: boolean;
  onApprove: (resultId: string) => void;
  onRequestChanges: (resultId: string) => void;
}) {
  const pending = result.reviewState === "pending";
  const target = { type: "result", id: result.id } as const;

  return (
    <article
      className={`review-card review-${result.reviewState} ${
        focused ? "destination-focused" : ""
      }`}
      aria-current={focused ? "true" : undefined}
      id={getWorkspaceObjectElementId(target)}
    >
      <div className="review-heading">
        <span className="review-icon">
          <FileCheck2 aria-hidden="true" size={19} />
        </span>
        <div>
          <small>Result from {result.runId}</small>
          <strong>
            {result.reviewState === "approved"
              ? "Approved by human"
              : result.reviewState === "changes_requested"
                ? "Changes requested"
                : "Your review is required"}
          </strong>
        </div>
      </div>
      <p>{result.summary}</p>
      <div className="review-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={() => onRequestChanges(result.id)}
          disabled={!pending}
          title={!pending ? "This result is no longer awaiting review." : undefined}
        >
          Request changes
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => onApprove(result.id)}
          disabled={!pending}
          title={!pending ? "This result is no longer awaiting review." : undefined}
        >
          <Check aria-hidden="true" size={17} />
          Approve
        </button>
      </div>
    </article>
  );
}

function RightPanel({
  current,
  selectedAgent,
  onSelectAgent,
  onClose,
  onCreateTask,
  onRetry,
  onStartFollowUp,
  onApprove,
  onRequestChanges,
  onReconcile,
  revealTarget,
  onTargetRevealed,
  showAgentMetrics,
}: {
  current: Workstream;
  selectedAgent: string | null;
  onSelectAgent: (name: string | null) => void;
  onClose: () => void;
  onCreateTask: () => void;
  onRetry: (taskId: string) => void;
  onStartFollowUp: (taskId: string) => void;
  onApprove: (resultId: string) => void;
  onRequestChanges: (resultId: string) => void;
  onReconcile: (effectId: string) => void;
  revealTarget: WorkspaceObjectTarget | null;
  onTargetRevealed: () => void;
  showAgentMetrics: boolean;
}) {
  const [rightTab, setRightTab] = useState<"agents" | "tasks" | "logs">("agents");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [focusedTarget, setFocusedTarget] =
    useState<WorkspaceObjectTarget | null>(null);
  const workspace = current.workspace;
  const {
    runs: agentRuns,
    tasks,
    results,
    externalEffects,
  } = getAgentWorkspaceScope(current, selectedAgent);
  const visibleTaskIds = tasks.map((task) => task.id);
  const retryableTaskIds = visibleTaskIds.filter((taskId) =>
    canRetryTask(workspace, taskId),
  );
  const followUpTaskIds = visibleTaskIds.filter((taskId) =>
    canStartFollowUpRun(workspace, taskId),
  );
  const retryActionTarget = getTaskActionTarget(
    workspace,
    visibleTaskIds,
    selectedTaskId,
    "retry",
  );
  const followUpActionTarget = getTaskActionTarget(
    workspace,
    visibleTaskIds,
    selectedTaskId,
    "follow-up",
  );
  const runAgentUnavailableReason = getAgentRunUnavailableReason(
    current,
    current.taskAgentId,
  );
  const retryableTaskId = runAgentUnavailableReason
    ? undefined
    : retryActionTarget;
  const followUpTaskId = runAgentUnavailableReason
    ? undefined
    : followUpActionTarget;
  const retryUnavailableReason = retryableTaskId
    ? undefined
    : retryActionTarget && runAgentUnavailableReason
      ? runAgentUnavailableReason
      : retryableTaskIds.length === 0
        ? "No failed task in this scope is eligible for retry."
        : selectedTaskId
          ? "The selected task is not eligible for retry."
          : "Select one eligible failed task to retry.";
  const followUpUnavailableReason = followUpTaskId
    ? undefined
    : followUpActionTarget && runAgentUnavailableReason
      ? runAgentUnavailableReason
      : followUpTaskIds.length === 0
        ? "No changes-requested task in this scope is ready for a follow-up run."
        : selectedTaskId
          ? "The selected task is not eligible for a follow-up run."
          : "Select one eligible task to start its follow-up run.";
  const onlineAgents = current.agents.filter(
    (agent) => !getAgentMessagingUnavailableReason(agent),
  ).length;
  const agentDisplayItems = getAgentDisplayItems(current);
  const progressValues = agentDisplayItems.flatMap((item) =>
    item.progressPercent === undefined ? [] : [item.progressPercent],
  );
  const sharedProgress =
    progressValues.length > 0
      ? Math.round(
          progressValues.reduce((total, value) => total + value, 0) /
            progressValues.length,
        )
      : undefined;
  const logs = getWorkstreamLogItems(current, selectedAgent);

  useEffect(() => {
    setSelectedTaskId(null);
    setFocusedTarget(null);
  }, [current.id, selectedAgent]);

  useEffect(() => {
    if (!revealTarget) {
      return;
    }

    setRightTab("tasks");
    setFocusedTarget(revealTarget);
    const taskId =
      revealTarget.type === "task"
        ? revealTarget.id
        : revealTarget.type === "result"
          ? workspace.results.find((result) => result.id === revealTarget.id)
              ?.taskId
          : revealTarget.type === "run"
            ? workspace.runs.find((run) => run.id === revealTarget.id)?.taskId
            : revealTarget.type === "effect"
              ? workspace.externalEffects.find(
                  (effect) => effect.id === revealTarget.id,
                )?.taskId
              : undefined;
    setSelectedTaskId(taskId ?? null);
    onTargetRevealed();
  }, [onTargetRevealed, revealTarget, workspace]);

  useEffect(() => {
    if (!focusedTarget || rightTab !== "tasks") {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(getWorkspaceObjectElementId(focusedTarget))
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedTarget, rightTab]);

  return (
    <aside className="right-panel" aria-label="Durable work state">
      <header className="state-header">
        <div>
          <span>Control plane</span>
          <strong>{selectedAgent ? `${selectedAgent} scope` : current.name}</strong>
        </div>
        <IconButton label="Close work state" onClick={onClose}>
          <PanelLeft aria-hidden="true" size={19} />
        </IconButton>
      </header>

      <div className="control-tabs" role="tablist" aria-label="Control plane views">
        {(["agents", "tasks", "logs"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={rightTab === tab}
            className={rightTab === tab ? "active" : ""}
            onClick={() => setRightTab(tab)}
          >
            {tab}
            {tab === "tasks" && <span>{tasks.length}</span>}
          </button>
        ))}
      </div>

      <div className="state-scroll">
        {rightTab === "agents" && (
          <section className="agent-control-list" aria-label="Agent sessions">
            <button
              className={`agent-control-row all-agent-row ${selectedAgent === null ? "selected" : ""}`}
              type="button"
              onClick={() => onSelectAgent(null)}
            >
              <span className="agent-control-avatar all-agents">
                <UsersRound aria-hidden="true" size={15} />
              </span>
              <span>
                <strong>All agents</strong>
                <small>{onlineAgents} online · shared conversation</small>
              </span>
              {sharedProgress !== undefined && (
                <span className="agent-progress">
                  <i style={{ width: `${sharedProgress}%` }} />
                </span>
              )}
            </button>
            {agentDisplayItems.map((item) => (
              <button
                className={`agent-control-row ${
                  selectedAgent === item.name ? "selected" : ""
                }`}
                type="button"
                key={item.id}
                onClick={() => onSelectAgent(item.name)}
              >
                <span
                  className={`agent-card-dot status-${item.status}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.model}</small>
                  <em>{item.activity}</em>
                  {showAgentMetrics && (
                    <small className="agent-metrics">
                      {formatAgentMetrics(item)}
                    </small>
                  )}
                </span>
                <span className={`agent-status-text status-${item.status}`}>
                  {item.status}
                </span>
                {item.status === "running" &&
                  item.progressPercent !== undefined && (
                    <span className="agent-progress is-running">
                      <i style={{ width: `${item.progressPercent}%` }} />
                    </span>
                  )}
              </button>
            ))}
          </section>
        )}

        {rightTab === "tasks" && (
          <>
            <section className="state-section">
              <div className="state-section-title">
                <div>
                  <ListTodo aria-hidden="true" size={15} />
                  <h2>Tasks</h2>
                  <span>{tasks.length}</span>
                </div>
                <IconButton label="Create task" onClick={onCreateTask}>
                  <Plus aria-hidden="true" size={16} />
                </IconButton>
              </div>
              {tasks.length > 0 ? (
                <div className="continuity-stack">
                  {tasks.map((task) => (
                    <TaskCard
                      task={task}
                      activeAgentName={
                        current.agents.find(
                          (agent) => agent.id === task.activeAgentId,
                        )?.name ?? "Unassigned"
                      }
                      key={task.id}
                      selected={selectedTaskId === task.id}
                      focused={
                        focusedTarget?.type === "task" &&
                        focusedTarget.id === task.id
                      }
                      onSelect={() => {
                        setFocusedTarget({ type: "task", id: task.id });
                        setSelectedTaskId((value) =>
                          value === task.id ? null : task.id,
                        );
                      }}
                      visualStatus={getTaskDisplayState(workspace, task.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <ListTodo aria-hidden="true" size={18} />
                  <span>No tasks in this scope.</span>
                </div>
              )}
            </section>

            <section className="state-section">
              <div className="state-section-title">
                <div>
                  <Activity aria-hidden="true" size={15} />
                  <h2>Runs</h2>
                  <span>{agentRuns.length}</span>
                </div>
              </div>
              <div className="run-list">
                {agentRuns.map((run) => (
                  <RunRow
                    run={run}
                    agentName={getRunAgentName(current, run)}
                    focused={
                      focusedTarget?.type === "run" &&
                      focusedTarget.id === run.id
                    }
                    key={run.id}
                  />
                ))}
              </div>
              <button
                className="wide-action"
                type="button"
                onClick={() => {
                  if (followUpTaskId) {
                    onStartFollowUp(followUpTaskId);
                  }
                }}
                disabled={!followUpTaskId}
                title={followUpUnavailableReason}
              >
                <Play aria-hidden="true" size={15} />
                Start follow-up run
              </button>
              <button
                className="wide-action"
                type="button"
                onClick={() => {
                  if (retryableTaskId) {
                    onRetry(retryableTaskId);
                  }
                }}
                disabled={!retryableTaskId}
                title={retryUnavailableReason}
              >
                <RotateCcw aria-hidden="true" size={15} />
                Retry with new session
              </button>
            </section>

            {workspace.decisions.length > 0 && (
              <section className="state-section compact-section">
                <div className="state-section-title">
                  <div>
                    <ShieldCheck aria-hidden="true" size={15} />
                    <h2>Decisions</h2>
                    <span>{workspace.decisions.length}</span>
                  </div>
                </div>
                {workspace.decisions.map((decision) => (
                  <article
                    className={`decision-row ${
                      focusedTarget?.type === "decision" &&
                      focusedTarget.id === decision.id
                        ? "destination-focused"
                        : ""
                    }`}
                    aria-current={
                      focusedTarget?.type === "decision" &&
                      focusedTarget.id === decision.id
                        ? "true"
                        : undefined
                    }
                    id={getWorkspaceObjectElementId({
                      type: "decision",
                      id: decision.id,
                    })}
                    key={decision.id}
                  >
                    <span className="decision-mark" />
                    <div>
                      <strong>{decision.title}</strong>
                      <p>{decision.detail}</p>
                      <small>Recorded {decision.recordedAt}</small>
                    </div>
                  </article>
                ))}
              </section>
            )}

            <section className="state-section">
              <div className="state-section-title">
                <div>
                  <FileCheck2 aria-hidden="true" size={15} />
                  <h2>Results / review</h2>
                  <span>{results.length}</span>
                </div>
              </div>
              {results.length > 0 ? (
                results.map((result) => (
                  <ReviewCard
                    result={result}
                    focused={
                      focusedTarget?.type === "result" &&
                      focusedTarget.id === result.id
                    }
                    key={result.id}
                    onApprove={onApprove}
                    onRequestChanges={onRequestChanges}
                  />
                ))
              ) : (
                <div className="empty-state">
                  <FileCheck2 aria-hidden="true" size={18} />
                  <span>No submitted result yet.</span>
                </div>
              )}
            </section>

            {externalEffects.length > 0 && (
              <section className="state-section">
                <div className="state-section-title">
                  <div>
                    <TriangleAlert aria-hidden="true" size={17} />
                    <h2>External effects</h2>
                    <span>{externalEffects.length}</span>
                  </div>
                </div>
                {externalEffects.map((effect) => (
                  <article
                    className={`effect-card effect-${effect.status} ${
                      focusedTarget?.type === "effect" &&
                      focusedTarget.id === effect.id
                        ? "destination-focused"
                        : ""
                    }`}
                    aria-current={
                      focusedTarget?.type === "effect" &&
                      focusedTarget.id === effect.id
                        ? "true"
                        : undefined
                    }
                    aria-live="polite"
                    id={getWorkspaceObjectElementId({
                      type: "effect",
                      id: effect.id,
                    })}
                    key={effect.id}
                  >
                    <div className="effect-title">
                      <span>
                        {effect.status === "uncertain" ? (
                          <TriangleAlert aria-hidden="true" size={18} />
                        ) : (
                          <CheckCircle2 aria-hidden="true" size={18} />
                        )}
                      </span>
                      <div>
                        <small>
                          {effect.status === "uncertain"
                            ? "Reconciliation needed"
                            : "Effect confirmed"}
                        </small>
                        <strong>{effect.title}</strong>
                      </div>
                    </div>
                    <p>{effect.detail}</p>
                    <button
                      className="wide-action warning-action"
                      type="button"
                      onClick={() => onReconcile(effect.id)}
                      disabled={effect.status === "confirmed"}
                      title={
                        effect.status === "confirmed"
                          ? "The external effect is already reconciled."
                          : undefined
                      }
                    >
                      <RefreshCw aria-hidden="true" size={16} />
                      {effect.status === "uncertain"
                        ? "Reconcile before retry"
                        : "Reconciled"}
                    </button>
                  </article>
                ))}
              </section>
            )}
          </>
        )}

        {rightTab === "logs" && (
          <section className="log-console" aria-label="Local activity log">
            <div className="log-heading">
              <Terminal aria-hidden="true" size={14} />
              local event stream
            </div>
            {logs.map((log) => (
              <div className={`log-row log-${log.tone}`} key={log.id}>
                <time>{log.time}</time>
                <span>{log.message}</span>
              </div>
            ))}
            <div className="log-prompt">
              <span>&gt;</span>
              <i aria-hidden="true" />
            </div>
          </section>
        )}
      </div>
      <footer className="control-footer">
        <span className="live-dot" />
        {onlineAgents} sessions available
        <button type="button" onClick={onCreateTask}>
          <Plus aria-hidden="true" size={14} />
          Task
        </button>
      </footer>
    </aside>
  );
}

function SearchOverlay({
  product,
  onChoose,
}: {
  product: ProductState;
  onChoose: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const results = searchProduct(product, query);

  return (
    <>
      <label className="overlay-search">
        <Search aria-hidden="true" size={19} />
        <span className="sr-only">Search local work</span>
        <input
          name="search"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search messages, tasks, and workstreams…"
        />
      </label>
      <div className="search-results">
        {!query ? (
          <div className="overlay-empty">
            <Command aria-hidden="true" size={24} />
            <strong>Search the durable workspace</strong>
            <p>Try “rollback”, “configure”, or “publish”.</p>
          </div>
        ) : results.length === 0 ? (
          <div className="overlay-empty">
            <Search aria-hidden="true" size={24} />
            <strong>No local matches</strong>
            <p>Try a task title, agent name, or workstream.</p>
          </div>
        ) : (
          results.map((result) => (
            <button
              className="search-result"
              type="button"
              key={`${result.kind}-${result.id}`}
              onClick={() => onChoose(result)}
            >
              <span className={`result-kind result-${result.kind}`}>
                {result.kind === "task" ? (
                  <ListTodo aria-hidden="true" size={16} />
                ) : result.kind === "message" ? (
                  <MessageSquareText aria-hidden="true" size={16} />
                ) : (
                  <Box aria-hidden="true" size={16} />
                )}
              </span>
              <span>
                <small>{result.kind}</small>
                <strong>{result.title}</strong>
                <p>{result.detail}</p>
              </span>
              <ArrowRight aria-hidden="true" size={17} />
            </button>
          ))
        )}
      </div>
    </>
  );
}

function Overlay({
  overlay,
  product,
  current,
  target,
  editingMessageId,
  onClose,
  onChooseSearch,
  onNavigate,
  onSetTarget,
  onCreateWorkstream,
  onCreateTask,
  onCreateTaskFromMessage,
  onRecordDecision,
  onOpenThread,
  onEditMessage,
  onAttach,
  onCopyAuthority,
  onCopyContext,
  onExportSnapshot,
  onOpenPreferences,
  onToggleAgentMetrics,
  showAgentMetrics,
}: {
  overlay: OverlayState;
  product: ProductState;
  current: Workstream;
  target: string;
  editingMessageId: string | null;
  onClose: () => void;
  onChooseSearch: (result: SearchResult) => void;
  onNavigate: (destination: WorkspaceDestination) => void;
  onSetTarget: (target: string) => void;
  onCreateWorkstream: (name: string) => void;
  onCreateTask: (title: string, summary: string) => void;
  onCreateTaskFromMessage: (messageId: string) => void;
  onRecordDecision: (messageId: string) => void;
  onOpenThread: (messageId: string) => void;
  onEditMessage: (messageId: string) => void;
  onAttach: (artifact: MessageArtifact) => void;
  onCopyAuthority: () => void;
  onCopyContext: () => void;
  onExportSnapshot: () => void;
  onOpenPreferences: () => void;
  onToggleAgentMetrics: () => void;
  showAgentMetrics: boolean;
}) {
  const [name, setName] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskSummary, setTaskSummary] = useState("");
  const isCompactMenu = overlay.kind.endsWith("menu") || overlay.kind === "agent-picker";
  const navigation = getProductNavigation(product);
  const sampleArtifact = getSampleMessageArtifact(current);
  const titles: Record<OverlayKind, string> = {
    activity: "Recent activity",
    artifact: "Artifact details",
    attach: "Attach local evidence",
    authority: "Authority for this workstream",
    "agent-picker": "Choose message recipients",
    "conversation-menu": "Conversation options",
    "create-task": "Create durable task",
    "create-workstream": "Create workstream",
    inbox: "Inbox",
    pending: "Pending actions",
    preferences: "Workspace preferences",
    "profile-menu": "Local profile",
    "message-menu": "Message actions",
    search: "Search",
    "workspace-menu": "Workspace options",
  };
  const messageMenuMessage = overlay.messageId
    ? current.workspace.messages.find(
        (message) => message.id === overlay.messageId,
      )
    : undefined;
  const messageMenuTaskCreated = messageMenuMessage
    ? current.workspace.tasks.some(
        (task) => task.sourceMessageId === messageMenuMessage.id,
      )
    : false;
  const messageMenuDecisionRecorded = messageMenuMessage
    ? current.workspace.decisions.some(
        (decision) => decision.sourceMessageId === messageMenuMessage.id,
      )
    : false;
  const messageMenuEditability = messageMenuMessage
    ? getMessageEditability(current.workspace, messageMenuMessage.id)
    : { editable: false };
  const messageMenuPromotionBlocked =
    messageMenuMessage?.id === editingMessageId;
  const currentPendingDestination = navigation.pendingItems.find(
    (item) => item.workstreamId === current.id,
  )?.destination;

  function submitWorkstream(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) {
      onCreateWorkstream(name);
    }
  }

  function submitTask(event: FormEvent) {
    event.preventDefault();
    if (taskTitle.trim()) {
      onCreateTask(taskTitle, taskSummary);
    }
  }

  return (
    <div className="overlay-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`overlay-panel ${isCompactMenu ? "overlay-popover" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="overlay-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="overlay-header">
          <div>
            <span>Torsor · local prototype</span>
            <h2 id="overlay-title">{titles[overlay.kind]}</h2>
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </IconButton>
        </header>

        <div className="overlay-content">
          {overlay.kind === "search" && (
            <SearchOverlay product={product} onChoose={onChooseSearch} />
          )}

          {overlay.kind === "inbox" && (
            <div className="overlay-list">
              {navigation.inboxItems.length > 0 ? (
                navigation.inboxItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onNavigate(item.destination)}
                  >
                    <Inbox aria-hidden="true" size={18} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.meta}</small>
                    </span>
                    <ArrowRight aria-hidden="true" size={17} />
                  </button>
                ))
              ) : (
                <div className="overlay-empty">
                  <CheckCircle2 aria-hidden="true" size={24} />
                  <strong>Inbox is clear</strong>
                  <p>Resolved requests remain in recent activity.</p>
                </div>
              )}
            </div>
          )}

          {overlay.kind === "pending" && (
            <div className="overlay-list">
              {navigation.pendingItems.length > 0 ? (
                navigation.pendingItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onNavigate(item.destination)}
                  >
                    <ListTodo aria-hidden="true" size={18} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.meta}</small>
                    </span>
                    <ArrowRight aria-hidden="true" size={17} />
                  </button>
                ))
              ) : (
                <div className="overlay-empty">
                  <CheckCircle2 aria-hidden="true" size={24} />
                  <strong>No pending durable work</strong>
                  <p>Create a task when a conversation becomes a commitment.</p>
                </div>
              )}
            </div>
          )}

          {overlay.kind === "activity" && (
            <div className="activity-timeline">
              {navigation.activityItems.length > 0 ? (
                navigation.activityItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onNavigate(item.destination)}
                  >
                    <span className="activity-node" />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.meta}</small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="overlay-empty">
                  <History aria-hidden="true" size={24} />
                  <strong>No recent activity</strong>
                  <p>Runs, results, decisions, and messages will appear here.</p>
                </div>
              )}
            </div>
          )}

          {overlay.kind === "authority" && (
            <div className="authority-grid">
              <article>
                <ShieldCheck aria-hidden="true" size={20} />
                <strong>Human approval required</strong>
                <p>Results cannot complete durable work until you approve them.</p>
              </article>
              <article>
                <Play aria-hidden="true" size={20} />
                <strong>Agents may run locally</strong>
                <p>Active sessions can investigate and submit evidence.</p>
              </article>
              <article>
                <TriangleAlert aria-hidden="true" size={20} />
                <strong>External effects stay explicit</strong>
                <p>Lost receipts require reconciliation before another attempt.</p>
              </article>
            </div>
          )}

          {overlay.kind === "artifact" && (
            <div className="artifact-details">
              <div className="document-lines" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
              </div>
              <div>
                <small>Local synthetic artifact</small>
                <h3>{overlay.artifactTitle}</h3>
                <p>{overlay.artifactDetail}</p>
                <dl>
                  <div>
                    <dt>Source</dt>
                    <dd>Agent run evidence</dd>
                  </div>
                  <div>
                    <dt>Integrity</dt>
                    <dd>Recorded with run</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}

          {overlay.kind === "workspace-menu" && (
            <div className="menu-list">
              <button type="button" onClick={onExportSnapshot}>
                <Download aria-hidden="true" size={18} />
                <span>
                  <strong>Export local snapshot</strong>
                  <small>Download current public prototype state as JSON</small>
                </span>
              </button>
              <button type="button" onClick={onOpenPreferences}>
                <Settings2 aria-hidden="true" size={18} />
                <span>
                  <strong>Workspace preferences</strong>
                  <small>Prototype display and behavior settings</small>
                </span>
              </button>
              <div className="menu-information">
                <CheckCircle2 aria-hidden="true" size={17} />
                Local only · no backend connected
              </div>
            </div>
          )}

          {overlay.kind === "profile-menu" && (
            <div className="menu-list">
              <div className="profile-summary">
                <span
                  className="human-avatar"
                  role="img"
                  aria-label={DEPLOYING_HUMAN.name}
                >
                  {DEPLOYING_HUMAN.initials}
                </span>
                <div>
                  <strong>{DEPLOYING_HUMAN.name}</strong>
                  <small>Owns approvals and external authority</small>
                </div>
              </div>
              <button type="button" onClick={onCopyAuthority}>
                <Clipboard aria-hidden="true" size={18} />
                <span>
                  <strong>Copy authority summary</strong>
                  <small>Use in another local session</small>
                </span>
              </button>
              <button type="button" disabled title="Authentication is outside this local prototype.">
                <UserRound aria-hidden="true" size={18} />
                <span>
                  <strong>Switch account</strong>
                  <small>Unavailable without authentication</small>
                </span>
              </button>
            </div>
          )}

          {overlay.kind === "conversation-menu" && (
            <div className="menu-list">
              <button type="button" onClick={onCopyContext}>
                <Clipboard aria-hidden="true" size={18} />
                <span>
                  <strong>Copy context summary</strong>
                  <small>{current.context}</small>
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (currentPendingDestination) {
                    onNavigate(currentPendingDestination);
                  }
                }}
                disabled={!currentPendingDestination}
                title={
                  currentPendingDestination
                    ? undefined
                    : "This workstream has no executable human action."
                }
              >
                <Clock3 aria-hidden="true" size={18} />
                <span>
                  <strong>Open pending work</strong>
                  <small>Review current durable tasks and actions</small>
                </span>
              </button>
            </div>
          )}

          {overlay.kind === "message-menu" &&
            (messageMenuMessage ? (
              <div className="menu-list">
                <div className="message-menu-target">
                  <small>
                    {messageMenuMessage.authorName} · {messageMenuMessage.time}
                  </small>
                  <strong>{messageMenuMessage.body}</strong>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenThread(messageMenuMessage.id)}
                >
                  <Reply aria-hidden="true" size={18} />
                  <span>
                    <strong>Reply in thread</strong>
                    <small>Open this message's exact thread</small>
                  </span>
                </button>
                {messageMenuMessage.author === "human" && (
                  <button
                    type="button"
                    onClick={() => onEditMessage(messageMenuMessage.id)}
                    disabled={!messageMenuEditability.editable}
                    title={messageMenuEditability.reason}
                  >
                    <SquarePen aria-hidden="true" size={18} />
                    <span>
                      <strong>Edit message</strong>
                      <small>
                        {messageMenuEditability.editable
                          ? "Update this human message in place"
                          : "Promoted source messages preserve provenance"}
                      </small>
                    </span>
                  </button>
                )}
                {messageMenuMessage.author === "human" && (
                  <button
                    type="button"
                    onClick={() =>
                      onCreateTaskFromMessage(messageMenuMessage.id)
                    }
                    disabled={
                      messageMenuTaskCreated || messageMenuPromotionBlocked
                    }
                    title={
                      messageMenuTaskCreated
                        ? "This message is already linked to a durable task."
                        : messageMenuPromotionBlocked
                          ? "Save or cancel this edit before creating a task."
                        : undefined
                    }
                  >
                    {messageMenuTaskCreated ? (
                      <Check aria-hidden="true" size={18} />
                    ) : (
                      <ListTodo aria-hidden="true" size={18} />
                    )}
                    <span>
                      <strong>
                        {messageMenuTaskCreated ? "Task created" : "Create task"}
                      </strong>
                      <small>
                        {messageMenuPromotionBlocked
                          ? "Save or cancel the current edit first"
                          : "Promote this exact visible message"}
                      </small>
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRecordDecision(messageMenuMessage.id)}
                  disabled={
                    messageMenuDecisionRecorded || messageMenuPromotionBlocked
                  }
                  title={
                    messageMenuDecisionRecorded
                      ? "This message is already linked to a durable decision."
                      : messageMenuPromotionBlocked
                        ? "Save or cancel this edit before recording a decision."
                      : undefined
                  }
                >
                  {messageMenuDecisionRecorded ? (
                    <Check aria-hidden="true" size={18} />
                  ) : (
                    <ShieldCheck aria-hidden="true" size={18} />
                  )}
                  <span>
                    <strong>
                      {messageMenuDecisionRecorded
                        ? "Decision recorded"
                        : "Record decision"}
                    </strong>
                    <small>Promote this exact message to durable state</small>
                  </span>
                </button>
              </div>
            ) : (
              <div className="overlay-empty">
                <TriangleAlert aria-hidden="true" size={24} />
                <strong>Message unavailable</strong>
                <p>The selected message is no longer in this conversation.</p>
              </div>
            ))}

          {overlay.kind === "preferences" && (
            <div className="preferences-panel">
              <p>
                These local display settings affect only this prototype tab.
              </p>
              <label className="preference-row">
                <span>
                  <strong>Show Agent metrics</strong>
                  <small>Display tokens, duration, and progress when available.</small>
                </span>
                <input
                  type="checkbox"
                  checked={showAgentMetrics}
                  onChange={onToggleAgentMetrics}
                />
              </label>
            </div>
          )}

          {overlay.kind === "agent-picker" && (
            <div className="menu-list">
              <button
                type="button"
                className={target === "All agents" ? "selected" : ""}
                onClick={() => onSetTarget("All agents")}
              >
                <UsersRound aria-hidden="true" size={18} />
                <span>
                  <strong>All agents</strong>
                  <small>Let the workstream choose the responder</small>
                </span>
                {target === "All agents" && (
                  <Check aria-hidden="true" size={17} />
                )}
              </button>
              {current.agents.map((agent) => {
                const unavailableReason =
                  getAgentMessagingUnavailableReason(agent);
                return (
                  <button
                    type="button"
                    key={agent.id}
                    className={target === agent.name ? "selected" : ""}
                    onClick={() => onSetTarget(agent.name)}
                    disabled={Boolean(unavailableReason)}
                    title={unavailableReason}
                  >
                    <Avatar name={agent.name} />
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{unavailableReason ?? agent.role}</small>
                    </span>
                    {target === agent.name && (
                      <Check aria-hidden="true" size={17} />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {overlay.kind === "create-workstream" && (
            <form className="overlay-form" onSubmit={submitWorkstream}>
              <label htmlFor="workstream-name">Workstream name</label>
              <input
                id="workstream-name"
                name="workstream-name"
                autoComplete="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Example: Reliability review…"
              />
              <p>Creates a deterministic local workspace with Orbit available.</p>
              <button className="primary-button" type="submit" disabled={!name.trim()}>
                <Plus aria-hidden="true" size={17} />
                Create workstream
              </button>
            </form>
          )}

          {overlay.kind === "create-task" && (
            <form className="overlay-form" onSubmit={submitTask}>
              <label htmlFor="task-title">Task title</label>
              <input
                id="task-title"
                name="task-title"
                autoComplete="off"
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
                placeholder="Example: Verify the next durable step…"
              />
              <label htmlFor="task-summary">Summary</label>
              <textarea
                id="task-summary"
                name="task-summary"
                autoComplete="off"
                value={taskSummary}
                onChange={(event) => setTaskSummary(event.target.value)}
                placeholder="Describe the durable outcome…"
              />
              <button
                className="primary-button"
                type="submit"
                disabled={!taskTitle.trim()}
              >
                <ListTodo aria-hidden="true" size={17} />
                Create durable task
              </button>
            </form>
          )}

          {overlay.kind === "attach" && (
            <div className="attach-panel">
              <FilePlus2 aria-hidden="true" size={30} />
              <strong>Attach synthetic run evidence</strong>
              <p>
                The prototype will add <code>{sampleArtifact.title}</code> to
                your next message. {sampleArtifact.detail}
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={() => onAttach(sampleArtifact)}
              >
                <Plus aria-hidden="true" size={17} />
                Attach sample evidence
              </button>
            </div>
          )}
        </div>

        {!isCompactMenu && overlay.kind !== "search" && (
          <footer className="overlay-footer">
            <span>
              {overlay.kind === "pending"
                ? `${navigation.counts.pending} actions across workstreams`
                : "Local deterministic prototype data"}
            </span>
            <button className="secondary-button" type="button" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}

export function App() {
  const [product, setProduct] = useState(createDemoProduct);
  const [mobileView, setMobileView] = useState<MobileView>("conversation");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [composer, setComposer] = useState("");
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [target, setTarget] = useState("All agents");
  const [pendingResponses, setPendingResponses] = useState<
    Map<string, PendingAgentResponse>
  >(() => new Map());
  const [attachedArtifact, setAttachedArtifact] =
    useState<MessageArtifact | null>(null);
  const [agentCommand, setAgentCommand] = useState(false);
  const [revealMessageId, setRevealMessageId] = useState<string | null>(null);
  const [revealTarget, setRevealTarget] =
    useState<WorkspaceObjectTarget | null>(null);
  const [threadMessageId, setThreadMessageId] = useState<string | null>(null);
  const [threadReply, setThreadReply] = useState("");
  const [notice, setNotice] = useState("");
  const [showAgentMetrics, setShowAgentMetrics] = useState(true);
  const responseTimers = useRef(new Map<string, number>());
  const runStartLocks = useRef(new Set<string>());
  const productRef = useRef(product);
  productRef.current = product;
  const selectedWorkstreamId = useRef(product.selectedWorkstreamId);
  const current = getSelectedWorkstream(product);
  const pendingResponse = pendingResponses.get(current.id) ?? null;
  const typingAgent = pendingResponse?.responder.name ?? null;
  const typing = typingAgent !== null;
  const threadMessage =
    current.workspace.messages.find((message) => message.id === threadMessageId) ??
    null;
  const editingMessage =
    current.workspace.messages.find(
      (message) => message.id === editingMessageId,
    ) ?? null;
  const counts = getWorkspaceCounts(current.workspace);

  useEffect(
    () => () => {
      for (const timer of responseTimers.current.values()) {
        window.clearTimeout(timer);
      }
      responseTimers.current.clear();
    },
    [],
  );

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOverlay({ kind: "search" });
      }
      if (event.key === "Escape") {
        setOverlay(null);
        setThreadMessageId(null);
        setThreadReply("");
        if (editingMessageId) {
          setComposer("");
          setAttachedArtifact(null);
          setAgentCommand(false);
          setEditingMessageId(null);
          setNotice("Message edit canceled.");
        }
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [editingMessageId]);

  function updateWorkspace(
    updater: (workspace: Workspace) => Workspace,
    message: string,
  ) {
    setProduct((value) => updateSelectedWorkspace(value, updater));
    setNotice(message);
  }

  function updateWorkstream(
    updater: (workstream: Workstream) => Workstream,
    message: string,
  ) {
    setProduct((value) =>
      updateWorkstreamById(value, current.id, updater),
    );
    setNotice(message);
  }

  function openOverlay(
    kind: OverlayKind,
    artifact?: { title: string; detail: string },
  ) {
    setOverlay({
      kind,
      artifactTitle: artifact?.title,
      artifactDetail: artifact?.detail,
    });
  }

  function prepareConversationChange(
    workstreamId: string,
    nextSelectedAgent: string | null,
  ) {
    const next = getComposerStateAfterConversationChange(
      {
        composer,
        attachedArtifact,
        agentCommand,
        target,
        editingMessageId,
      },
      { workstreamId: current.id, selectedAgent },
      { workstreamId, selectedAgent: nextSelectedAgent },
    );

    setComposer(next.composer);
    setAttachedArtifact(next.attachedArtifact);
    setAgentCommand(next.agentCommand);
    setTarget(next.target);
    setEditingMessageId(next.editingMessageId);
  }

  function beginMessageEdit(messageId: string) {
    const next = getComposerStateForMessageEdit(
      current.workspace,
      messageId,
      {
        composer,
        attachedArtifact,
        agentCommand,
        target,
        editingMessageId,
      },
    );

    setComposer(next.composer);
    setAttachedArtifact(next.attachedArtifact);
    setAgentCommand(next.agentCommand);
    setTarget(next.target);
    setEditingMessageId(next.editingMessageId);
    setThreadMessageId(null);
    setThreadReply("");
    setOverlay(null);
    setNotice("Editing this human message in place.");
  }

  function cancelMessageEdit() {
    const next = getComposerStateAfterEditCancel({
      composer,
      attachedArtifact,
      agentCommand,
      target,
      editingMessageId,
    });

    setComposer(next.composer);
    setAttachedArtifact(next.attachedArtifact);
    setAgentCommand(next.agentCommand);
    setTarget(next.target);
    setEditingMessageId(next.editingMessageId);
    setNotice("Message edit canceled.");
  }

  function openMessageThread(messageId: string) {
    setThreadReply("");
    setThreadMessageId(messageId);
    setOverlay(null);
    setNotice("Thread opened.");
  }

  function createTaskFromExactMessage(messageId: string) {
    updateWorkspace(
      (workspace) => createTaskFromMessage(workspace, messageId),
      "Created a durable task from the message.",
    );
    setOverlay(null);
  }

  function recordDecisionFromExactMessage(messageId: string) {
    updateWorkspace(
      (workspace) => recordDecision(workspace, messageId),
      "Recorded a durable decision from the message.",
    );
    setOverlay(null);
  }

  function chooseWorkstream(id: string, showState = false) {
    prepareConversationChange(id, null);
    selectedWorkstreamId.current = id;
    setProduct((value) => selectWorkstream(value, id));
    setSelectedAgent(null);
    setRevealMessageId(null);
    setRevealTarget(null);
    setThreadMessageId(null);
    setThreadReply("");
    setOverlay(null);
    setNotice("Switched to a different durable workstream.");
    if (showState) {
      setRightOpen(true);
      setMobileView("state");
    } else {
      setMobileView("conversation");
    }
  }

  function chooseAgent(name: string | null) {
    prepareConversationChange(current.id, name);
    setSelectedAgent(name);
    setRevealMessageId(null);
    setRevealTarget(null);
    setThreadMessageId(null);
    setThreadReply("");
    setMobileView("conversation");
    setNotice(
      name
        ? `Showing the ${name} conversation and durable scope.`
        : "Showing the shared workstream conversation.",
    );
  }

  function navigateToDestination(destination: WorkspaceDestination) {
    prepareConversationChange(
      destination.workstreamId,
      destination.selectedAgent,
    );
    selectedWorkstreamId.current = destination.workstreamId;
    setProduct((value) =>
      selectWorkstream(value, destination.workstreamId),
    );
    setSelectedAgent(destination.selectedAgent);
    setThreadMessageId(null);
    setThreadReply("");
    setOverlay(null);
    setRevealMessageId(
      destination.target.type === "message" ? destination.target.id : null,
    );
    setRevealTarget(
      destination.view === "tasks" ? destination.target : null,
    );

    if (destination.view === "tasks") {
      setRightOpen(true);
      setMobileView("state");
      setNotice(`Opened the matching ${destination.target.type}.`);
    } else {
      setMobileView("conversation");
      setNotice(
        destination.target.type === "message"
          ? "Opened the matching conversation message."
          : "Opened the shared workstream conversation.",
      );
    }
  }

  function chooseSearchResult(result: SearchResult) {
    navigateToDestination(getSearchDestination(product, result));
  }

  async function copyText(
    text: string,
    label: "authority summary" | "context summary",
  ) {
    if (!navigator.clipboard?.writeText) {
      setOverlay(null);
      setNotice(
        `Could not copy the ${label}: Clipboard access is unavailable in this browser.`,
      );
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      setOverlay(null);
      setNotice(
        label === "authority summary"
          ? "Local authority summary copied."
          : "Conversation context copied.",
      );
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? error.message
          : "The browser denied clipboard access.";
      setOverlay(null);
      setNotice(`Could not copy the ${label}: ${reason}`);
    }
  }

  function exportSnapshot() {
    let objectUrl: string | null = null;

    try {
      const snapshot = getPublicPrototypeSnapshot(product);
      const blob = new Blob([snapshot], { type: "application/json" });
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = PUBLIC_SNAPSHOT_FILENAME;
      document.body.append(link);
      link.click();
      link.remove();
      setOverlay(null);
      setNotice("Workspace snapshot downloaded.");
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? error.message
          : "The browser could not create the local file.";
      setOverlay(null);
      setNotice(`Could not export the workspace snapshot: ${reason}`);
    } finally {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }

  function submitMessage() {
    const text = composer.trim();
    if (!text) {
      return;
    }
    if (editingMessageId) {
      updateWorkspace(
        (workspace) =>
          updateHumanMessage(workspace, editingMessageId, text),
        "Message updated in place.",
      );
      setComposer("");
      setAttachedArtifact(null);
      setAgentCommand(false);
      setEditingMessageId(null);
      return;
    }
    const targetUnavailableReason = getMessageTargetUnavailableReason(
      current,
      target,
    );
    if (targetUnavailableReason) {
      setNotice(targetUnavailableReason);
      return;
    }
    if (typing) {
      return;
    }
    const startedResponse = startAgentResponse(
      current,
      text,
      target,
      attachedArtifact ?? undefined,
    );
    const nextResponse = startedResponse.pending;
    const originWorkstreamId = nextResponse.workstreamId;
    const messageTarget = nextResponse.target;
    const responder = nextResponse.responder;

    setProduct((value) =>
      updateWorkstreamById(
        value,
        originWorkstreamId,
        () => startedResponse.workstream,
      ),
    );
    setComposer("");
    setAttachedArtifact(null);
    setPendingResponses((value) => {
      const next = new Map(value);
      next.set(originWorkstreamId, nextResponse);
      return next;
    });
    setNotice(
      agentCommand
        ? `Command sent to ${messageTarget}; it remains conversational until promoted.`
        : `Message sent to ${messageTarget}.`,
    );

    const timer = window.setTimeout(() => {
      const latestProduct = productRef.current;
      const originWorkstream = latestProduct.workstreams.find(
        (workstream) => workstream.id === originWorkstreamId,
      );
      if (!originWorkstream) {
        throw new Error("The pending response workstream no longer exists.");
      }
      const completion = completeAgentResponse(
        originWorkstream,
        nextResponse,
      );
      const nextProduct = updateWorkstreamById(
        latestProduct,
        originWorkstreamId,
        () => completion.workstream,
      );
      productRef.current = nextProduct;
      setProduct(nextProduct);
      setPendingResponses((value) => {
        const next = new Map(value);
        next.delete(originWorkstreamId);
        return next;
      });
      if (selectedWorkstreamId.current === originWorkstreamId) {
        setNotice(
          completion.status === "completed"
            ? `${responder.name} responded.`
            : `${responder.name} did not respond: ${completion.reason}`,
        );
      }
      responseTimers.current.delete(originWorkstreamId);
    }, 850);
    responseTimers.current.set(originWorkstreamId, timer);
  }

  function retryTask(taskId: string) {
    const lockId = `${current.id}:${taskId}`;
    if (runStartLocks.current.has(lockId)) {
      setNotice("A retry is already running for this task.");
      return;
    }

    const taskAgent = current.agents.find(
      (agent) => agent.id === current.taskAgentId,
    );
    if (!taskAgent) {
      throw new Error("The configured task Agent does not exist.");
    }
    runStartLocks.current.add(lockId);
    updateWorkstream(
      (workstream) => retryTaskRun(workstream, taskId, taskAgent.id),
      `Created a new run with ${taskAgent.name}.`,
    );
    window.setTimeout(() => runStartLocks.current.delete(lockId), 0);
  }

  function startTaskFollowUp(taskId: string) {
    const lockId = `${current.id}:${taskId}`;
    if (runStartLocks.current.has(lockId)) {
      setNotice("A run is already starting for this task.");
      return;
    }

    const taskAgent = current.agents.find(
      (agent) => agent.id === current.taskAgentId,
    );
    if (!taskAgent) {
      throw new Error("The configured task Agent does not exist.");
    }
    runStartLocks.current.add(lockId);
    updateWorkstream(
      (workstream) =>
        startTaskFollowUpRun(workstream, taskId, taskAgent.id),
      "Started a follow-up run for the requested changes.",
    );
    window.setTimeout(() => runStartLocks.current.delete(lockId), 0);
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to conversation
      </a>
      <div className="mobile-topbar">
        <BrandMark />
        <strong>Torsor</strong>
        <span>{counts.pendingActionCount} pending</span>
      </div>
      <nav className="mobile-nav" aria-label="Prototype panels">
        <button
          type="button"
          className={mobileView === "threads" ? "active" : ""}
          onClick={() => setMobileView("threads")}
        >
          <MessageSquareText aria-hidden="true" size={19} />
          Threads
        </button>
        <button
          type="button"
          className={mobileView === "conversation" ? "active" : ""}
          onClick={() => setMobileView("conversation")}
        >
          <SquarePen aria-hidden="true" size={19} />
          Conversation
        </button>
        <button
          type="button"
          className={mobileView === "state" ? "active" : ""}
          onClick={() => {
            setRightOpen(true);
            setMobileView("state");
          }}
        >
          <ListTodo aria-hidden="true" size={19} />
          State
          <span>{counts.pendingActionCount}</span>
        </button>
      </nav>

      <div
        className={`workspace-grid mobile-view-${mobileView} ${
          rightOpen ? "" : "right-closed"
        }`}
      >
        <LeftPanel
          product={product}
          current={current}
          selectedAgent={selectedAgent}
          onSelectWorkstream={chooseWorkstream}
          onSelectAgent={chooseAgent}
          onOpen={openOverlay}
        />
        <CenterPanel
          current={current}
          selectedAgent={selectedAgent}
          target={target}
          composer={composer}
          attachedArtifact={attachedArtifact}
          typingAgent={typingAgent}
          notice={notice}
          agentCommand={agentCommand}
          revealMessageId={revealMessageId}
          threadMessage={threadMessage}
          threadReply={threadReply}
          editingMessage={editingMessage}
          onComposerChange={setComposer}
          onCancelEdit={cancelMessageEdit}
          onThreadReplyChange={setThreadReply}
          onSubmitThreadReply={() => {
            if (!threadMessageId || !threadReply.trim()) {
              return;
            }
            updateWorkspace(
              (workspace) =>
                appendThreadReply(workspace, threadMessageId, threadReply),
              "Reply added to the thread.",
            );
            setThreadReply("");
          }}
          onCloseThread={() => {
            setThreadMessageId(null);
            setThreadReply("");
            setNotice("Thread closed.");
          }}
          onOpenThread={openMessageThread}
          onEditMessage={beginMessageEdit}
          onOpenMessageMenu={(messageId) =>
            setOverlay({ kind: "message-menu", messageId })
          }
          onToggleCommand={() => {
            setAgentCommand((value) => !value);
            setNotice(
              agentCommand
                ? "Composer returned to message mode."
                : "Agent command mode enabled. Durable work still requires an explicit action.",
            );
          }}
          onSubmit={submitMessage}
          onCreateTask={createTaskFromExactMessage}
          onReact={(messageId, emoji) => {
            updateWorkspace(
              (workspace) =>
                toggleMessageReaction(workspace, messageId, emoji),
              "Updated the local message reaction.",
            );
          }}
          onRecordDecision={recordDecisionFromExactMessage}
          onOpen={openOverlay}
          onShowState={() => {
            setRightOpen(true);
            setMobileView("state");
            setNotice("Durable work state is visible.");
          }}
          onMessageRevealed={() => setRevealMessageId(null)}
        />
        {rightOpen && (
          <RightPanel
            current={current}
            selectedAgent={selectedAgent}
            onSelectAgent={chooseAgent}
            onClose={() => {
              setRightOpen(false);
              setMobileView("conversation");
              setNotice("Durable work state hidden.");
            }}
            onCreateTask={() => openOverlay("create-task")}
            onRetry={retryTask}
            onStartFollowUp={startTaskFollowUp}
            onApprove={(resultId) => {
              updateWorkspace(
                (workspace) => approveResult(workspace, resultId),
                "Result approved. The task is now done.",
              );
            }}
            onRequestChanges={(resultId) => {
              updateWorkspace(
                (workspace) => requestChanges(workspace, resultId),
                "Changes requested. The task returned to open.",
              );
            }}
            onReconcile={(effectId) => {
              updateWorkspace(
                (workspace) => reconcileExternalEffect(workspace, effectId),
                "External effect confirmed.",
              );
            }}
            revealTarget={revealTarget}
            onTargetRevealed={() => setRevealTarget(null)}
            showAgentMetrics={showAgentMetrics}
          />
        )}
      </div>

      {overlay && (
        <Overlay
          overlay={overlay}
          product={product}
          current={current}
          target={target}
          editingMessageId={editingMessageId}
          onClose={() => setOverlay(null)}
          onChooseSearch={chooseSearchResult}
          onNavigate={navigateToDestination}
          onSetTarget={(value) => {
            const nextSelectedAgent = value === "All agents" ? null : value;
            prepareConversationChange(current.id, nextSelectedAgent);
            setSelectedAgent(nextSelectedAgent);
            setRevealMessageId(null);
            setRevealTarget(null);
            setThreadMessageId(null);
            setThreadReply("");
            setOverlay(null);
            setNotice(`Messages will go to ${value}.`);
          }}
          onCreateWorkstream={(name) => {
            const created = createLocalWorkstream(product, name);
            prepareConversationChange(created.selectedWorkstreamId, null);
            selectedWorkstreamId.current = created.selectedWorkstreamId;
            setProduct(created);
            setSelectedAgent(null);
            setRevealMessageId(null);
            setRevealTarget(null);
            setOverlay(null);
            setMobileView("conversation");
            setNotice(`Created workstream ${name}.`);
          }}
          onCreateTask={(title, summary) => {
            updateWorkspace(
              (workspace) => createLocalTask(workspace, title, summary),
              `Created durable task ${title}.`,
            );
            setOverlay(null);
          }}
          onCreateTaskFromMessage={createTaskFromExactMessage}
          onRecordDecision={recordDecisionFromExactMessage}
          onOpenThread={openMessageThread}
          onEditMessage={beginMessageEdit}
          onAttach={(artifact) => {
            setAttachedArtifact(artifact);
            setOverlay(null);
            setNotice("Sample evidence attached to the next message.");
          }}
          onCopyAuthority={() => {
            void copyText(getAuthoritySummary(current), "authority summary");
          }}
          onCopyContext={() => {
            void copyText(
              getConversationContextSummary(current),
              "context summary",
            );
          }}
          onExportSnapshot={exportSnapshot}
          onOpenPreferences={() => setOverlay({ kind: "preferences" })}
          onToggleAgentMetrics={() => {
            setShowAgentMetrics((value) => !value);
            setNotice(
              showAgentMetrics
                ? "Agent metrics hidden."
                : "Agent metrics shown.",
            );
          }}
          showAgentMetrics={showAgentMetrics}
        />
      )}
    </div>
  );
}
