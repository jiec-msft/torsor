import { useId, useState, useSyncExternalStore } from "react";
import type { WebController, WebState } from "./controller";
import { emptyRunComposer, isTerminalRun, needsRunRefresh } from "./run-composer-model";
import "./run-composer.css";

export function RunComposer({
  controller,
  state,
  runId,
  onOpenThread,
}: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly runId: string;
  readonly onOpenThread: (threadId: string, channelId: string) => void;
}) {
  const entries = useSyncExternalStore(
    controller.runComposer.subscribe, controller.runComposer.getSnapshot,
  );
  const entry = entries[runId] ?? emptyRunComposer;
  const id = useId();
  const refreshing = entry.projectionStatus === "refreshing";
  const [actionError, setActionError] = useState<string | null>(null);
  const run = state.run?.run.id === runId ? state.run.run : null;
  const agent = state.agents.find((candidate) => candidate.id === run?.ownerAgentId);
  const channel = state.bootstrap?.channels.find((candidate) => candidate.id === run?.homeChannelId);
  const pending = entry.status === "submitting";
  const recovery = entry.request !== null;
  const terminal = run !== null && isTerminalRun(run);
  const needsRefresh = run !== null && needsRunRefresh(entry, run);
  const unavailable = !run || state.session !== "ready" ||
    (!recovery && (terminal || needsRefresh || state.loadingRun));
  const disabled = unavailable || pending || refreshing || !entry.draft.trim();

  const send = async () => {
    if (disabled) return;
    setActionError(null);
    try {
      await controller.sendToRun(runId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The selected Run is unavailable.");
    }
  };
  const refresh = async () => {
    setActionError(null);
    await controller.refreshRunComposer(runId);
  };

  return (
    <form
      className="run-composer command-composer"
      aria-label="Send to Run"
      onSubmit={(event) => { event.preventDefault(); void send(); }}
    >
      <div className="run-composer-destination" id={`${id}-destination`}>
        <strong>Send to {agent?.name ?? run?.ownerAgentId ?? "selected Agent"} {run ? `(${run.ownerAgentId})` : ""}</strong>
        <span>Run {runId}{run ? ` · revision ${run.revision}` : ""}</span>
        {run ? (
          <button type="button" className="run-composer-source" onClick={() => onOpenThread(run.threadRootId, run.homeChannelId)}>
            Also published in #{channel?.name ?? run.homeChannelId} / Thread {run.threadRootId}
          </button>
        ) : <p>Waiting for the selected Run. Sending is unavailable.</p>}
      </div>
      <label htmlFor={`${id}-body`}>Run input</label>
      <textarea
        id={`${id}-body`}
        value={entry.draft}
        rows={3}
        readOnly={recovery}
        aria-describedby={`${id}-destination ${id}-status ${id}-help${entry.projectionStatus === "failed" ? ` ${id}-refresh-error` : ""}`}
        onChange={(event) => controller.runComposer.edit(runId, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send();
          }
        }}
      />
      <p id={`${id}-status`} role={entry.status === "rejected" ? "alert" : "status"} aria-atomic="true">
        {pending ? (entry.uncertain ? "Submitting the same request. Prior outcome remains unknown." : "Submitting Message and RunInput together.") :
          entry.status === "unknown" ? "Submission outcome unknown. Keep this request and retry with the same identity." :
          entry.status === "auth-required" ? "Authentication required. Reconnect, then retry the same submission." :
          entry.status === "rejected" ? "Neither Message nor RunInput committed. Review the rejection before sending again." :
          entry.status === "submitted" ? "Message and RunInput committed. Provider delivery and semantic handling are separate." :
          "Creates a public Message and Human-assigned RunInput together."}
        {entry.error ? ` ${entry.error}` : ""}
        {recovery ? ` Original revision ${entry.request!.expectedRunRevision}.` : ""}
      </p>
      {entry.projectionStatus === "failed" ? (
        <p id={`${id}-refresh-error`} role="alert" aria-atomic="true">
          {entry.acknowledged ? "Committed; projections could not be refreshed." : "Run and Thread could not be refreshed."}
          {" "}Use Refresh Run and Thread to retry reads, not the submission.
        </p>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {state.session !== "ready" ? <p>Reconnect to send or recover. Your draft and submission identity are retained in this window.</p> : null}
      {terminal ? <p>This Run is {run.state}. New input is unavailable. Successor creation is unavailable in this client; request follow-up in the public Thread.</p> : null}
      {needsRefresh ? <p>Refresh the Run and Thread, review the new revision, then send again.</p> : null}
      <p id={`${id}-help`} className="run-composer-help">
        Real-time delivery is not guaranteed; input may remain Pending until a later Activation.
        Enter adds a line. Ctrl/Cmd+Enter sends.
      </p>
      <div className="run-composer-actions">
        <button className="send-button" type="submit" disabled={disabled}>
          {pending ? "Submitting" : recovery ? "Retry same submission" : "Send to Run"}
        </button>
        <button type="button" disabled={!run || pending || refreshing || state.session !== "ready"} onClick={() => void refresh()}>
          {refreshing ? "Refreshing" : "Refresh Run and Thread"}
        </button>
      </div>
    </form>
  );
}
