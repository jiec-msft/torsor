import { describe, expect, it } from "vitest";
import {
  appendThreadReply,
  approveResult,
  canRetryTask,
  canStartFollowUpRun,
  completeAgentResponse,
  createDemoProduct,
  createDemoWorkspace,
  createInitialWorkspace,
  createLocalWorkstream,
  createOnboardingWorkspace,
  createTaskFromMessage,
  failTaskRun,
  getComposerStateAfterConversationChange,
  getComposerStateAfterEditCancel,
  getComposerStateForMessageEdit,
  getDisplayedExternalEffect,
  getAgentActivity,
  getAgentDisplayItems,
  getAgentMessagingUnavailableReason,
  getMessageTargetUnavailableReason,
  getAgentRunUnavailableReason,
  getAgentWorkspaceScope,
  getAgentStatusItems,
  getArtifactCardContent,
  getMessageEditability,
  getMessageReplySummary,
  getProductNavigation,
  getAuthoritySummary,
  getConversationContextSummary,
  getPublicPrototypeSnapshot,
  getSampleMessageArtifact,
  getSearchDestination,
  getTaskActionTarget,
  isMessageVisibleInAgentConversation,
  getTaskDisplayState,
  getWorkstreamLogItems,
  getWorkspaceCounts,
  getSelectedWorkstream,
  reconcileExternalEffect,
  recordDecision,
  requestChanges,
  retryTaskRun,
  searchProduct,
  selectWorkstream,
  startAgentResponse,
  startTaskFollowUpRun,
  submitRunResult,
  toggleMessageReaction,
  updateHumanMessage,
  updateWorkstreamById,
  updateWorkspaceById,
  PUBLIC_SNAPSHOT_FILENAME,
} from "./workspace";

function createInitialWorkstream() {
  const release = getSelectedWorkstream(createDemoProduct());
  return {
    ...release,
    workspace: createInitialWorkspace(),
    agents: release.agents.map((agent) =>
      agent.id === "agent-nova"
        ? {
            ...agent,
            status: "running" as const,
            presence: "Running now",
            activity: "Working on Validate the release package",
          }
        : agent,
    ),
  };
}

describe("durable workspace", () => {
  it("keeps a message as a message until the human explicitly creates a task", () => {
    const initial = createInitialWorkspace();
    const sourceMessage = initial.messages.find(
      (message) => message.id === "message-human-brief",
    )!;

    expect(initial.tasks).toHaveLength(1);

    const next = createTaskFromMessage(initial, "message-human-brief");

    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[1]).toMatchObject({
      title: `${sourceMessage.body.slice(0, 69).trimEnd()}...`,
      summary: sourceMessage.body,
      sourceMessageId: "message-human-brief",
      status: "open",
    });
    expect(
      next.messages.find((message) => message.id === "message-human-brief")
        ?.taskDraft,
    ).toBeUndefined();
  });

  it("updates the exact human message in place and preserves its recipient", () => {
    const initial = createOnboardingWorkspace();
    const originalCount = initial.messages.length;

    const next = updateHumanMessage(
      initial,
      "message-human-onboarding-followup",
      "Also make the no-run state useful and actionable.",
    );

    expect(next.messages).toHaveLength(originalCount);
    expect(
      next.messages.find(
        (message) => message.id === "message-human-onboarding-followup",
      ),
    ).toMatchObject({
      id: "message-human-onboarding-followup",
      body: "Also make the no-run state useful and actionable.",
      recipient: "Orbit",
    });
    expect(
      next.messages.find((message) => message.id === "message-onboarding-brief")
        ?.body,
    ).toBe(
      "Create a starter workspace that teaches the difference between a durable task and an agent run.",
    );
  });

  it("clears a stale task proposal when an unpromoted message is edited", () => {
    const next = updateHumanMessage(
      createDemoWorkspace(),
      "message-human-followup",
      "Write a rollback checklist for the deploying human.",
    );

    expect(
      next.messages.find(
        (message) => message.id === "message-human-followup",
      ),
    ).toMatchObject({
      body: "Write a rollback checklist for the deploying human.",
      taskDraft: undefined,
    });
  });

  it("creates a source-linked task from the edited visible message", () => {
    const edited = updateHumanMessage(
      createDemoWorkspace(),
      "message-human-followup",
      "Write a rollback checklist for the deploying human.",
    );

    const next = createTaskFromMessage(edited, "message-human-followup");

    expect(next.tasks.at(-1)).toMatchObject({
      title: "Write a rollback checklist for the deploying human.",
      summary: "Write a rollback checklist for the deploying human.",
      sourceMessageId: "message-human-followup",
    });
  });

  it("rejects editing an Agent message", () => {
    expect(() =>
      updateHumanMessage(
        createOnboardingWorkspace(),
        "message-orbit-plan",
        "Rewrite preserved Agent output.",
      ),
    ).toThrow("Only human messages can be edited.");
  });

  it("rejects editing a message after it becomes a task source", () => {
    const promoted = createTaskFromMessage(
      createInitialWorkspace(),
      "message-human-brief",
    );

    expect(() =>
      updateHumanMessage(
        promoted,
        "message-human-brief",
        "Replace the source after task creation.",
      ),
    ).toThrow("Promoted messages cannot be edited.");
  });

  it("rejects editing a message after it becomes a decision source", () => {
    const promoted = recordDecision(
      createInitialWorkspace(),
      "message-human-brief",
    );

    expect(() =>
      updateHumanMessage(
        promoted,
        "message-human-brief",
        "Replace the source after decision recording.",
      ),
    ).toThrow("Promoted messages cannot be edited.");
  });

  it("reports promoted messages as edit-disabled for the UI", () => {
    const workspace = createDemoWorkspace();

    expect(
      getMessageEditability(workspace, "message-human-brief"),
    ).toEqual({
      editable: false,
      reason: "Promoted messages cannot be edited.",
    });
    expect(
      getMessageEditability(workspace, "message-human-followup"),
    ).toEqual({ editable: true });
  });

  it("rejects editing a missing message instead of succeeding as a no-op", () => {
    expect(() =>
      updateHumanMessage(
        createOnboardingWorkspace(),
        "message-missing",
        "This target does not exist.",
      ),
    ).toThrow("The selected message does not exist.");
  });

  it("rejects an empty human message edit", () => {
    expect(() =>
      updateHumanMessage(
        createOnboardingWorkspace(),
        "message-human-onboarding-followup",
        "   ",
      ),
    ).toThrow("Enter message text before saving.");
  });

  it("loads the exact human message body without changing conversation target", () => {
    const state = getComposerStateForMessageEdit(
      createOnboardingWorkspace(),
      "message-human-onboarding-followup",
      {
        composer: "Unrelated draft",
        attachedArtifact: null,
        agentCommand: true,
        target: "Orbit",
        editingMessageId: null,
      },
    );

    expect(state).toEqual({
      composer: "Also make the empty state useful when no agent has started a run.",
      attachedArtifact: null,
      agentCommand: false,
      target: "Orbit",
      editingMessageId: "message-human-onboarding-followup",
    });
  });

  it("cancels message editing without sending or retaining the edited body", () => {
    expect(
      getComposerStateAfterEditCancel({
        composer: "Changed but not submitted",
        attachedArtifact: null,
        agentCommand: false,
        target: "Orbit",
        editingMessageId: "message-human-onboarding-followup",
      }),
    ).toEqual({
      composer: "",
      attachedArtifact: null,
      agentCommand: false,
      target: "Orbit",
      editingMessageId: null,
    });
  });

  it("records distinct decisions linked to the exact source messages", () => {
    const initial = { ...createDemoWorkspace(), decisions: [] };

    const first = recordDecision(initial, "message-human-brief");
    const next = recordDecision(first, "message-human-followup");

    expect(next.decisions).toHaveLength(2);
    expect(next.decisions.map((decision) => decision.sourceMessageId)).toEqual([
      "message-human-brief",
      "message-human-followup",
    ]);
    expect(next.decisions[0].title).not.toBe(next.decisions[1].title);
    expect(next.decisions[0].detail).toBe(
      initial.messages.find((message) => message.id === "message-human-brief")
        ?.body,
    );
    expect(next.decisions[1].detail).toBe(
      initial.messages.find(
        (message) => message.id === "message-human-followup",
      )?.body,
    );
  });

  it("derives a decision title from visible message content", () => {
    const initial = createInitialWorkspace();

    const next = recordDecision(initial, "message-human-brief");

    expect(next.decisions.at(-1)).toMatchObject({
      title:
        "Turn the release notes into a launch-ready update and verify the publ...",
      detail:
        "Turn the release notes into a launch-ready update and verify the publish step.",
      sourceMessageId: "message-human-brief",
    });
  });

  it("prevents promoting the same source message to a decision twice", () => {
    const once = recordDecision(
      { ...createDemoWorkspace(), decisions: [] },
      "message-human-followup",
    );

    expect(() =>
      recordDecision(once, "message-human-followup"),
    ).toThrow("This message already has a durable decision.");
  });

  it("rejects recording a decision from a missing message", () => {
    expect(() =>
      recordDecision(createDemoWorkspace(), "message-missing"),
    ).toThrow("The selected message does not exist.");
  });

  it("keeps the durable task open when an agent run fails", () => {
    const initial = createInitialWorkstream();

    const next = failTaskRun(initial, "run-185").workspace;

    expect(next.runs.find((run) => run.id === "run-185")?.status).toBe("failed");
    expect(next.tasks.find((task) => task.id === "task-release-update")?.status).toBe(
      "open",
    );
  });

  it("marks the owning Agent errored when its active run fails", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const started = retryTaskRun(
      {
        ...release,
        workspace: reconcileExternalEffect(
          release.workspace,
          "effect-publish",
        ),
      },
      "task-publish-receipt",
      "agent-orbit-release",
    );
    const runId = started.workspace.runs.at(-1)!.id;

    const next = failTaskRun(started, runId);

    expect(next.workspace.runs.at(-1)?.status).toBe("failed");
    expect(
      next.agents.find((agent) => agent.id === "agent-orbit-release"),
    ).toMatchObject({
      status: "error",
      presence: "Error · run stopped",
      activity: "Run stopped · durable state preserved",
    });
  });

  it("creates a new run for a retry instead of rewriting the failed attempt", () => {
    const failed = failTaskRun(createInitialWorkstream(), "run-185");
    const initial = failed.workspace;

    expect(canRetryTask(initial, "task-release-update")).toBe(true);

    const retried = retryTaskRun(
      failed,
      "task-release-update",
      "agent-orbit-release",
    );
    const next = retried.workspace;

    expect(next.runs.find((run) => run.id === "run-185")?.status).toBe("failed");
    expect(next.runs.at(-1)).toMatchObject({
      taskId: "task-release-update",
      agentId: "agent-orbit-release",
      status: "running",
      attempt: 3,
    });
    expect(next.tasks[0].runIds).toHaveLength(3);
    expect(canRetryTask(next, "task-release-update")).toBe(false);
    expect(getTaskDisplayState(next, "task-release-update")).toBe("in-progress");
    expect(() =>
      retryTaskRun(retried, "task-release-update", "agent-keel"),
    ).toThrow("The selected task is not eligible for retry.");

    const failedAgain = failTaskRun(
      retried,
      next.runs.at(-1)!.id,
    ).workspace;

    expect(canRetryTask(failedAgain, "task-release-update")).toBe(true);
    expect(getTaskDisplayState(failedAgain, "task-release-update")).toBe(
      "failed",
    );
  });

  it("blocks a retry until the task's uncertain external effect is reconciled", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const initial = release.workspace;

    expect(canRetryTask(initial, "task-publish-receipt")).toBe(false);
    expect(() =>
      retryTaskRun(
        release,
        "task-publish-receipt",
        "agent-orbit-release",
      ),
    ).toThrow("The selected task is not eligible for retry.");

    const reconciled = reconcileExternalEffect(initial, "effect-publish");

    expect(canRetryTask(reconciled, "task-publish-receipt")).toBe(true);
    expect(
      retryTaskRun(
        { ...release, workspace: reconciled },
        "task-publish-receipt",
        "agent-orbit-release",
      ).workspace.runs.at(-1),
    ).toMatchObject({
      taskId: "task-publish-receipt",
      status: "running",
      attempt: 2,
    });
  });

  it("starts a retry with an idle Agent and updates only that Agent lifecycle", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const workstream = {
      ...release,
      workspace: reconcileExternalEffect(
        release.workspace,
        "effect-publish",
      ),
    };
    const unchangedAgents = workstream.agents.filter(
      (agent) => agent.id !== "agent-orbit-release",
    );

    const next = retryTaskRun(
      workstream,
      "task-publish-receipt",
      "agent-orbit-release",
    );

    expect(next.workspace.runs.at(-1)).toMatchObject({
      taskId: "task-publish-receipt",
      agentId: "agent-orbit-release",
      status: "running",
    });
    expect(
      next.agents.find((agent) => agent.id === "agent-orbit-release"),
    ).toMatchObject({
      status: "running",
      presence: "Running now",
      activity: "Working on Verify publish receipt",
    });
    expect(
      next.agents.filter((agent) => agent.id !== "agent-orbit-release"),
    ).toEqual(unchangedAgents);
  });

  it("advances through uncertain effects without unblocking another task", () => {
    const changed = requestChanges(createDemoWorkspace(), "result-1");
    const withTwoEffects = {
      ...changed,
      externalEffects: [
        ...changed.externalEffects,
        {
          id: "effect-release-delivery",
          taskId: "task-release-update",
          title: "Release delivery may have started",
          detail: "The local prototype has no confirmed receipt.",
          status: "uncertain" as const,
        },
      ],
    };

    expect(getDisplayedExternalEffect(withTwoEffects)?.id).toBe(
      "effect-publish",
    );
    expect(canRetryTask(withTwoEffects, "task-publish-receipt")).toBe(false);
    expect(canStartFollowUpRun(withTwoEffects, "task-release-update")).toBe(
      false,
    );

    const firstReconciled = reconcileExternalEffect(
      withTwoEffects,
      "effect-publish",
    );

    expect(getDisplayedExternalEffect(firstReconciled)).toMatchObject({
      id: "effect-release-delivery",
      status: "uncertain",
    });
    expect(canRetryTask(firstReconciled, "task-publish-receipt")).toBe(true);
    expect(canStartFollowUpRun(firstReconciled, "task-release-update")).toBe(
      false,
    );

    const allReconciled = reconcileExternalEffect(
      firstReconciled,
      "effect-release-delivery",
    );

    expect(getDisplayedExternalEffect(allReconciled)).toMatchObject({
      id: "effect-release-delivery",
      status: "confirmed",
    });
    expect(canRetryTask(allReconciled, "task-publish-receipt")).toBe(true);
    expect(canStartFollowUpRun(allReconciled, "task-release-update")).toBe(true);
  });

  it("starts a new follow-up run after the human requests changes", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const changed = requestChanges(release.workspace, "result-1");

    expect(canStartFollowUpRun(changed, "task-release-update")).toBe(true);

    const next = startTaskFollowUpRun(
      { ...release, workspace: changed },
      "task-release-update",
      "agent-orbit-release",
    ).workspace;

    expect(next.runs.find((run) => run.id === "run-185")?.status).toBe(
      "completed",
    );
    expect(next.runs.at(-1)).toMatchObject({
      taskId: "task-release-update",
      agentId: "agent-orbit-release",
      status: "running",
      attempt: 3,
    });
    expect(next.tasks[0].runIds).toHaveLength(3);
  });

  it("keeps run IDs unique through repeated review follow-up cycles", () => {
    let workstream = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );

    for (let cycle = 1; cycle <= 17; cycle += 1) {
      const activeRun = workstream.workspace.runs.at(-1)!;
      const submitted = submitRunResult(
        workstream,
        activeRun.id,
        `Review cycle ${cycle} is ready.`,
      );
      const changed = requestChanges(
        submitted.workspace,
        submitted.workspace.results.at(-1)!.id,
      );
      workstream = startTaskFollowUpRun(
        { ...submitted, workspace: changed },
        "task-configure-starter",
        "agent-orbit",
      );
    }

    const newestRun = workstream.workspace.runs.at(-1)!;
    const submitted = submitRunResult(
      workstream,
      newestRun.id,
      "The newest follow-up is ready.",
    );
    const runIds = workstream.workspace.runs.map((run) => run.id);

    expect(new Set(runIds).size).toBe(runIds.length);
    expect(submitted.workspace.results.at(-1)?.runId).toBe(newestRun.id);
  });

  it("ignores custom run IDs when allocating the next numeric ID", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const changed = requestChanges(release.workspace, "result-1");
    const workstream = {
      ...release,
      workspace: {
        ...changed,
        runs: [
          ...changed.runs,
          {
            id: "run-999-custom",
            taskId: "task-release-update",
            agentId: "agent-sable",
            status: "completed" as const,
            attempt: 0,
          },
        ],
      },
    };

    const next = startTaskFollowUpRun(
      workstream,
      "task-release-update",
      "agent-orbit-release",
    ).workspace;

    expect(next.runs.at(-1)?.id).toBe("run-187");
    expect(next.runs.some((run) => run.id === "run-999-custom")).toBe(true);
  });

  it("starts a follow-up with a queued Agent and updates only that Agent lifecycle", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const workstream = {
      ...release,
      workspace: requestChanges(release.workspace, "result-1"),
    };
    const unchangedAgents = workstream.agents.filter(
      (agent) => agent.id !== "agent-keel",
    );

    const next = startTaskFollowUpRun(
      workstream,
      "task-release-update",
      "agent-keel",
    );

    expect(next.workspace.runs.at(-1)).toMatchObject({
      taskId: "task-release-update",
      agentId: "agent-keel",
      status: "running",
    });
    expect(next.agents.find((agent) => agent.id === "agent-keel")).toMatchObject(
      {
        status: "running",
        presence: "Running now",
        activity: "Working on Prepare the 0.8 release update",
      },
    );
    expect(next.agents.filter((agent) => agent.id !== "agent-keel")).toEqual(
      unchangedAgents,
    );
  });

  it("rejects another follow-up start while the new run is running", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const changed = requestChanges(release.workspace, "result-1");
    const running = startTaskFollowUpRun(
      { ...release, workspace: changed },
      "task-release-update",
      "agent-orbit-release",
    );

    expect(
      canStartFollowUpRun(running.workspace, "task-release-update"),
    ).toBe(false);
    expect(() =>
      startTaskFollowUpRun(running, "task-release-update", "agent-keel"),
    ).toThrow("The selected task is not eligible for a follow-up run.");
  });

  it("blocks a follow-up run while its external effect is uncertain", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const changed = requestChanges(release.workspace, "result-1");
    const blocked = {
      ...changed,
      externalEffects: [
        ...changed.externalEffects,
        {
          id: "effect-release-delivery",
          taskId: "task-release-update",
          title: "Release delivery may have started",
          detail: "The local prototype has no confirmed receipt.",
          status: "uncertain" as const,
        },
      ],
    };

    expect(canStartFollowUpRun(blocked, "task-release-update")).toBe(false);
    expect(() =>
      startTaskFollowUpRun(
        { ...release, workspace: blocked },
        "task-release-update",
        "agent-orbit-release",
      ),
    ).toThrow("The selected task is not eligible for a follow-up run.");
  });

  it("places an agent result into explicit human review", () => {
    const next = submitRunResult(
      createInitialWorkstream(),
      "run-185",
      "Release update is ready with package evidence attached.",
    ).workspace;

    expect(next.results.at(-1)).toMatchObject({
      runId: "run-185",
      reviewState: "pending",
    });
    expect(next.tasks[0].status).toBe("in_review");
    expect(getTaskDisplayState(next, "task-release-update")).toBe("in-review");
  });

  it("returns the owning Agent to idle when its final active run completes", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );

    const next = submitRunResult(
      onboarding,
      "run-201",
      "Starter workspace is ready for review.",
    );

    expect(next.workspace.runs[0].status).toBe("completed");
    expect(next.workspace.results.at(-1)?.reviewState).toBe("pending");
    expect(next.agents.find((agent) => agent.id === "agent-orbit")).toMatchObject(
      {
        status: "idle",
        presence: "Idle",
        activity: undefined,
      },
    );
  });

  it("marks the durable result and task complete only after human approval", () => {
    const submitted = submitRunResult(
      createInitialWorkstream(),
      "run-185",
      "Release update is ready with package evidence attached.",
    ).workspace;

    const next = approveResult(submitted, "result-1");

    expect(next.results[0].reviewState).toBe("approved");
    expect(next.tasks[0].status).toBe("done");
    expect(getTaskDisplayState(next, "task-release-update")).toBe("done");
  });

  it("offers review actions only to the Agent scope that owns the result run", () => {
    const workstream = getSelectedWorkstream(createDemoProduct());
    const initial = workstream.workspace;
    const nova = getAgentWorkspaceScope(workstream, "Nova");
    const sable = getAgentWorkspaceScope(workstream, "Sable");
    const keel = getAgentWorkspaceScope(workstream, "Keel");

    expect(nova.tasks.map((task) => task.id)).toEqual([
      "task-release-update",
    ]);
    expect(nova.results).toEqual([]);
    expect(sable.results.map((result) => result.id)).toEqual(["result-1"]);
    expect(keel.results).toEqual([]);

    const approved = approveResult(initial, sable.results[0].id);

    expect(approved.results[0].reviewState).toBe("approved");
    expect(initial.results[0].reviewState).toBe("pending");
  });

  it("reviews the clicked result when an agent filter hides an earlier pending result", () => {
    const workstream = getSelectedWorkstream(createDemoProduct());
    const initial = workstream.workspace;
    const withTwoPendingResults = {
      ...initial,
      tasks: initial.tasks.map((task) =>
        task.id === "task-publish-receipt"
          ? { ...task, status: "in_review" as const }
          : task,
      ),
      results: [
        ...initial.results,
        {
          id: "result-2",
          runId: "run-186",
          taskId: "task-publish-receipt",
          summary: "Publish receipt evidence is ready for review.",
          reviewState: "pending" as const,
        },
      ],
    };
    const visibleResults = getAgentWorkspaceScope(
      { ...workstream, workspace: withTwoPendingResults },
      "Keel",
    ).results;

    expect(visibleResults.map((result) => result.id)).toEqual(["result-2"]);
    expect(
      getAgentWorkspaceScope(
        { ...workstream, workspace: withTwoPendingResults },
        "Sable",
      ).externalEffects,
    ).toEqual([]);
    expect(
      getAgentWorkspaceScope(
        { ...workstream, workspace: withTwoPendingResults },
        "Keel",
      ).externalEffects.map((effect) => effect.id),
    ).toEqual(["effect-publish"]);

    const next = approveResult(withTwoPendingResults, visibleResults[0].id);

    expect(
      next.results.map((result) => [result.id, result.reviewState]),
    ).toEqual([
      ["result-1", "pending"],
      ["result-2", "approved"],
    ]);
    expect(
      next.tasks.map((task) => [task.id, task.status]),
    ).toEqual([
      ["task-release-update", "in_review"],
      ["task-publish-receipt", "done"],
    ]);

    const changed = requestChanges(
      withTwoPendingResults,
      visibleResults[0].id,
    );

    expect(
      changed.results.map((result) => [result.id, result.reviewState]),
    ).toEqual([
      ["result-1", "pending"],
      ["result-2", "changes_requested"],
    ]);
    expect(
      changed.tasks.map((task) => [task.id, task.status]),
    ).toEqual([
      ["task-release-update", "in_review"],
      ["task-publish-receipt", "open"],
    ]);
  });

  it("requires the selected task when several visible tasks can run the same action", () => {
    const initial = reconcileExternalEffect(
      createDemoWorkspace(),
      "effect-publish",
    );
    const withTwoRetryableTasks = {
      ...initial,
      tasks: [
        ...initial.tasks,
        {
          id: "task-second-failed",
          title: "Verify the second receipt",
          summary: "Keep the second failed attempt separate.",
          status: "open" as const,
          activeAgentId: "agent-keel",
          runIds: ["run-second-failed"],
        },
      ],
      runs: [
        ...initial.runs,
        {
          id: "run-second-failed",
          taskId: "task-second-failed",
          agentId: "agent-keel",
          status: "failed" as const,
          attempt: 1,
        },
      ],
    };
    const visibleTaskIds = [
      "task-publish-receipt",
      "task-second-failed",
    ];

    expect(
      getTaskActionTarget(
        withTwoRetryableTasks,
        visibleTaskIds,
        null,
        "retry",
      ),
    ).toBeUndefined();
    expect(
      getTaskActionTarget(
        withTwoRetryableTasks,
        visibleTaskIds,
        "task-second-failed",
        "retry",
      ),
    ).toBe("task-second-failed");
  });

  it("keeps replacement runs visible in the matching Agent scope", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const retried = retryTaskRun(
      {
        ...release,
        workspace: reconcileExternalEffect(
          release.workspace,
          "effect-publish",
        ),
      },
      "task-publish-receipt",
      "agent-orbit-release",
    );

    expect(
      getAgentWorkspaceScope(retried, "Orbit").runs.map((run) => run.id),
    ).toEqual([retried.workspace.runs.at(-1)!.id]);
    expect(
      getAgentWorkspaceScope(retried, "Orbit").tasks.map((task) => task.id),
    ).toEqual(["task-publish-receipt"]);
  });

  it("links the existing demo task to its source message and creates only the new follow-up task", () => {
    const initial = createDemoWorkspace();
    const actionableDrafts = initial.messages.filter(
      (message) =>
        message.taskDraft &&
        !initial.tasks.some((task) => task.sourceMessageId === message.id),
    );

    expect(
      initial.tasks.find((task) => task.id === "task-release-update")
        ?.sourceMessageId,
    ).toBe("message-human-brief");
    expect(actionableDrafts.map((message) => message.id)).toEqual([
      "message-human-followup",
    ]);

    const next = createTaskFromMessage(initial, "message-human-followup");

    expect(next.tasks).toHaveLength(3);
    expect(
      next.tasks.filter((task) => task.title === "Prepare the 0.8 release update"),
    ).toHaveLength(1);
    const sourceMessage = initial.messages.find(
      (message) => message.id === "message-human-followup",
    )!;
    expect(next.tasks.at(-1)).toMatchObject({
      title: `${sourceMessage.body.slice(0, 69).trimEnd()}...`,
      summary: sourceMessage.body,
      sourceMessageId: "message-human-followup",
    });
  });

  it("derives task, review, and pending-action counts from durable state transitions", () => {
    const initial = createDemoWorkspace();

    expect(getWorkspaceCounts(initial)).toEqual({
      taskCount: 2,
      reviewCount: 1,
      pendingActionCount: 2,
    });
    expect(
      getWorkspaceCounts(
        createTaskFromMessage(initial, "message-human-followup"),
      ),
    ).toEqual({
      taskCount: 3,
      reviewCount: 1,
      pendingActionCount: 2,
    });
    expect(getWorkspaceCounts(approveResult(initial, "result-1"))).toEqual({
      taskCount: 2,
      reviewCount: 0,
      pendingActionCount: 1,
    });
    expect(getWorkspaceCounts(requestChanges(initial, "result-1"))).toEqual({
      taskCount: 2,
      reviewCount: 0,
      pendingActionCount: 2,
    });
    expect(
      getWorkspaceCounts(
        retryTaskRun(
          {
            ...getSelectedWorkstream(createDemoProduct()),
            workspace: reconcileExternalEffect(initial, "effect-publish"),
          },
          "task-publish-receipt",
          "agent-orbit-release",
        ).workspace,
      ),
    ).toEqual({
      taskCount: 2,
      reviewCount: 1,
      pendingActionCount: 1,
    });
    expect(
      getWorkspaceCounts(reconcileExternalEffect(initial, "effect-publish")),
    ).toEqual({
      taskCount: 2,
      reviewCount: 1,
      pendingActionCount: 2,
    });
    expect(getWorkspaceCounts(createOnboardingWorkspace())).toEqual({
      taskCount: 1,
      reviewCount: 0,
      pendingActionCount: 0,
    });
  });

  it("derives global inbox and pending counts from live workstream state", () => {
    const initial = createDemoProduct();
    const initialNavigation = getProductNavigation(initial);

    expect(initialNavigation.counts).toMatchObject({
      inbox: 2,
      pending: 2,
    });
    expect(initialNavigation.pendingItems.map((item) => item.title)).toEqual([
      "Review Prepare the 0.8 release update",
      "Reconcile Publish request may have succeeded",
    ]);
    expect(
      initialNavigation.pendingItems.some(
        (item) => item.workstreamId === "workstream-onboarding",
      ),
    ).toBe(false);
    expect(
      initialNavigation.inboxItems.map((item) => [
        item.workstreamId,
        item.title,
        item.meta,
      ]),
    ).toEqual([
      [
        "workstream-release",
        "Review Prepare the 0.8 release update",
        "Release 0.8 · Human review",
      ],
      [
        "workstream-release",
        "Reconcile Publish request may have succeeded",
        "Release 0.8 · External effect",
      ],
    ]);

    const approved = updateWorkspaceById(
      initial,
      "workstream-release",
      (workspace) => approveResult(workspace, "result-1"),
    );
    const approvedNavigation = getProductNavigation(approved);

    expect(approvedNavigation.counts).toMatchObject({
      inbox: 1,
      pending: 1,
    });
    expect(approvedNavigation.inboxItems.map((item) => item.title)).toEqual([
      "Reconcile Publish request may have succeeded",
    ]);
  });

  it("carries the exact durable object in every global navigation destination", () => {
    const initial = createDemoProduct();
    const navigation = getProductNavigation(initial);

    expect(navigation.inboxItems[0].destination).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: null,
      view: "tasks",
      target: { type: "result", id: "result-1" },
    });
    expect(navigation.inboxItems[1].destination).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: null,
      view: "tasks",
      target: { type: "effect", id: "effect-publish" },
    });
    expect(
      navigation.activityItems.find((item) =>
        item.id.endsWith(":run:run-201"),
      )?.destination,
    ).toEqual({
      workstreamId: "workstream-onboarding",
      selectedAgent: null,
      view: "tasks",
      target: { type: "run", id: "run-201" },
    });

    const withMessage = updateWorkstreamById(
      initial,
      "workstream-onboarding",
      (workstream) =>
        startAgentResponse(
          workstream,
          "Keep this exact navigation message visible.",
          "Orbit",
        ).workstream,
    );
    expect(
      getProductNavigation(withMessage).activityItems.find((item) =>
        item.id.includes(":message:"),
      )?.destination,
    ).toEqual({
      workstreamId: "workstream-onboarding",
      selectedAgent: "Orbit",
      view: "conversation",
      target: expect.objectContaining({ type: "message" }),
    });
  });

  it("derives recent activity with workstream context from current durable state", () => {
    const initial = createDemoProduct();
    const initialActivity = getProductNavigation(initial).activityItems;

    expect(initialActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workstreamId: "workstream-release",
          title: "Result submitted for Prepare the 0.8 release update",
          meta: "Release 0.8 · 09:44",
        }),
        expect.objectContaining({
          workstreamId: "workstream-release",
          title:
            "External effect needs reconciliation: Publish request may have succeeded",
          meta: "Release 0.8 · 09:45",
        }),
        expect.objectContaining({
          workstreamId: "workstream-onboarding",
          title: "Orbit started run-201",
          meta: "Onboarding flow · 10:05",
        }),
      ]),
    );

    const resolved = updateWorkspaceById(
      updateWorkspaceById(
        initial,
        "workstream-release",
        (workspace) => approveResult(workspace, "result-1"),
      ),
      "workstream-release",
      (workspace) => reconcileExternalEffect(workspace, "effect-publish"),
    );
    const resolvedActivity = getProductNavigation(resolved).activityItems;

    expect(resolvedActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Result approved for Prepare the 0.8 release update",
          meta: "Release 0.8 · Now",
        }),
        expect.objectContaining({
          title:
            "External effect reconciled: Publish request may have succeeded",
          meta: "Release 0.8 · Now",
        }),
      ]),
    );
    expect(resolvedActivity.map((item) => item.title)).not.toContain(
      "Result submitted for Prepare the 0.8 release update",
    );
  });

  it("replaces reconciliation requests with retry actions and clears them after retry", () => {
    const initial = createDemoProduct();
    const reconciled = updateWorkspaceById(
      initial,
      "workstream-release",
      (workspace) => reconcileExternalEffect(workspace, "effect-publish"),
    );
    const reconciledNavigation = getProductNavigation(reconciled);

    expect(reconciledNavigation.counts).toMatchObject({
      inbox: 2,
      pending: 2,
    });
    expect(reconciledNavigation.inboxItems.map((item) => item.title)).toEqual([
      "Review Prepare the 0.8 release update",
      "Retry Verify publish receipt",
    ]);

    const retried = updateWorkstreamById(
      reconciled,
      "workstream-release",
      (workstream) =>
        retryTaskRun(
          workstream,
          "task-publish-receipt",
          "agent-orbit-release",
        ),
    );
    const retriedNavigation = getProductNavigation(retried);

    expect(retriedNavigation.counts).toMatchObject({
      inbox: 1,
      pending: 1,
    });
    expect(retriedNavigation.inboxItems.map((item) => item.title)).toEqual([
      "Review Prepare the 0.8 release update",
    ]);
    expect(retriedNavigation.activityItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: expect.stringMatching(/^Orbit started run-/),
          meta: "Release 0.8 · Now",
        }),
      ]),
    );
  });

  it("tracks follow-up runs and new workstreams in global live views", () => {
    const changed = updateWorkspaceById(
      createDemoProduct(),
      "workstream-release",
      (workspace) => requestChanges(workspace, "result-1"),
    );
    const changedNavigation = getProductNavigation(changed);

    expect(changedNavigation.inboxItems.map((item) => item.title)).toEqual([
      "Reconcile Publish request may have succeeded",
      "Start follow-up for Prepare the 0.8 release update",
    ]);
    expect(changedNavigation.counts).toMatchObject({
      inbox: 2,
      pending: 2,
    });

    const running = updateWorkstreamById(
      changed,
      "workstream-release",
      (workstream) =>
        startTaskFollowUpRun(
          workstream,
          "task-release-update",
          "agent-orbit-release",
        ),
    );
    const runningNavigation = getProductNavigation(running);

    expect(runningNavigation.inboxItems.map((item) => item.title)).toEqual([
      "Reconcile Publish request may have succeeded",
    ]);
    expect(runningNavigation.counts).toMatchObject({
      inbox: 1,
      pending: 1,
    });

    const created = createLocalWorkstream(running, "Reliability review");
    const createdNavigation = getProductNavigation(created);

    expect(createdNavigation.counts).toMatchObject({
      inbox: 1,
      pending: 1,
    });
    expect(createdNavigation.activityItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workstreamId: created.selectedWorkstreamId,
          title: "Torsor posted a message",
          meta: "Reliability review · Now",
        }),
      ]),
    );
  });

  it("switches workstreams through the public product state", () => {
    const initial = createDemoProduct();

    const next = selectWorkstream(initial, "workstream-onboarding");

    expect(getSelectedWorkstream(next)).toMatchObject({
      id: "workstream-onboarding",
      name: "Onboarding flow",
      conversationTitle: "First-run handoff",
    });
    expect(getWorkspaceCounts(getSelectedWorkstream(next).workspace)).toEqual({
      taskCount: 1,
      reviewCount: 0,
      pendingActionCount: 0,
    });
  });

  it("shows only the selected workstream Agents in the status strip", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );

    expect(getAgentStatusItems(onboarding).map((agent) => agent.name)).toEqual([
      "Orbit",
      "Keel",
    ]);
  });

  it("derives stable Agent display metrics from workspace associations and explicit telemetry", () => {
    const product = createDemoProduct();
    const release = getSelectedWorkstream(product);
    const onboarding = getSelectedWorkstream(
      selectWorkstream(product, "workstream-onboarding"),
    );
    const releaseItems = getAgentDisplayItems(release);
    const reorderedItems = getAgentDisplayItems({
      ...release,
      agents: [...release.agents].reverse(),
    });

    expect(
      Object.fromEntries(
        releaseItems.map((item) => [item.name, item]),
      ),
    ).toEqual(
      Object.fromEntries(
        reorderedItems.map((item) => [item.name, item]),
      ),
    );
    expect(
      releaseItems.find((item) => item.name === "Orbit"),
    ).toMatchObject({
      model: "sonnet-5",
      taskCount: 0,
      runCount: 0,
      tokenCount: 12600,
      activeDurationMinutes: 22,
    });
    expect(
      getAgentDisplayItems(onboarding).map((item) => ({
        name: item.name,
        taskCount: item.taskCount,
        runCount: item.runCount,
        tokenCount: item.tokenCount,
        activeDurationMinutes: item.activeDurationMinutes,
      })),
    ).toEqual([
      {
        name: "Orbit",
        taskCount: 1,
        runCount: 1,
        tokenCount: 18600,
        activeDurationMinutes: 37,
      },
      {
        name: "Keel",
        taskCount: 0,
        runCount: 0,
        tokenCount: 6400,
        activeDurationMinutes: 12,
      },
    ]);
  });

  it("keeps activity log timestamps attached to runs when their array order changes", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const initialLogs = getWorkstreamLogItems(release, null);
    const reorderedLogs = getWorkstreamLogItems(
      {
        ...release,
        workspace: {
          ...release.workspace,
          runs: [...release.workspace.runs].reverse(),
        },
      },
      null,
    );
    const timestampsById = (items: typeof initialLogs) =>
      Object.fromEntries(items.map((item) => [item.id, item.time]));

    expect(timestampsById(initialLogs)).toMatchObject({
      "run-184": "09:31",
      "run-185": "09:43",
      "run-186": "09:44",
      "effect-publish": "09:45",
    });
    expect(timestampsById(reorderedLogs)).toEqual(
      timestampsById(initialLogs),
    );
  });

  it("describes onboarding Agent activity without release-specific claims", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );
    const activities = onboarding.agents.map(getAgentActivity);

    expect(activities[0]).toBe("Product agent · Running now");
    expect(activities.join(" ")).not.toMatch(/release|publish|package/i);
  });

  it("chooses Orbit for onboarding broadcast typing and response", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );
    const started = startAgentResponse(
      onboarding,
      "Choose the next durable step.",
      "All agents",
    );
    const responded = completeAgentResponse(
      started.workstream,
      started.pending,
    ).workstream;

    expect(started.pending).toMatchObject({
      workstreamId: "workstream-onboarding",
      target: "All agents",
      responder: { name: "Orbit" },
    });
    expect(responded.workspace.messages.at(-1)).toMatchObject({
      author: "agent",
      authorName: "Orbit",
    });
  });

  it("rejects a direct message response from an Agent in error", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const nova = release.agents.find((agent) => agent.name === "Nova")!;

    expect(() =>
      startAgentResponse(release, "Continue the stopped work.", "Nova"),
    ).toThrow(
      "Nova cannot receive messages while its status is error.",
    );
    const completion = completeAgentResponse(release, {
      workstreamId: release.id,
      target: "Nova",
      responder: nova,
    });

    expect(completion).toMatchObject({
      status: "canceled",
      reason: "Nova cannot receive messages while its status is error.",
    });
    expect(completion.workstream.workspace.messages).toEqual(
      release.workspace.messages,
    );
  });

  it("cancels a delayed response if the Agent becomes unavailable", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const started = startAgentResponse(
      release,
      "Orbit, prepare the next durable step.",
      "Orbit",
    );
    const unavailable = {
      ...started.workstream,
      agents: started.workstream.agents.map((agent) =>
        agent.id === started.pending.responder.id
          ? {
              ...agent,
              status: "stopped" as const,
              presence: "Stopped",
              activity: "Stopped by the deploying human",
            }
          : agent,
      ),
    };

    const completion = completeAgentResponse(unavailable, started.pending);

    expect(completion).toMatchObject({
      status: "canceled",
      reason: "Orbit cannot receive messages while its status is stopped.",
    });
    expect(completion.workstream.workspace.messages).toEqual(
      unavailable.workspace.messages,
    );
    expect(
      completion.workstream.agents.find(
        (agent) => agent.id === started.pending.responder.id,
      ),
    ).toMatchObject({
      status: "stopped",
      presence: "Stopped",
      activity: "Stopped by the deploying human",
    });
  });

  it("provides honest recipient availability reasons", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const sable = release.agents.find((agent) => agent.name === "Sable")!;
    const nova = release.agents.find((agent) => agent.name === "Nova")!;

    expect(getAgentMessagingUnavailableReason(sable)).toBeUndefined();
    expect(getAgentMessagingUnavailableReason(nova)).toBe(
      "Nova cannot receive messages while its status is error.",
    );
    expect(getMessageTargetUnavailableReason(release, "Nova")).toBe(
      "Nova cannot receive messages while its status is error.",
    );
    expect(
      getMessageTargetUnavailableReason(release, "All agents"),
    ).toBeUndefined();
    expect(getAgentRunUnavailableReason(release, nova.id)).toBe(
      "Nova cannot start a run while its status is error.",
    );
    expect(
      getAgentRunUnavailableReason(release, "agent-orbit-release"),
    ).toBeUndefined();
    expect(
      getAgentMessagingUnavailableReason({
        ...sable,
        name: "Quartz",
        status: "stopped",
      }),
    ).toBe("Quartz cannot receive messages while its status is stopped.");
  });

  it("renders response identity and metadata from the selected Agent data", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );
    const workstream = {
      ...onboarding,
      agents: [
        ...onboarding.agents,
        {
          id: "agent-quartz",
          name: "Quartz",
          role: "Reliability agent",
          presence: "Running now",
          status: "running" as const,
          model: "quartz-1",
          responseTokens: 275,
          responseLatency: 540,
        },
      ],
    };
    const started = startAgentResponse(
      workstream,
      "Quartz, check the reliability state.",
      "Quartz",
    );
    const responded = completeAgentResponse(
      started.workstream,
      started.pending,
    ).workstream;

    expect(responded.workspace.messages.at(-1)).toMatchObject({
      authorName: "Quartz",
      role: "Reliability agent",
      agentMeta: {
        model: "quartz-1",
        tokens: 275,
        latency: 540,
      },
    });
  });

  it("renders the release plan from its own artifact content", () => {
    const artifact = createDemoWorkspace().messages.find(
      (message) => message.id === "message-nova-plan",
    )?.artifact;

    expect(artifact && getArtifactCardContent(artifact)).toEqual({
      badge: "PLAN",
      label: "Proposed plan",
      title: "Validate → draft → submit for review",
      detail: "No external write is authorized in this run.",
    });
  });

  it("renders the release output from its own artifact content", () => {
    const artifact = createDemoWorkspace().messages.find(
      (message) => message.id === "message-sable-resume",
    )?.artifact;

    expect(artifact && getArtifactCardContent(artifact)).toEqual({
      badge: "OUTPUT",
      label: "Evidence bundle",
      title: "release-update.md + package-check.txt",
      detail: "2 files · deterministic sample · ready for human review",
    });
  });

  it("renders the onboarding outline without release artifact content", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );
    const artifact = onboarding.workspace.messages.find(
      (message) => message.id === "message-orbit-plan",
    )?.artifact;
    const content = artifact && getArtifactCardContent(artifact);

    expect(content).toEqual({
      badge: "PLAN",
      label: "Workspace outline",
      title: "Start here → create work → review result",
      detail: "Three guided moments · local prototype content",
    });
    expect(JSON.stringify(content)).not.toMatch(
      /release-update|package-check|publish-receipt/i,
    );
  });

  it("selects context-appropriate sample artifacts and sends the exact selected object", () => {
    const product = createDemoProduct();
    const release = getSelectedWorkstream(product);
    const onboarding = getSelectedWorkstream(
      selectWorkstream(product, "workstream-onboarding"),
    );
    const createdProduct = createLocalWorkstream(product, "Reliability review");
    const created = getSelectedWorkstream(createdProduct);
    const releaseArtifact = getSampleMessageArtifact(release);
    const onboardingArtifact = getSampleMessageArtifact(onboarding);
    const createdArtifact = getSampleMessageArtifact(created);

    expect(releaseArtifact).toEqual({
      kind: "output",
      label: "Attached package observation",
      title: "package-observation.txt",
      detail: "Synthetic package evidence for Release 0.8.",
    });
    expect(onboardingArtifact).toEqual({
      kind: "output",
      label: "Attached workspace observation",
      title: "starter-workspace-observation.txt",
      detail: "Synthetic onboarding evidence for Onboarding flow.",
    });
    expect(createdArtifact).toEqual({
      kind: "output",
      label: "Attached workstream observation",
      title: "workstream-observation.txt",
      detail: "Synthetic local evidence for Reliability review.",
    });
    expect(JSON.stringify([onboardingArtifact, createdArtifact])).not.toMatch(
      /release|package/i,
    );

    const sent = startAgentResponse(
      onboarding,
      "Use this observation in the starter workspace.",
      "Orbit",
      onboardingArtifact,
    ).workstream.workspace;

    expect(sent.messages.at(-1)?.artifact).toBe(onboardingArtifact);
  });

  it("renders a human attachment only from the attached artifact data", () => {
    const onboarding = getSelectedWorkstream(
      selectWorkstream(createDemoProduct(), "workstream-onboarding"),
    );
    const selectedArtifact = getSampleMessageArtifact(onboarding);
    const sent = startAgentResponse(
      onboarding,
      "Use this local observation in the starter workspace.",
      "Orbit",
      selectedArtifact,
    ).workstream.workspace;
    const artifact = sent.messages.at(-1)?.artifact;
    const content = artifact && getArtifactCardContent(artifact);

    expect(content).toEqual({
      badge: "OUTPUT",
      label: "Attached workspace observation",
      title: "starter-workspace-observation.txt",
      detail: "Synthetic onboarding evidence for Onboarding flow.",
    });
    expect(artifact).toBe(selectedArtifact);
    expect(JSON.stringify(content)).not.toMatch(
      /release|package|publish/i,
    );
  });

  it("clears composer transients only when the conversation context changes", () => {
    const attachedArtifact = getSampleMessageArtifact(
      getSelectedWorkstream(
        selectWorkstream(createDemoProduct(), "workstream-onboarding"),
      ),
    );
    const draft = {
      composer: "Keep this draft in the current conversation.",
      attachedArtifact,
      agentCommand: true,
      target: "Sable",
      editingMessageId: "message-human-brief",
    };
    const releaseSable = {
      workstreamId: "workstream-release",
      selectedAgent: "Sable",
    };

    expect(
      getComposerStateAfterConversationChange(
        draft,
        releaseSable,
        releaseSable,
      ),
    ).toEqual(draft);
    expect(
      getComposerStateAfterConversationChange(draft, releaseSable, {
        workstreamId: "workstream-release",
        selectedAgent: "Keel",
      }),
    ).toEqual({
      composer: "",
      attachedArtifact: null,
      agentCommand: false,
      target: "Keel",
      editingMessageId: null,
    });
    expect(
      getComposerStateAfterConversationChange(draft, releaseSable, {
        workstreamId: "workstream-onboarding",
        selectedAgent: null,
      }),
    ).toEqual({
      composer: "",
      attachedArtifact: null,
      agentCommand: false,
      target: "All agents",
      editingMessageId: null,
    });
  });

  it("delivers a delayed agent response to the originating workstream", () => {
    const initial = createDemoProduct();
    const releaseWorkstream = getSelectedWorkstream(initial);
    const started = startAgentResponse(
      releaseWorkstream,
      "Check the release receipt.",
      "Sable",
    );
    const sent = updateWorkstreamById(
      initial,
      "workstream-release",
      () => started.workstream,
    );
    const switched = selectWorkstream(sent, "workstream-onboarding");
    const responded = updateWorkstreamById(
      switched,
      "workstream-release",
      (workstream) =>
        completeAgentResponse(workstream, started.pending).workstream,
    );

    const release = responded.workstreams.find(
      (workstream) => workstream.id === "workstream-release",
    );
    const onboarding = getSelectedWorkstream(responded);

    expect(release?.workspace.messages.at(-1)).toMatchObject({
      author: "agent",
      authorName: "Sable",
    });
    expect(onboarding.id).toBe("workstream-onboarding");
    expect(onboarding.workspace.messages.at(-1)?.author).toBe("human");
  });

  it("searches workstreams, messages, and tasks as local product data", () => {
    const product = createDemoProduct();

    expect(searchProduct(product, "rollback")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "message",
          workstreamId: "workstream-release",
          title: "Jie Chen",
        }),
      ]),
    );
    expect(searchProduct(product, "configure")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task",
          workstreamId: "workstream-onboarding",
          title: "Configure the starter workspace",
        }),
      ]),
    );
  });

  it("navigates a targeted human message search result to that Agent DM", () => {
    const product = updateWorkstreamById(
      createDemoProduct(),
      "workstream-release",
      (workstream) =>
        startAgentResponse(
          workstream,
          "Sable, inspect this uniquely targeted navigation result.",
          "Sable",
        ).workstream,
    );
    const result = searchProduct(product, "uniquely targeted navigation").find(
      (item) => item.kind === "message",
    )!;

    expect(getSearchDestination(product, result)).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: "Sable",
      view: "conversation",
      target: { type: "message", id: result.id },
    });
  });

  it("navigates a broadcast or general message result to the shared conversation", () => {
    const product = createDemoProduct();
    const broadcastProduct = updateWorkstreamById(
      product,
      "workstream-release",
      (workstream) =>
        startAgentResponse(
          workstream,
          "Broadcast this uniquely shared navigation result.",
          "All agents",
        ).workstream,
    );
    const generalResult = searchProduct(product, "publish step separate").find(
      (item) => item.kind === "message",
    )!;
    const broadcastResult = searchProduct(
      broadcastProduct,
      "uniquely shared navigation",
    ).find((item) => item.kind === "message")!;

    expect(getSearchDestination(product, generalResult)).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: null,
      view: "conversation",
      target: { type: "message", id: "message-human-brief" },
    });
    expect(getSearchDestination(broadcastProduct, broadcastResult)).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: null,
      view: "conversation",
      target: { type: "message", id: broadcastResult.id },
    });
  });

  it("navigates an Agent-authored message result to the author conversation", () => {
    const product = createDemoProduct();
    const result = searchProduct(product, "resumed from the task record").find(
      (item) => item.kind === "message",
    )!;

    expect(getSearchDestination(product, result)).toEqual({
      workstreamId: "workstream-release",
      selectedAgent: "Sable",
      view: "conversation",
      target: { type: "message", id: "message-sable-resume" },
    });
  });

  it("navigates a task search result to the expanded task control view", () => {
    const product = createDemoProduct();
    const result = searchProduct(product, "configure the starter").find(
      (item) => item.kind === "task",
    )!;

    expect(getSearchDestination(product, result)).toEqual({
      workstreamId: "workstream-onboarding",
      selectedAgent: null,
      view: "tasks",
      target: { type: "task", id: "task-configure-starter" },
    });
  });

  it("navigates a workstream search result to its shared conversation", () => {
    const product = createDemoProduct();
    const result = searchProduct(product, "guided, durable workspace").find(
      (item) => item.kind === "workstream",
    )!;

    expect(getSearchDestination(product, result)).toEqual({
      workstreamId: "workstream-onboarding",
      selectedAgent: null,
      view: "conversation",
      target: { type: "workstream", id: "workstream-onboarding" },
    });
  });

  it("sends a human message and appends a deterministic targeted agent response", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const started = startAgentResponse(
      release,
      "Check whether the rollback note needs an owner.",
      "Sable",
    );
    const sent = started.workstream.workspace;
    const responded = completeAgentResponse(
      started.workstream,
      started.pending,
    ).workstream.workspace;

    expect(sent.messages.at(-1)).toMatchObject({
      author: "human",
      body: "Check whether the rollback note needs an owner.",
    });
    expect(responded.messages.at(-1)).toMatchObject({
      author: "agent",
      authorName: "Sable",
      role: "Replacement agent",
      agentMeta: {
        model: "sonnet-5",
        tokens: 468,
        latency: 720,
      },
    });
    expect(responded.messages.at(-1)?.body).toContain("durable state");
  });

  it("runs a valid targeted response through coherent Agent lifecycle state", () => {
    const release = getSelectedWorkstream(createDemoProduct());

    const started = startAgentResponse(
      release,
      "Orbit, prepare the next durable step.",
      "Orbit",
    );

    expect(started.workstream.workspace.messages.at(-1)).toMatchObject({
      author: "human",
      recipient: "Orbit",
    });
    expect(
      started.workstream.agents.find(
        (agent) => agent.id === "agent-orbit-release",
      ),
    ).toMatchObject({
      status: "running",
      presence: "Responding now",
      activity: "Responding to a direct message",
    });

    const completed = completeAgentResponse(
      started.workstream,
      started.pending,
    ).workstream;

    expect(completed.workspace.messages.at(-1)).toMatchObject({
      author: "agent",
      authorName: "Orbit",
    });
    expect(
      completed.agents.find((agent) => agent.id === "agent-orbit-release"),
    ).toMatchObject({
      status: "idle",
      presence: "Idle",
      activity: undefined,
    });
  });

  it("scopes human messages across shared and agent conversations", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const workspace = release.workspace;
    const general = workspace.messages.find(
      (item) => item.id === "message-human-brief",
    )!;
    const broadcast = startAgentResponse(
      release,
      "All agents, keep the review state explicit.",
      "All agents",
    ).workstream.workspace.messages.at(-1)!;
    const sable = startAgentResponse(
      release,
      "Sable, check the release evidence.",
      "Sable",
    ).workstream.workspace.messages.at(-1)!;
    const keel = startAgentResponse(
      release,
      "Keel, verify the review gate.",
      "Keel",
    ).workstream.workspace.messages.at(-1)!;

    expect(
      [general, broadcast, sable, keel].map((message) => ({
        shared: isMessageVisibleInAgentConversation(message, null),
        sable: isMessageVisibleInAgentConversation(message, "Sable"),
        keel: isMessageVisibleInAgentConversation(message, "Keel"),
      })),
    ).toEqual([
      { shared: true, sable: true, keel: true },
      { shared: true, sable: true, keel: true },
      { shared: false, sable: true, keel: false },
      { shared: false, sable: false, keel: true },
    ]);
  });

  it("shows agent messages in shared context and only the matching agent DM", () => {
    const release = getSelectedWorkstream(createDemoProduct());
    const started = startAgentResponse(
      release,
      "Sable, continue from durable state.",
      "Sable",
    );
    const message = completeAgentResponse(
      started.workstream,
      started.pending,
    ).workstream.workspace.messages.at(-1)!;

    expect(isMessageVisibleInAgentConversation(message, null)).toBe(true);
    expect(isMessageVisibleInAgentConversation(message, "Sable")).toBe(true);
    expect(isMessageVisibleInAgentConversation(message, "Keel")).toBe(false);
  });

  it("toggles each reaction independently without losing other counts", () => {
    const initial = createDemoWorkspace();

    const liked = toggleMessageReaction(
      initial,
      "message-sable-resume",
      "👍",
    );
    const celebrated = toggleMessageReaction(
      liked,
      "message-sable-resume",
      "💯",
    );
    const unliked = toggleMessageReaction(
      celebrated,
      "message-sable-resume",
      "👍",
    );

    expect(
      liked.messages.find((message) => message.id === "message-sable-resume")
        ?.reactions,
    ).toEqual([
      { emoji: "👍", count: 3, reactedByHuman: true },
      { emoji: "💯", count: 1, reactedByHuman: false },
    ]);
    expect(
      celebrated.messages.find(
        (message) => message.id === "message-sable-resume",
      )?.reactions,
    ).toEqual([
      { emoji: "👍", count: 3, reactedByHuman: true },
      { emoji: "💯", count: 2, reactedByHuman: true },
    ]);
    expect(
      unliked.messages.find(
        (message) => message.id === "message-sable-resume",
      )?.reactions,
    ).toEqual([
      { emoji: "👍", count: 2, reactedByHuman: false },
      { emoji: "💯", count: 2, reactedByHuman: true },
    ]);
  });

  it("appends a visible thread reply and updates the reply count", () => {
    const initial = createDemoWorkspace();

    const next = appendThreadReply(
      initial,
      "message-sable-resume",
      "The package check is clear. Keep publish reconciliation separate.",
    );
    const message = next.messages.find(
      (item) => item.id === "message-sable-resume",
    );

    expect(message?.threadCount).toBe(5);
    expect(message?.threadReplies?.at(-1)).toMatchObject({
      authorName: "Jie Chen",
      body: "The package check is clear. Keep publish reconciliation separate.",
      time: "Now",
    });
  });

  it("summarizes reply authors and the latest reply time for the message row", () => {
    const message = createDemoWorkspace().messages.find(
      (item) => item.id === "message-sable-resume",
    );

    expect(message && getMessageReplySummary(message)).toEqual({
      count: 4,
      lastReplyTime: "09:43",
      authors: [
        { name: "Jie Chen", initials: "JC" },
        { name: "Sable", initials: "S" },
      ],
    });
  });

  it("uses the deploying human identity across public conversation behavior", () => {
    const product = createDemoProduct();
    const releaseWorkstream = getSelectedWorkstream(product);
    const release = releaseWorkstream.workspace;
    const onboarding = selectWorkstream(product, "workstream-onboarding");
    const sent = startAgentResponse(
      releaseWorkstream,
      "Keep the review explicit.",
      "Sable",
    ).workstream.workspace;

    expect(
      release.messages
        .filter((message) => message.author === "human")
        .map((message) => message.authorName),
    ).toEqual(["Jie Chen", "Jie Chen"]);
    expect(
      getSelectedWorkstream(onboarding).workspace.messages
        .filter((message) => message.author === "human")
        .map((message) => message.authorName),
    ).toEqual(["Jie Chen", "Jie Chen"]);
    expect(sent.messages.at(-1)?.authorName).toBe("Jie Chen");
  });

  it("creates public clipboard summaries and a synthetic local snapshot", () => {
    const product = createDemoProduct();
    const release = getSelectedWorkstream(product);

    expect(getAuthoritySummary(release)).toContain(
      "Deploying human: Jie Chen",
    );
    expect(getConversationContextSummary(release)).toContain(
      "Workstream: Release 0.8",
    );
    expect(PUBLIC_SNAPSHOT_FILENAME).toBe(
      "torsor-public-prototype-snapshot.json",
    );

    const snapshot = JSON.parse(getPublicPrototypeSnapshot(product));

    expect(snapshot).toEqual({
      schemaVersion: 1,
      product,
    });
    expect(getPublicPrototypeSnapshot(product)).not.toMatch(
      /[A-Z]:\\|\/Users\/|\/home\/|worktrees/i,
    );
  });

  it("exposes all four operational states in the selected agent control", () => {
    const product = createDemoProduct();
    const statuses = getSelectedWorkstream(product).agents.map(
      (agent) => agent.status,
    );

    expect(new Set(statuses)).toEqual(
      new Set(["running", "idle", "queued", "error"]),
    );
  });
});
