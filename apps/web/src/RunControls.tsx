import { useId, useState, useSyncExternalStore } from "react";
import type { WebController, WebState } from "./controller";
import { emptyRunCommand, needsRunRefresh } from "./run-composer-model";
import { controlKey, controlUnavailable, type RunControlEntry } from "./run-controls-model";
import type { RunInput } from "./types";
import "./run-controls.css";

export function RunControls({ controller, state, runId }: {
  readonly controller: WebController;
  readonly state: WebState;
  readonly runId: string;
}) {
  const entries = useSyncExternalStore(controller.runControls.subscribe, controller.runControls.getSnapshot);
  const [actionError, setActionError] = useState<string | null>(null);
  const id = useId();
  const projection = state.run?.run.id === runId ? state.run : null;
  const run = projection?.run;
  const related = Object.entries(entries).filter(([key]) => JSON.parse(key)[0] === runId);
  const busy = related.some(([, entry]) => entry.status === "submitting");
  const refreshing = related.some(([, entry]) => entry.projectionStatus === "refreshing");
  const failed = related.some(([, entry]) => entry.projectionStatus === "failed") ||
    (!state.loadingRun && !!state.runRefreshError && (!state.run || !!projection));
  const committed = related.some(([, entry]) => entry.acknowledged);
  const recoveryError = controller.runControls.recoveryError;

  async function perform(inputId?: string) {
    setActionError(null);
    try {
      if (inputId) await controller.withdrawRunInput(runId, inputId);
      else await controller.cancelRun(runId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The Run control action could not be started.");
    }
  }

  function action(input?: RunInput, retainedId?: string) {
    const inputId = input?.id ?? retainedId;
    const entry: RunControlEntry = entries[controlKey(runId, inputId)] ?? emptyRunCommand;
    const recovery = entry.request !== null;
    const unavailable = run ? (inputId && !input ? "The original input is no longer in this projection." :
      controlUnavailable(run, controller.principalId, input)) : "Waiting for the selected Run.";
    const review = entry.reviewRequired || (run && needsRunRefresh(entry, run));
    const label = inputId ? `Withdraw Input ${input?.sequence ?? ""} (${inputId})` : "Cancel Run";
    const descriptionId = `${id}-${inputId ?? "cancel"}`;
    return (
      <div className="run-control-action" key={inputId ?? "cancel"}>
        <p id={descriptionId}>
          {inputId ? `Input ${input?.sequence ?? ""} (${inputId}): ${input?.disposition ?? "unavailable"}. ` : `Run ${runId}: ${run?.state ?? "unavailable"}. `}
          {unavailable ?? (inputId ? "Withdraw this Pending assignment, not its public Message." : "Cancel logical work; physical stopping is asynchronous.")}
          {review ? " Refresh and review before a new action." : ""}
        </p>
        {(!unavailable || recovery || entry.status === "rejected") ? (
          <button type="button" aria-describedby={descriptionId}
            disabled={!run || !!recoveryError || state.session !== "ready" || busy || refreshing ||
              (!recovery && (!!unavailable || !!review || !!entry.acknowledged || state.loadingRun)) ||
              (recovery && entry.principalId !== controller.principalId)}
            onClick={() => void perform(inputId)}>
            {entry.status === "submitting" ? `Submitting: ${label}` : recovery ? `Retry same action: ${label}` : label}
          </button>
        ) : null}
        {entry.status !== "draft" ? (
          <p role={entry.status === "rejected" ? "alert" : "status"} aria-atomic="true">
            {entry.status === "submitting" ? "Submitting action. Physical stop is not confirmed." :
              entry.status === "unknown" ? "Outcome unknown. Retry the same action to confirm it; do not create a replacement." :
              entry.status === "auth-required" ? "Authentication required. Reconnect, then retry the same action." :
              entry.status === "rejected" ? "Action rejected; this request did not commit." :
              inputId ? "Input withdrawal committed. The public Message and Provider delivery history remain." :
              "Logical cancellation committed. Physical Provider stop is not confirmed by this receipt."}
            {entry.error ? ` ${entry.error}` : ""}
            {recovery ? ` Original Run revision ${entry.request!.expectedRunRevision}.` : ""}
            {recovery && entry.principalId !== controller.principalId ? " Reconnect as the original Human to recover this action." : ""}
          </p>
        ) : entry.error ? <p role="alert">{entry.error}</p> : null}
      </div>
    );
  }

  const retainedInputs = related.flatMap(([, entry]) => {
    const request = entry.request ?? entry.acknowledged?.request;
    return request?.kind === "withdraw" && !projection?.inputs.some((input) => input.id === request.runInputId)
      ? [request.runInputId] : [];
  });
  return (
    <section className="run-controls" aria-label="Human Run controls" aria-busy={busy || refreshing}>
      <h3>Human Run controls</h3>
      <p>Logical cancellation, stop requested, confirmed physical stop, and Worktree quarantine are separate.
        Physical stop and Worktree quarantine cannot be confirmed from this projection. Cancellation does not prove safe Worktree release.</p>
      {action()}
      {[...(projection?.inputs.map((input) => input.id) ?? []), ...retainedInputs]
        .map((inputId) => action(projection?.inputs.find((input) => input.id === inputId), inputId))}
      {recoveryError || actionError ? <p role="alert">{recoveryError ?? actionError}</p> : null}
      {failed ? <p role="alert">{committed ? "Committed; projections could not be refreshed." : "Projections could not be refreshed."} Retry reads, not the action.</p> : null}
      <button type="button" disabled={state.session !== "ready" || busy || refreshing || state.loadingRun}
        onClick={() => void controller.refreshRunControls(runId)}>
        {refreshing ? "Refreshing controls and Timeline" : "Refresh controls and Timeline"}
      </button>
    </section>
  );
}
