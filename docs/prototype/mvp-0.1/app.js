const threads = {
  mvp: {
    id: "mvp",
    channel: "torsor-core",
    project: "torsor",
    title: "Build Torsor MVP 0.1 prototype",
    time: "22:41",
    status: "running",
    updated: "now",
    root: '<span class="mention">@Sable</span> turn the current kernel conclusions into an interactive prototype. Keep the Channel Message and Thread Replies visible while I inspect the Agent work.',
    replies: [
      {
        type: "agent",
        agent: "Sable",
        tone: "sable",
        runId: "R184",
        time: "22:42",
        body: "I created an implementation Run in Worktree generation 04. The conversation remains the public coordination surface.",
        run: { id: "R184", label: "Build desktop collaboration workbench", state: "running" }
      },
      {
        type: "human",
        agent: "Alex",
        tone: "human",
        time: "22:44",
        body: "Keep the Root Message and Replies beside the workbench. I do not want to navigate backward just to recover context.",
        note: "Message + RunInput #10"
      },
      {
        type: "agent",
        agent: "Sable",
        tone: "sable",
        runId: "R184",
        time: "22:47",
        body: '<span class="mention">@Keel</span> independently review whether the panel model preserves the Torsor charter.',
        run: { id: "R185", label: "Independent interaction review", state: "review" }
      },
      {
        type: "agent",
        agent: "Keel",
        tone: "keel",
        runId: "R185",
        time: "22:51",
        body: "The layout is coherent when Conversation stays visible and each Worktree remains a separate branch in the Thread tree.",
        note: "review-notes.txt · Artifact X185"
      }
    ],
    workspaces: [
      {
        id: "W184",
        label: "prototype-mvp-0.1",
        generation: "generation 04",
        branch: "torsor/mvp-panel-workbench",
        state: "running",
        run: {
          id: "R184",
          agent: "Sable",
          tone: "sable",
          title: "Build desktop collaboration workbench",
          status: "Active",
          elapsed: "06:18",
          inputs: 10,
          stream: `I kept the conversation visible instead of turning it into a breadcrumb.

The desktop surface now has three simultaneous contexts:

1. Root Message and Thread Replies
2. Project / Worktree / Agent resource tree
3. Split panels for Agent, Files and Terminal

Panel layout remains Client state. Run, Worktree and TerminalSession remain the durable facts.`
        },
        terminals: [{ id: "T184-1", label: "pwsh · 1", status: "Human control" }],
        files: ["src/workbench.ts", "src/panels.css", "README.md"],
        artifacts: ["desktop-layout.png", "prototype-mvp-0.1"]
      },
      {
        id: "W185",
        label: "interaction-review",
        generation: "generation 01",
        branch: "review/R185",
        state: "review",
        run: {
          id: "R185",
          agent: "Keel",
          tone: "keel",
          title: "Review context-preserving layout",
          status: "Reviewing",
          elapsed: "03:09",
          inputs: 3,
          stream: `Review focus:

- Conversation remains visible at maximum depth.
- Worktree branches do not imply shared Writer Authority.
- File and Terminal tabs keep their Worktree provenance.
- Split panes are Client projection, not durable domain objects.

No kernel expansion is required.`
        },
        terminals: [{ id: "T185-1", label: "pwsh · review", status: "Observer" }],
        files: ["review/notes.md", "review/layout-checklist.md"],
        artifacts: ["review-notes.txt"]
      }
    ]
  },
  readonly: {
    id: "readonly",
    channel: "agent-research",
    project: "torsor",
    title: "Investigate cache misses without changing code",
    time: "09:18",
    status: "done",
    updated: "2h",
    root: '<span class="mention">@Sable</span> investigate why the cache rate dropped. Read-only: do not modify code.',
    replies: [
      { type: "agent", agent: "Sable", tone: "sable", runId: "R190", time: "09:19", body: "Created a read-only Run. Write capabilities are absent from its scope.", run: { id: "R190", label: "Cache miss investigation", state: "completed" } },
      { type: "agent", agent: "Sable", tone: "sable", runId: "R190", time: "09:31", body: "The regression comes from prompt component churn. No files were modified.", note: "cache-analysis.md · Artifact X190" },
      { type: "system", state: "success", body: "R190 completed · 2 RunInputs incorporated · zero write operations" }
    ],
    workspaces: [
      {
        id: "W190",
        label: "cache-investigation",
        generation: "read-only snapshot",
        branch: "main@8f24c1",
        state: "completed",
        run: { id: "R190", agent: "Sable", tone: "sable", title: "Cache miss investigation", status: "Completed", elapsed: "12:44", inputs: 2, stream: "Read-only analysis completed. Prompt component churn explains the regression. No Worktree writes occurred." },
        terminals: [],
        files: ["reports/cache-analysis.md", "telemetry/query.kql"],
        artifacts: ["cache-analysis.md"]
      }
    ]
  },
  conflict: {
    id: "conflict",
    channel: "torsor-core",
    project: "torsor",
    title: "Resolve competing changes to RunInput.ts",
    time: "14:03",
    status: "blocked",
    updated: "36m",
    root: '<span class="mention">@Nova</span> and <span class="mention">@Sable</span> explore the RunInput model independently. Keep both approaches.',
    replies: [
      { type: "agent", agent: "Nova", tone: "nova", runId: "R201", time: "14:04", body: "I am implementing an event-oriented model from base a4f20c.", run: { id: "R201", label: "Event-oriented model", state: "running" } },
      { type: "agent", agent: "Sable", tone: "sable", runId: "R202", time: "14:04", body: "I am implementing a state-oriented model from the same base in a separate Worktree.", run: { id: "R202", label: "State-oriented model", state: "running" } },
      { type: "system", state: "blocked", body: "Integration detected overlapping edits in RunInput.ts. Both Artifacts remain immutable." },
      { type: "agent", agent: "Sable", tone: "sable", runId: "R203", time: "14:28", body: "I created a coordination Run rather than choosing silently.", run: { id: "R203", label: "Reconcile X201 and X202", state: "review" } }
    ],
    workspaces: [
      {
        id: "W201", label: "runinput-events", generation: "generation 01", branch: "model/events", state: "running",
        run: { id: "R201", agent: "Nova", tone: "nova", title: "Event-oriented RunInput", status: "Completed", elapsed: "18:31", inputs: 4, stream: "Produced immutable Artifact X201 from base a4f20c." },
        terminals: [{ id: "T201-1", label: "pwsh · events", status: "Idle" }],
        files: ["src/RunInput.ts", "src/RunInputEvent.ts"],
        artifacts: ["X201.patch"]
      },
      {
        id: "W202", label: "runinput-state", generation: "generation 01", branch: "model/state", state: "running",
        run: { id: "R202", agent: "Sable", tone: "sable", title: "State-oriented RunInput", status: "Completed", elapsed: "17:52", inputs: 4, stream: "Produced immutable Artifact X202 from base a4f20c." },
        terminals: [{ id: "T202-1", label: "pwsh · state", status: "Idle" }],
        files: ["src/RunInput.ts", "src/Disposition.ts"],
        artifacts: ["X202.patch"]
      },
      {
        id: "W203", label: "runinput-coordination", generation: "generation 01", branch: "model/reconcile", state: "review",
        run: { id: "R203", agent: "Sable", tone: "sable", title: "Reconcile competing Artifacts", status: "Active", elapsed: "05:11", inputs: 2, stream: "Comparing X201 and X202. The combined model will preserve immutable assignment facts and separate Provider delivery attempts." },
        terminals: [],
        files: ["src/RunInput.ts", "notes/reconciliation.md"],
        artifacts: ["X203-draft.patch"]
      }
    ]
  },
  recovery: {
    id: "recovery",
    channel: "release",
    project: "torsor",
    title: "Recover the failed release-note Run",
    time: "16:02",
    status: "blocked",
    updated: "1h",
    root: '<span class="mention">@Nova</span> prepare release notes from the current branch and attach the result here.',
    replies: [
      { type: "agent", agent: "Nova", tone: "nova", runId: "R210", time: "16:03", body: "The Provider request timed out before the first durable result.", run: { id: "R210", label: "Original release-note attempt", state: "blocked" } },
      { type: "system", state: "blocked", body: "Pending RunInputs were marked Abandoned(run_failed), not deleted." },
      { type: "agent", agent: "Sable", tone: "sable", runId: "R211", time: "16:08", body: "I created replacement R211 and reassigned both inputs.", run: { id: "R211", label: "Replacement release-note Run", state: "completed" } },
      { type: "system", state: "success", body: "Late Provider output was preserved without changing Run state." }
    ],
    workspaces: [
      {
        id: "W210", label: "release-notes-failed", generation: "generation 01", branch: "release/notes", state: "blocked",
        run: { id: "R210", agent: "Nova", tone: "nova", title: "Generate release notes", status: "Failed", elapsed: "02:10", inputs: 2, stream: "Provider timeout. Inputs preserved for explicit reassignment." },
        terminals: [], files: ["logs/provider-attempt.log"], artifacts: ["late-output.txt"]
      },
      {
        id: "W211", label: "release-notes-replacement", generation: "generation 01", branch: "release/notes-retry", state: "completed",
        run: { id: "R211", agent: "Sable", tone: "sable", title: "Replacement release-note Run", status: "Completed", elapsed: "08:26", inputs: 2, stream: "Replacement completed successfully without depending on the failed Provider session." },
        terminals: [{ id: "T211-1", label: "pwsh · verify", status: "Exited" }], files: ["release-notes.md"], artifacts: ["release-notes.md"]
      }
    ]
  },
  delegation: {
    id: "delegation",
    channel: "agent-ops",
    project: "torsor",
    title: "Investigate recursive Agent delegation",
    time: "18:20",
    status: "review",
    updated: "44m",
    root: '<span class="mention">@Sable</span> investigate why the validation pipeline keeps delegating the same check.',
    replies: [
      { type: "agent", agent: "Sable", tone: "sable", runId: "R220", time: "18:21", body: '<span class="mention">@Keel</span> independently verify the validation rule.', run: { id: "R220", label: "Root investigation", state: "running" } },
      { type: "agent", agent: "Keel", tone: "keel", runId: "R221", time: "18:22", body: '<span class="mention">@Nova</span> reproduce it with a clean configuration.', run: { id: "R221", label: "Independent validation", state: "review" } },
      { type: "system", state: "blocked", body: "New delegation blocked at depth 4. Causal root has 7 of 50 non-terminal Runs." }
    ],
    workspaces: [
      {
        id: "W220", label: "delegation-root", generation: "generation 03", branch: "diagnose/delegation", state: "running",
        run: { id: "R220", agent: "Sable", tone: "sable", title: "Root delegation investigation", status: "Active", elapsed: "14:02", inputs: 5, stream: "The loop guard prevented a duplicate delegation. Existing evidence is sufficient." },
        terminals: [{ id: "T220-1", label: "pwsh · trace", status: "Observer" }], files: ["logs/delegation-trace.json"], artifacts: ["delegation-analysis.md"]
      },
      {
        id: "W221", label: "delegation-review", generation: "generation 01", branch: "review/delegation", state: "review",
        run: { id: "R221", agent: "Keel", tone: "keel", title: "Validate delegation guard", status: "Reviewing", elapsed: "07:44", inputs: 2, stream: "Depth and causal-root limits are both enforced. No work was silently discarded." },
        terminals: [], files: ["review/guard-check.md"], artifacts: ["guard-verification.txt"]
      }
    ]
  }
};

const threadOrder = ["mvp", "conflict", "recovery", "delegation", "readonly"];

const activities = [
  { id: "a1", group: "needs", threadId: "conflict", runId: "R203", agent: "Sable", tone: "sable", title: "Integration conflict needs a decision", detail: "R201 and R202 changed RunInput.ts from the same base.", time: "3m", path: ["torsor", "#torsor-core", "Resolve competing changes"] },
  { id: "a2", group: "needs", threadId: "recovery", runId: "R210", agent: "Nova", tone: "nova", title: "Failed Run preserved two inputs", detail: "Replacement R211 completed; inspect the late Provider output before archiving.", time: "18m", path: ["torsor", "#release", "Recover failed Run"] },
  { id: "a3", group: "needs", threadId: "delegation", runId: "R220", agent: "Sable", tone: "sable", title: "Delegation limit blocked another Run", detail: "Depth 4 was reached. Existing work continues.", time: "31m", path: ["torsor", "#agent-ops", "Recursive delegation"] },
  { id: "a4", group: "running", threadId: "mvp", runId: "R184", agent: "Sable", tone: "sable", title: "Building desktop collaboration workbench", detail: "Streaming output and file changes are available.", time: "now", path: ["torsor", "#torsor-core", "MVP prototype"] },
  { id: "a5", group: "running", threadId: "mvp", runId: "R185", agent: "Keel", tone: "keel", title: "Reviewing context-preserving layout", detail: "Separate Worktree, no shared Writer Authority.", time: "2m", path: ["torsor", "#torsor-core", "MVP prototype"] },
  { id: "a6", group: "running", threadId: "delegation", runId: "R221", agent: "Keel", tone: "keel", title: "Validating the delegation guard", detail: "Reviewing depth and causal-root protections.", time: "7m", path: ["torsor", "#agent-ops", "Recursive delegation"] },
  { id: "a7", group: "done", threadId: "readonly", runId: "R190", agent: "Sable", tone: "sable", title: "Cache miss investigation completed", detail: "Read-only report published; zero file writes.", time: "2h", path: ["torsor", "#agent-research", "Cache misses"] },
  { id: "a8", group: "done", threadId: "recovery", runId: "R211", agent: "Sable", tone: "sable", title: "Replacement release-note Run completed", detail: "Artifact release-notes.md is ready.", time: "1h", path: ["torsor", "#release", "Recover failed Run"] }
];

const fileSamples = {
  "src/workbench.ts": [
    '<span class="syntax-keyword">export</span> <span class="syntax-keyword">function</span> <span class="syntax-attr">renderThreadWorkbench</span>(thread: Thread) {',
    '  <span class="syntax-keyword">return</span> {',
    '    conversation: <span class="syntax-string">projectConversation(thread)</span>,',
    '    workspaceTree: <span class="syntax-string">projectWorktrees(thread.runs)</span>,',
    '    canvas: <span class="syntax-string">restoreClientLayout(thread.id)</span>,',
    '  };',
    '}',
    "",
    '<span class="syntax-comment">// Panels are Client state. Run and Worktree remain durable facts.</span>'
  ],
  "src/panels.css": [
    '<span class="syntax-attr">.workbench-layout</span> {',
    '  <span class="syntax-keyword">display</span>: grid;',
    '  <span class="syntax-keyword">grid-template-columns</span>:',
    '    var(--conversation-width)',
    '    var(--tree-width)',
    '    minmax(0, 1fr);',
    '}',
    "",
    '<span class="syntax-attr">.editor-grid.vertical</span> {',
    '  <span class="syntax-keyword">grid-template-columns</span>: 1fr 1fr;',
    '}'
  ],
  "README.md": [
    '<span class="syntax-comment"># Torsor desktop workbench</span>',
    "",
    'Conversation remains visible beside Agent work.',
    'Thread resources are grouped by Project and Worktree.',
    'Tabs can be split right or split down.',
    'Activity aggregates work across many Threads.'
  ],
  "review/notes.md": [
    '<span class="syntax-comment"># Interaction review</span>',
    "",
    '- Conversation context remains visible.',
    '- Worktree branches preserve isolation.',
    '- Split panes do not duplicate Writer Authority.',
    '- Activity links back to the source Thread.'
  ],
  "review/layout-checklist.md": [
    '<span class="syntax-comment"># Layout checklist</span>',
    "",
    '- [x] Root Message visible',
    '- [x] Thread Replies visible',
    '- [x] Worktree provenance visible',
    '- [x] Agent and Terminal tabs can coexist'
  ],
  "src/RunInput.ts": [
    '<span class="syntax-keyword">export interface</span> <span class="syntax-attr">RunInput</span> {',
    '  id: <span class="syntax-keyword">string</span>;',
    '  runId: <span class="syntax-keyword">string</span>;',
    '  messageRevisionId: <span class="syntax-keyword">string</span>;',
    '  disposition: <span class="syntax-string">"pending" | "accepted" | "handled"</span>;',
    '}'
  ],
  "src/RunInputEvent.ts": [
    '<span class="syntax-keyword">export type</span> <span class="syntax-attr">RunInputEvent</span> =',
    '  | { type: <span class="syntax-string">"assigned"</span>; inputId: string }',
    '  | { type: <span class="syntax-string">"handled"</span>; inputId: string };'
  ],
  "src/Disposition.ts": [
    '<span class="syntax-keyword">export type</span> <span class="syntax-attr">Disposition</span> =',
    '  <span class="syntax-string">"pending"</span> | <span class="syntax-string">"incorporated"</span> | <span class="syntax-string">"abandoned"</span>;'
  ],
  "notes/reconciliation.md": [
    '<span class="syntax-comment"># Reconciliation</span>',
    "",
    'Keep assignment facts immutable.',
    'Model Provider delivery as separate attempts.',
    'Publish a new integration Artifact instead of rewriting X201 or X202.'
  ],
  "reports/cache-analysis.md": [
    '<span class="syntax-comment"># Cache analysis</span>',
    "",
    'The miss pattern follows prompt component churn.',
    'No source files were modified during this investigation.'
  ],
  "telemetry/query.kql": [
    '<span class="syntax-attr">conversation_round</span>',
    '| where cache_hit == false',
    '| summarize count() by first_divergence_component'
  ],
  "logs/provider-attempt.log": [
    '16:03:01 provider request started',
    '16:05:11 timeout',
    '16:05:11 Run R210 failed',
    '16:17:02 late output preserved'
  ],
  "release-notes.md": [
    '<span class="syntax-comment"># Release notes</span>',
    "",
    '- Preserved pending inputs after Provider failure.',
    '- Replacement Run completed from durable facts.'
  ],
  "logs/delegation-trace.json": [
    '{',
    '  <span class="syntax-string">"causalRoot"</span>: <span class="syntax-string">"C44"</span>,',
    '  <span class="syntax-string">"depth"</span>: 4,',
    '  <span class="syntax-string">"nonTerminalRuns"</span>: 7,',
    '  <span class="syntax-string">"limit"</span>: 50',
    '}'
  ],
  "review/guard-check.md": [
    '<span class="syntax-comment"># Delegation guard</span>',
    "",
    'Depth limit: enforced',
    'Causal-root limit: enforced',
    'Silent discard: none'
  ]
};

const runTimelines = {
  R184: [
    { id: "R184-input-01", type: "input", author: "Alex", text: "Turn the kernel conclusions into an interactive prototype. Keep the public conversation visible while I inspect the work.", status: "Incorporated", source: "Root Message · RunInput #01" },
    { id: "R184-message-01", type: "assistant", text: "I will preserve the Thread as the collaboration source, then project each Run into an inspectable work surface." },
    { id: "R184-search", type: "tool", tool: "Search", title: "Find current panel and Run rendering", state: "completed", meta: "12 matches · 84 ms", details: [
      ["Query", "renderAgentTab|renderConversation|workbench-layout"],
      ["Scope", "docs/prototype/mvp-0.1"],
      ["Result", "Located the static Run dashboard, panel toggles, and split canvas."]
    ] },
    { id: "R184-read", type: "tool", tool: "Read", title: "Inspect Torsor core UX sections", state: "completed", meta: "sections 35–44", details: [
      ["Files", "Torsor-core.zh-cn.md"],
      ["Read", "Run Workbench, Send-to-Run, Streaming, Split Panes, platform boundary"],
      ["Decision", "Keep layout state in the Client; preserve Thread and Run provenance."]
    ] },
    { id: "R184-message-02", type: "assistant", text: "The Run surface should be a typed engineering timeline, not a status dashboard. Tool activity stays compact until the Human asks for detail." },
    { id: "R184-edit", type: "tool", tool: "Edit", title: "Refactor Agent Run workbench", state: "running", meta: "2 files · +214 −96", details: [
      ["Files", "app.js, styles.css"],
      ["Change", "Add typed timeline, expandable tool calls, fixed Run composer, focus presets, and readable density."],
      ["Writer", "Sable · R184 · Worktree generation 04"],
      ["Authority", "fencing token 42 · active"]
    ] },
    { id: "R184-change", type: "change", title: "Working tree changed", text: "app.js +132 −38 · styles.css +82 −58", status: "Uncommitted" },
    { id: "R184-shell", type: "tool", tool: "Shell", title: "Validate prototype JavaScript", state: "completed", meta: "exit 0 · 213 ms", details: [
      ["Command", "node --check app.js"],
      ["cwd", "prototype-mvp-0.1"],
      ["Output", "No syntax errors."]
    ] },
    { id: "R184-stream", type: "assistant", text: "I am tightening the layout now. Channels and the Thread can collapse independently, while every focused Run still shows where its work came from.", streaming: true }
  ],
  R185: [
    { id: "R185-input-01", type: "input", author: "Sable", text: "Independently review whether the panel model preserves the Torsor charter.", status: "Incorporated", source: "Agent Mention · RunInput #01" },
    { id: "R185-message-01", type: "assistant", text: "I am reviewing from a separate read-only Worktree so the implementation and review cannot share Writer Authority." },
    { id: "R185-read", type: "tool", tool: "Read", title: "Compare context and focus modes", state: "completed", meta: "4 surfaces reviewed", details: [
      ["Checked", "Conversation source, Worktree provenance, split panes, collapsed context"],
      ["Result", "Focus mode is safe when the Run header retains its source Thread and context can be restored in one action."]
    ] },
    { id: "R185-artifact", type: "artifact", title: "Review artifact published", text: "review-notes.txt · immutable · X185", status: "Published" },
    { id: "R185-message-02", type: "assistant", text: "No new kernel object is required. Panel position, split direction, and collapse state remain Client projections." }
  ],
  R190: [
    { id: "R190-input", type: "input", author: "Alex", text: "Investigate why the cache rate dropped. Read-only: do not modify code.", status: "Incorporated", source: "Root Message · RunInput #01" },
    { id: "R190-policy", type: "status", title: "Capability scope fixed", text: "read_repository · query_telemetry · publish_artifact", status: "No write capability" },
    { id: "R190-search", type: "tool", tool: "Search", title: "Correlate cache misses with prompt churn", state: "completed", meta: "1,284 rounds", details: [
      ["Query", "cache_hit == false by first_divergence_component"],
      ["Result", "Misses cluster around changing prompt components rather than repository writes."]
    ] },
    { id: "R190-artifact", type: "artifact", title: "Investigation report published", text: "cache-analysis.md · zero write operations", status: "Published" },
    { id: "R190-complete", type: "status", title: "Run completed explicitly", text: "2 RunInputs incorporated · final artifact linked", status: "Completed" }
  ],
  R201: [
    { id: "R201-input", type: "input", author: "Alex", text: "Explore an event-oriented RunInput model independently.", status: "Incorporated", source: "Mention · RunInput #01" },
    { id: "R201-edit", type: "tool", tool: "Edit", title: "Implement event-oriented model", state: "completed", meta: "RunInput.ts + RunInputEvent.ts", details: [["Base", "a4f20c"], ["Artifact", "X201.patch"], ["Worktree", "W201 · generation 01"]] },
    { id: "R201-artifact", type: "artifact", title: "Candidate X201 published", text: "Immutable patch from base a4f20c", status: "Published" }
  ],
  R202: [
    { id: "R202-input", type: "input", author: "Alex", text: "Explore a state-oriented RunInput model independently.", status: "Incorporated", source: "Mention · RunInput #01" },
    { id: "R202-edit", type: "tool", tool: "Edit", title: "Implement state-oriented model", state: "completed", meta: "RunInput.ts + Disposition.ts", details: [["Base", "a4f20c"], ["Artifact", "X202.patch"], ["Worktree", "W202 · generation 01"]] },
    { id: "R202-artifact", type: "artifact", title: "Candidate X202 published", text: "Immutable patch from base a4f20c", status: "Published" }
  ],
  R203: [
    { id: "R203-input", type: "input", author: "Sable", text: "Reconcile X201 and X202 without rewriting either candidate.", status: "Incorporated", source: "Coordination RunInput #01" },
    { id: "R203-conflict", type: "error", title: "Overlapping file change", text: "X201 and X202 both modify src/RunInput.ts from base a4f20c.", status: "Needs decision" },
    { id: "R203-read", type: "tool", tool: "Read", title: "Compare immutable candidate artifacts", state: "completed", meta: "2 patches", details: [["Candidates", "X201.patch, X202.patch"], ["Conflict", "src/RunInput.ts"], ["Rule", "Preserve both artifacts; produce a new reconciliation artifact."]] },
    { id: "R203-message", type: "assistant", text: "I will combine immutable assignment facts with a separate Provider delivery attempt model in this third Worktree." }
  ],
  R210: [
    { id: "R210-input", type: "input", author: "Alex", text: "Prepare release notes from the current branch.", status: "Abandoned", source: "Root Message · RunInput #01" },
    { id: "R210-shell", type: "tool", tool: "Provider", title: "Generate release-note draft", state: "failed", meta: "timeout after 130 s", details: [["Attempt", "P210-1"], ["Error", "Provider request timed out before a durable result."], ["Recovery", "Inputs preserved as Abandoned(run_failed) and reassigned to R211."]] },
    { id: "R210-error", type: "error", title: "Run failed explicitly", text: "Provider failure did not delete the Thread or its RunInputs.", status: "Failed" },
    { id: "R210-late", type: "status", title: "Late output quarantined", text: "late-output.txt was preserved without changing terminal Run state.", status: "Late output" }
  ],
  R211: [
    { id: "R211-input", type: "input", author: "Sable", text: "Continue the release-note work with the two preserved inputs.", status: "Incorporated", source: "Replacement · reassigned from R210" },
    { id: "R211-shell", type: "tool", tool: "Shell", title: "Build release notes from durable facts", state: "completed", meta: "exit 0", details: [["Inputs", "2 reassigned RunInputs"], ["Dependency", "No reuse of failed Provider session"], ["Output", "release-notes.md"]] },
    { id: "R211-artifact", type: "artifact", title: "Release notes published", text: "release-notes.md", status: "Published" },
    { id: "R211-complete", type: "status", title: "Replacement completed", text: "Explicit complete_run linked the final artifact.", status: "Completed" }
  ],
  R220: [
    { id: "R220-input", type: "input", author: "Alex", text: "Investigate why validation keeps delegating the same check.", status: "Incorporated", source: "Root Message · RunInput #01" },
    { id: "R220-delegate", type: "tool", tool: "Delegate", title: "Ask Keel for an independent validation", state: "completed", meta: "child Run R221", details: [["Causal root", "C44"], ["Delegation depth", "3"], ["Budget", "7 / 50 non-terminal Runs"]] },
    { id: "R220-limit", type: "error", title: "Further delegation blocked", text: "Depth 4 reached. Existing Runs continue; no input was silently discarded.", status: "Budget guard" },
    { id: "R220-message", type: "assistant", text: "The existing evidence is sufficient. I will not create another duplicate validation Run." }
  ],
  R221: [
    { id: "R221-input", type: "input", author: "Sable", text: "Validate the delegation guard independently.", status: "Incorporated", source: "Agent Mention · RunInput #01" },
    { id: "R221-read", type: "tool", tool: "Read", title: "Inspect causal-root limits", state: "completed", meta: "depth + fan-out", details: [["Depth limit", "Enforced"], ["Causal-root limit", "Enforced"], ["Silent discard", "None"]] },
    { id: "R221-artifact", type: "artifact", title: "Guard verification published", text: "guard-verification.txt", status: "Published" }
  ]
};

const state = {
  view: "workbench",
  threadId: "mvp",
  selectedRunId: "R184",
  split: "single",
  activePane: "a",
  channelsVisible: true,
  conversationVisible: true,
  treeVisible: true,
  directMode: false,
  terminalDemo: false,
  activityFilter: "all",
  clientName: "Client A",
  demo: "",
  directDemo: false,
  runInputDemo: false,
  streamDemo: false,
  expandedTools: new Set(),
  dynamicRunItems: Object.fromEntries(Object.keys(threads).flatMap((threadId) => threads[threadId].workspaces.map((workspace) => [workspace.run.id, []]))),
  composerDrafts: {},
  composerErrors: {},
  scrollDetached: {},
  streamText: {},
  streamTimers: {},
  dynamicReplies: Object.fromEntries(Object.keys(threads).map((id) => [id, []])),
  panes: []
};

function esc(value) {
  const node = document.createElement("div");
  node.textContent = value;
  return node.innerHTML;
}

function avatar(name, tone = "human") {
  const initials = tone === "human" ? "AC" : name.slice(0, 1);
  return `<span class="avatar ${tone}">${initials}</span>`;
}

function currentThread() {
  return threads[state.threadId];
}

function allRuns(thread = currentThread()) {
  return thread.workspaces.map((workspace) => ({ ...workspace.run, workspace }));
}

function findRun(runId = state.selectedRunId) {
  return allRuns().find((run) => run.id === runId) || allRuns()[0];
}

function findWorkspaceByRun(runId) {
  return currentThread().workspaces.find((workspace) => workspace.run.id === runId) || currentThread().workspaces[0];
}

function threadReplyCount(thread) {
  return thread.replies.filter((reply) => reply.type !== "system").length + state.dynamicReplies[thread.id].length;
}

function tabKey(type, resourceId, runId = "") {
  return type === "agent" ? `${type}:${resourceId}` : `${type}:${runId}:${resourceId}`;
}

function createTab(type, resourceId, options = {}) {
  if (type === "agent") {
    const run = findRun(resourceId);
    return { key: tabKey(type, run.id), type, resourceId: run.id, title: `${run.agent} · ${run.id}`, icon: "◎" };
  }
  if (type === "terminal") return { key: tabKey(type, resourceId, options.runId), type, resourceId, runId: options.runId, title: options.label || resourceId, icon: ">_" };
  if (type === "file") return { key: tabKey(type, resourceId, options.runId), type, resourceId, runId: options.runId, title: resourceId.split("/").pop(), icon: "▤" };
  return { key: tabKey(type, resourceId, options.runId), type, resourceId, runId: options.runId, title: options.label || resourceId, icon: "◇" };
}

function defaultPanes(threadId, demo = "") {
  state.threadId = threadId;
  state.demo = demo;
  const thread = currentThread();
  const runs = allRuns(thread);
  state.selectedRunId = runs[0].id;
  const primary = createTab("agent", runs[0].id);
  let secondary;
  if (demo === "agents" && runs[1]) secondary = createTab("agent", runs[1].id);
  else if (demo === "terminal") {
    const workspace = runs[0].workspace;
    const terminal = workspace.terminals[0];
    secondary = terminal
      ? createTab("terminal", terminal.id, { runId: runs[0].id, label: terminal.label })
      : createTab("agent", runs[Math.min(1, runs.length - 1)].id);
  } else {
    const workspace = runs[0].workspace;
    const file = workspace.files[0];
    secondary = file
      ? createTab("file", file, { runId: runs[0].id })
      : createTab("agent", runs[Math.min(1, runs.length - 1)].id);
  }
  state.panes = [
    { id: "a", tabs: [primary], activeKey: primary.key },
    { id: "b", tabs: [secondary], activeKey: secondary.key }
  ];
}

function activeTabKey() {
  return state.panes.find((pane) => pane.id === state.activePane)?.activeKey;
}

function updateUrl() {
  const query = new URLSearchParams();
  query.set("view", state.view);
  if (state.view === "workbench") {
    query.set("thread", state.threadId);
    query.set("run", state.selectedRunId);
    query.set("layout", state.split);
    if (!state.channelsVisible) query.set("channels", "0");
    if (!state.conversationVisible) query.set("conversation", "0");
    if (!state.treeVisible) query.set("tree", "0");
    if (!state.channelsVisible && !state.conversationVisible) query.set("mode", "focus");
    else if (!state.channelsVisible) query.set("mode", "thread");
    if (state.demo) query.set("demo", state.demo);
    if (state.expandedTools.size) query.set("tool", [...state.expandedTools][0]);
    if (state.directDemo) query.set("directDemo", "1");
    if (state.runInputDemo) query.set("runInputDemo", "1");
    if (state.terminalDemo) query.set("terminalDemo", "1");
    if (state.streamDemo) query.set("streamDemo", "1");
    query.set("client", state.clientName === "Client B" ? "B" : "A");
  }
  if (state.view === "activity" && state.activityFilter !== "all") query.set("filter", state.activityFilter);
  history.replaceState(null, "", `${location.pathname}?${query}`);
}

function renderChannelPanel() {
  const panel = document.getElementById("channelPanel");
  panel.innerHTML = `
    <div class="channels-inner">
      <header class="project-head">
        <span class="project-icon">JB</span>
        <span><strong>torsor</strong><small>local project</small></span>
        <button class="panel-icon-button" data-toggle-panel="channels" title="Collapse Channels">‹</button>
      </header>
      <div class="channel-tools"><button>⌕ Search</button><button>＋ New</button></div>
      <div class="channel-section-title"><span>Channels</span><span>3</span></div>
      <button class="channel-row ${state.view === "workbench" && currentThread().channel === "torsor-core" ? "active" : ""}"><span>#</span><strong>torsor-core</strong><b>6</b></button>
      <button class="channel-row ${state.view === "workbench" && currentThread().channel === "agent-research" ? "active" : ""}"><span>#</span><strong>agent-research</strong><b>1</b></button>
      <button class="channel-row ${state.view === "workbench" && currentThread().channel === "release" ? "active" : ""}"><span>#</span><strong>release</strong><b>2</b></button>
      <div class="channel-section-title"><span>Threads with activity</span><span>${threadOrder.length}</span></div>
      <div class="thread-list">
        ${threadOrder.map((id) => {
          const thread = threads[id];
          const selected = state.view === "workbench" && id === state.threadId;
          const meta = `${thread.project} / #${thread.channel} · ${threadReplyCount(thread)} replies`;
          return `<button class="thread-row ${selected ? "active" : ""}" data-thread="${id}">
            <i class="thread-dot ${thread.status}"></i>
            <span><strong>${thread.title}</strong><small>${meta}</small></span>
          </button>`;
        }).join("")}
      </div>
      <footer class="channel-footer"><i></i>2 clients synced · server data shared</footer>
    </div>`;
}

function renderTopbar() {
  const topbar = document.getElementById("topbar");
  const thread = currentThread();
  const workbench = state.view === "workbench";
  const focused = workbench && !state.channelsVisible && !state.conversationVisible;
  topbar.innerHTML = `
    <div class="location">
      <strong>${state.view === "activity" ? "Activity across all Threads" : state.view === "agents" ? "Agents" : thread.title}</strong>
      <span>${workbench ? `${thread.project} / #${thread.channel}` : "global projection"}</span>
    </div>
    <div class="topbar-spacer"></div>
    <span class="client-state">${esc(state.clientName)} · local layout</span>
    <span class="sync-status"><i></i>live</span>
    <div class="topbar-group">
      <button class="toolbar-button ${state.channelsVisible ? "active" : ""}" data-toggle-panel="channels"><span>▥</span><span class="button-label">Channels</span></button>
      ${workbench ? `
        <button class="toolbar-button ${state.conversationVisible ? "active" : ""}" data-toggle-panel="conversation"><span>◫</span><span class="button-label">Conversation</span></button>
        <button class="toolbar-button ${state.treeVisible ? "active" : ""}" data-toggle-panel="tree"><span>⌘</span><span class="button-label">Workspaces</span></button>
        <button class="toolbar-button focus-action ${focused ? "active" : ""}" data-view-preset="${focused ? "context" : "focus"}"><span>${focused ? "↤" : "⤢"}</span><span class="button-label">${focused ? "Restore context" : "Focus runs"}</span></button>
      ` : ""}
      <button class="toolbar-button" data-open-shortcuts><span>?</span></button>
    </div>`;
}

function renderConversation() {
  const thread = currentThread();
  const replies = [...thread.replies, ...state.dynamicReplies[thread.id]];
  return `
    <section class="conversation-panel">
      <div class="panel-shell">
        <header class="panel-heading">
          <span><strong>${thread.title}</strong><small>#${thread.channel} · ${threadReplyCount(thread)} replies</small></span>
          <div class="panel-actions"><button class="panel-icon-button" data-toggle-panel="conversation" title="Collapse Conversation">‹</button></div>
        </header>
        <div class="conversation-scroll">
          <article class="root-message">
            <div class="message-row">
              ${avatar("Alex", "human")}
              <div class="message-main">
                <div class="message-meta"><strong>Alex</strong><span>Root Message</span><time>${thread.time}</time></div>
                <p>${thread.root}</p>
              </div>
            </div>
            <div class="root-badges">
              <span class="tiny-badge"><i></i>${thread.workspaces.length} Worktrees</span>
              <span class="tiny-badge review"><i></i>${allRuns(thread).length} Runs</span>
            </div>
          </article>
          <div class="reply-stack">
            ${replies.map(renderReply).join("")}
          </div>
        </div>
        <form class="conversation-composer" id="conversationComposer">
          <div class="composer-box">
            <textarea aria-label="Reply in Thread" placeholder="${state.directMode ? `Send directly to ${state.selectedRunId}…` : "Reply in Thread…"}"></textarea>
            <footer>
              <button type="button" class="composer-mode ${state.directMode ? "direct" : ""}" id="toggleComposerMode">${state.directMode ? `Direct → ${state.selectedRunId}` : "Thread Reply"}</button>
              <button type="button" class="composer-mode">@ Agent</button>
              <button class="composer-send">${state.directMode ? "Send to Run" : "Reply"}</button>
            </footer>
          </div>
        </form>
      </div>
    </section>`;
}

function renderReply(reply) {
  if (reply.type === "system") return `<div class="system-message ${reply.state || ""}">${reply.body}</div>`;
  const human = reply.type === "human";
  return `
    <article class="reply">
      ${avatar(reply.agent, human ? "human" : reply.tone)}
      <div class="message-main">
        <div class="message-meta"><strong>${reply.agent}</strong><span>${human ? "Human" : `${reply.runId} · Agent`}</span><time>${reply.time}</time></div>
        <p>${reply.body}</p>
        ${reply.note ? `<span class="reply-note">${reply.note}</span>` : ""}
        ${reply.run ? `<div class="run-inline ${reply.run.state}">
          <span><strong>${reply.run.id} · ${reply.run.label}</strong><small>${reply.run.state} · independent Worktree</small></span>
          <button data-focus-run="${reply.run.id}">Focus</button>
        </div>` : ""}
      </div>
    </article>`;
}

function renderWorkspaceTree() {
  const thread = currentThread();
  const active = activeTabKey();
  return `
    <aside class="workspace-tree-panel">
      <div class="panel-shell">
        <header class="panel-heading">
          <span><strong>Thread workspaces</strong><small>Project / Worktree / resource</small></span>
          <div class="panel-actions"><button class="panel-icon-button" data-toggle-panel="tree" title="Collapse Workspaces">‹</button></div>
        </header>
        <div class="tree-toolbar"><button>＋ Worktree</button><button>⌕ Filter</button></div>
        <div class="workspace-tree-scroll">
          <div class="tree-project"><span class="project-icon">JB</span><strong>${thread.project}</strong></div>
          ${thread.workspaces.map((workspace) => `
            <section class="workspace-branch">
              <button class="workspace-title">
                <span>⌄</span>
                <span><strong>${workspace.label}</strong><small>${workspace.generation} · ${workspace.branch}</small></span>
                <i class="status-dot ${workspace.state}"></i>
              </button>
              <div class="resource-list">
                ${resourceButton("agent", workspace.run.id, `${workspace.run.agent} · ${workspace.run.id}`, workspace.run.status, active, workspace.run.id)}
                ${workspace.terminals.map((terminal) => resourceButton("terminal", terminal.id, terminal.label, terminal.status, active, workspace.run.id)).join("")}
                <div class="file-group-label">Files</div>
                ${workspace.files.map((file) => resourceButton("file", file, file, file.endsWith(".ts") ? "M" : "", active, workspace.run.id)).join("")}
                <div class="file-group-label">Artifacts</div>
                ${workspace.artifacts.map((artifact) => resourceButton("artifact", artifact, artifact, "immutable", active, workspace.run.id)).join("")}
              </div>
            </section>
          `).join("")}
        </div>
      </div>
    </aside>`;
}

function resourceButton(type, id, label, meta, activeKey, runId) {
  const icon = { agent: "◎", terminal: ">_", file: "▤", artifact: "◇" }[type];
  const key = tabKey(type, id, runId);
  return `<button class="resource-row ${activeKey === key ? "active" : ""}" data-resource="${type}" data-resource-id="${id}" data-run-id="${runId}">
    <span class="resource-icon">${icon}</span><span>${label}</span><small>${meta}</small>
  </button>`;
}

function renderCanvas() {
  const panes = state.split === "single" ? state.panes.slice(0, 1) : state.panes;
  return `
    <section class="canvas-panel">
      <header class="canvas-toolbar">
        <strong>Workbench canvas</strong>
        <button class="layout-button ${state.split === "single" ? "active" : ""}" data-layout="single"><span class="layout-glyph">□</span>Single</button>
        <button class="layout-button ${state.split === "vertical" ? "active" : ""}" data-layout="vertical"><span class="layout-glyph">◫</span>Split right</button>
        <button class="layout-button ${state.split === "horizontal" ? "active" : ""}" data-layout="horizontal"><span class="layout-glyph">⊟</span>Split down</button>
      </header>
      <div class="editor-grid ${state.split}">
        ${panes.map(renderPane).join("")}
      </div>
    </section>`;
}

function renderPane(pane) {
  const activeTab = pane.tabs.find((tab) => tab.key === pane.activeKey);
  return `
    <article class="editor-pane ${state.activePane === pane.id ? "focused" : ""}" data-pane="${pane.id}">
      <div class="pane-bar">
        <div class="pane-tabs">
          ${pane.tabs.map((tab) => `<div class="pane-tab ${tab.key === pane.activeKey ? "active" : ""}">
            <button data-select-tab="${tab.key}" data-pane-id="${pane.id}"><span class="tab-icon">${tab.icon}</span><span class="tab-title">${tab.title}</span></button>
            <button class="tab-close" data-close-tab="${tab.key}" data-pane-id="${pane.id}" aria-label="Close ${tab.title}">×</button>
          </div>`).join("")}
        </div>
        ${activeTab && state.split !== "single" ? `<button class="move-tab-button" data-move-tab="${pane.id}" title="Move active tab to the other pane">⇆</button>` : ""}
      </div>
      <div class="pane-content">${activeTab ? renderTabContent(activeTab, pane.id) : '<div class="empty-pane"><div><strong>Empty panel</strong>Select a resource from the Thread tree.</div></div>'}</div>
    </article>`;
}

function renderTabContent(tab, paneId) {
  if (tab.type === "agent") return renderAgentTab(tab.resourceId, paneId);
  if (tab.type === "file") return renderFileTab(tab.resourceId, tab.runId);
  if (tab.type === "terminal") return renderTerminalTab(tab.resourceId, tab.runId, paneId);
  return renderArtifactTab(tab.resourceId, tab.runId);
}

function runTimeline(runId) {
  return [...(runTimelines[runId] || []), ...(state.dynamicRunItems[runId] || [])];
}

function renderToolDetails(item) {
  return `
    <div class="tool-details">
      ${item.details.map(([label, value]) => `<div class="tool-detail-row"><span>${esc(label)}</span><code>${esc(value)}</code></div>`).join("")}
    </div>`;
}

function renderTimelineItem(item, run) {
  if (item.type === "input") {
    const disposition = item.disposition || item.status;
    const deliveryStatus = item.deliveryStatus || "Accepted";
    return `
      <article class="timeline-item input-item" data-timeline-item="${item.id}">
        <div class="timeline-marker">${avatar(item.author, item.author === "Alex" ? "human" : run.tone)}</div>
        <div class="timeline-body">
          <header><strong>${item.author}</strong><span>sent to ${run.agent} · ${run.id}</span><span class="input-state-group"><em class="disposition ${disposition.toLowerCase().replaceAll(" ", "-")}">${disposition}</em><em class="delivery ${deliveryStatus.toLowerCase().replaceAll(" ", "-")}">${deliveryStatus} delivery</em></span></header>
          <p>${esc(item.text)}</p>
          <small>${esc(item.source)} · also visible in the source Thread</small>
        </div>
      </article>`;
  }
  if (item.type === "assistant") {
    const text = item.streaming && state.streamText[run.id] !== undefined ? state.streamText[run.id] : item.text;
    return `
      <article class="timeline-item assistant-item ${item.streaming ? "streaming" : ""}" data-timeline-item="${item.id}">
        <div class="timeline-marker">${avatar(run.agent, run.tone)}</div>
        <div class="timeline-body">
          <header><strong>${run.agent}</strong><span>Agent output</span>${item.streaming ? '<em class="live-label"><i></i>streaming</em>' : ""}</header>
          <p data-stream-text="${item.streaming ? run.id : ""}">${esc(text)}${item.streaming ? '<span class="stream-caret"></span>' : ""}</p>
        </div>
      </article>`;
  }
  if (item.type === "tool") {
    const expanded = state.expandedTools.has(item.id);
    return `
      <article class="timeline-item tool-item ${item.state} ${expanded ? "expanded" : ""}" data-timeline-item="${item.id}">
        <div class="timeline-marker tool-marker">${{ Search: "⌕", Read: "▤", Edit: "✎", Shell: ">_", Provider: "◇", Delegate: "↗" }[item.tool] || "⚙"}</div>
        <div class="timeline-body">
          <button class="tool-summary" data-tool-toggle="${item.id}" aria-expanded="${expanded}">
            <span><b>${esc(item.tool)}</b><strong>${esc(item.title)}</strong><small>${esc(item.meta)}</small></span>
            <em class="tool-state ${item.state}"><i></i>${item.state}</em>
            <span class="disclosure">${expanded ? "⌃" : "⌄"}</span>
          </button>
          ${expanded ? renderToolDetails(item) : ""}
        </div>
      </article>`;
  }
  const icon = item.type === "artifact" ? "◇" : item.type === "change" ? "±" : item.type === "error" ? "!" : "•";
  return `
    <article class="timeline-item event-item ${item.type}" data-timeline-item="${item.id}">
      <div class="timeline-marker event-marker">${icon}</div>
      <div class="timeline-body">
        <header><strong>${esc(item.title)}</strong><em>${esc(item.status)}</em></header>
        <p>${esc(item.text)}</p>
      </div>
    </article>`;
}

function runSummary(run) {
  const summaries = {
    R184: ["10 inputs", "1 child Run", "+214 −96"],
    R185: ["3 inputs", "read-only review", "1 artifact"],
    R190: ["2 inputs", "read-only", "0 writes"],
    R201: ["4 inputs", "W201", "X201"],
    R202: ["4 inputs", "W202", "X202"],
    R203: ["2 candidates", "1 conflict", "W203"],
    R210: ["2 abandoned", "1 late output", "failed"],
    R211: ["2 reassigned", "1 artifact", "completed"],
    R220: ["depth 4", "7 / 50 Runs", "1 child"],
    R221: ["2 inputs", "read-only review", "1 artifact"]
  };
  return summaries[run.id] || [`${run.inputs} inputs`, run.workspace.generation, run.status];
}

function renderAgentTab(runId, paneId) {
  const run = findRun(runId);
  const statusClass = run.status.toLowerCase() === "active" ? "" : run.status.toLowerCase() === "reviewing" ? "review" : run.status.toLowerCase() === "failed" ? "blocked" : "completed";
  const terminalRun = ["Failed", "Completed", "Cancelled"].includes(run.status);
  const summaries = runSummary(run);
  const source = `${currentThread().project} / #${currentThread().channel} / ${currentThread().title}`;
  return `
    <section class="run-surface" data-run-surface="${run.id}">
      <header class="run-header">
        ${avatar(run.agent, run.tone)}
        <div class="run-heading"><h2>${run.agent} <span>${run.id}</span></h2><p>${run.title}</p></div>
        <button class="source-thread-button" data-view-preset="context" title="Restore Channel and Thread context">↤ Source Thread</button>
        <span class="state-pill ${statusClass}">${run.status}</span>
      </header>
      <div class="run-source"><span>Source</span><strong>${esc(source)}</strong><small>${run.workspace.generation} · ${run.workspace.branch}</small></div>
      <div class="run-pills">
        ${summaries.map((summary) => `<button>${esc(summary)}</button>`).join("")}
        ${run.id === "R184" ? `<button data-replay-stream="${run.id}">Replay stream</button>` : ""}
        <time>${run.elapsed}</time>
      </div>
      <div class="run-timeline" data-run-timeline="${run.id}">
        <div class="timeline-inner">${runTimeline(run.id).map((item) => renderTimelineItem(item, run)).join("")}</div>
        <button class="jump-latest ${state.scrollDetached[run.id] ? "visible" : ""}" data-jump-latest="${run.id}">↓ Latest activity</button>
      </div>
      ${terminalRun ? `
        <div class="terminal-run-footer">
          <span><strong>${run.id} is ${run.status}</strong><small>Terminal Runs reject new RunInputs. Continue in a Successor or Replacement Run.</small></span>
          <button data-create-successor="${run.id}">${run.status === "Failed" ? "Create replacement" : "Create successor"}</button>
        </div>
      ` : `
        <form class="run-composer" data-run-composer="${run.id}" data-pane-id="${paneId}">
          ${state.composerErrors[run.id] ? `<div class="composer-error">${esc(state.composerErrors[run.id])}</div>` : ""}
          <div class="run-composer-box">
            <textarea aria-label="Send to ${run.agent} ${run.id}" placeholder="Send guidance to ${run.agent} · ${run.id}…">${esc(state.composerDrafts[run.id] || "")}</textarea>
            <div class="run-composer-foot">
              <span class="publish-scope">Thread + RunInput</span>
              <button type="button" class="composer-tool" title="Attach an Artifact">＋ Attach</button>
              <span class="composer-target">${run.agent} · ${run.id}</span>
              <button class="run-send" aria-label="Send to ${run.id}">↑</button>
            </div>
          </div>
          <p>Publishes to #${currentThread().channel} and assigns the same Message revision to ${run.id} atomically.</p>
        </form>
      `}
    </section>`;
}

function renderFileTab(path, runId) {
  const workspace = findWorkspaceByRun(runId);
  const lines = fileSamples[path] || [
    '<span class="syntax-comment">// File content is projected from the selected Worktree.</span>',
    `path = <span class="syntax-string">"${esc(path)}"</span>`,
    `generation = <span class="syntax-string">"${workspace.generation}"</span>`
  ];
  return `
    <section class="file-view">
      <header class="file-head"><strong>${path}</strong><span>${workspace.generation}</span><span>sha256:8a31…d02f</span></header>
      <div class="code-view">${lines.map((line) => `<div class="code-line"><span>${line || " "}</span></div>`).join("")}</div>
    </section>`;
}

function renderTerminalTab(terminalId, runId, paneId) {
  const run = findRun(runId);
  const workspace = run.workspace;
  return `
    <section class="terminal-view">
      <header class="terminal-meta"><strong>Human full control</strong><span>${terminalId}</span><span>Writer Authority: Human · Agent lease revoked</span><span>controller: this Client</span></header>
      <div class="terminal-screen" id="terminalScreen-${paneId}">
        <div class="terminal-line dim">Torsor TerminalSession · commands are not filtered</div>
        <div class="terminal-line dim">origin: ${run.agent} · ${run.id} · ${workspace.generation}</div>
        <div class="terminal-line dim">initial cwd: /worktrees/${workspace.label}</div>
        <div class="terminal-line">&nbsp;</div>
        <div class="terminal-line"><span class="prompt-path">/worktrees/${workspace.label}</span> <span class="prompt-mark">❯</span> git status --short</div>
        <div class="terminal-line output"> M src/workbench.ts</div>
        <div class="terminal-line output"> M src/panels.css</div>
        ${state.terminalDemo ? `
          <div class="terminal-line">&nbsp;</div>
          <div class="terminal-line"><span class="prompt-path">/worktrees/${workspace.label}</span> <span class="prompt-mark">❯</span> npm test</div>
          <div class="terminal-line success">✓ Conversation remains visible</div>
          <div class="terminal-line success">✓ Worktree provenance is retained</div>
          <div class="terminal-line success">✓ Split panels are independent Client views</div>
        ` : ""}
      </div>
      <form class="terminal-form" data-terminal-form="${paneId}">
        <span class="prompt-path">/worktrees/${workspace.label}</span><span class="prompt-mark">❯</span>
        <input aria-label="Terminal command" autocomplete="off" spellcheck="false" />
      </form>
    </section>`;
}

function renderArtifactTab(artifact, runId) {
  const run = findRun(runId);
  return `
    <section class="agent-view">
      <header class="agent-header"><span class="avatar ${run.tone}">◇</span><div><h2>${artifact}</h2><p>Immutable Artifact · produced by ${run.id}</p></div><span class="state-pill completed">Published</span></header>
      <div class="objective-block"><small>Provenance</small><p>${run.agent} · ${run.workspace.generation} · source Thread “${currentThread().title}”</p></div>
      <div class="agent-inputs"><h3>Artifact facts</h3><div class="input-row"><span>Hash</span><div><strong>sha256:53ab…91e2</strong><small>content-addressed output</small></div><em>Immutable</em></div></div>
    </section>`;
}

function renderWorkbench() {
  const classes = ["workbench-layout"];
  if (!state.conversationVisible) classes.push("conversation-collapsed");
  if (!state.treeVisible) classes.push("tree-collapsed");
  document.getElementById("mainView").innerHTML = `
    <div class="${classes.join(" ")}">
      ${state.conversationVisible ? renderConversation() : ""}
      ${state.treeVisible ? renderWorkspaceTree() : ""}
      ${renderCanvas()}
    </div>`;
}

function activityItem(item) {
  return `<button class="activity-item" data-activity-thread="${item.threadId}" data-activity-run="${item.runId}">
    <header>${avatar(item.agent, item.tone)}<span><strong>${item.title}</strong><small>${item.agent} · ${item.runId}</small></span><i class="severity ${item.group}"></i><time>${item.time}</time></header>
    <p>${item.detail}</p>
    <div class="activity-path">${item.path.map((part) => `<span>${part}</span>`).join("")}</div>
  </button>`;
}

function renderActivity() {
  const groups = [
    ["needs", "Needs you", "conflict, failure or decision"],
    ["running", "Running now", "active across Threads"],
    ["done", "Recently completed", "durable results"]
  ];
  const visibleGroups = state.activityFilter === "all" ? groups : groups.filter(([id]) => id === state.activityFilter);
  document.getElementById("mainView").innerHTML = `
    <section class="activity-view">
      <header class="activity-header">
        <div><h1>Activity across all Threads</h1><p>A Human attention surface over durable facts. Every item returns to its source conversation and Run.</p></div>
        <div class="activity-kpis"><div><strong>5</strong><span>active Runs</span></div><div><strong>3</strong><span>need you</span></div><div><strong>4</strong><span>Threads</span></div></div>
      </header>
      <div class="activity-filterbar">
        ${[["all", "All"], ["needs", "Needs you"], ["running", "Running"], ["done", "Completed"]].map(([id, label]) => `<button class="filter-button ${state.activityFilter === id ? "active" : ""}" data-activity-filter="${id}">${label}</button>`).join("")}
      </div>
      <div class="activity-columns ${state.activityFilter === "all" ? "" : "filtered"}">
        ${visibleGroups.map(([id, title, detail]) => {
          const items = activities.filter((item) => item.group === id);
          return `<section class="activity-column"><header><strong>${title}</strong><span>${items.length} · ${detail}</span></header>${items.map(activityItem).join("")}</section>`;
        }).join("")}
      </div>
    </section>`;
}

function renderAgents() {
  const agents = [
    { name: "Sable", tone: "sable", summary: "3 active · 2 completed", runs: activities.filter((item) => item.agent === "Sable") },
    { name: "Keel", tone: "keel", summary: "2 reviewing", runs: activities.filter((item) => item.agent === "Keel") },
    { name: "Nova", tone: "nova", summary: "1 failed · 1 completed", runs: activities.filter((item) => item.agent === "Nova") }
  ];
  document.getElementById("mainView").innerHTML = `
    <section class="agents-view">
      <h1>Agents</h1><p>Stable identities with concurrent Runs across independent Threads and Worktrees.</p>
      <div class="agent-board">${agents.map((agent) => `
        <article class="agent-card">
          <header>${avatar(agent.name, agent.tone)}<span><strong>${agent.name}</strong><small>${agent.summary}</small></span></header>
          <section>${agent.runs.map((run) => `<div class="agent-run-row"><i class="severity ${run.group}"></i><span><b>${run.title}</b><small>${run.path.join(" / ")}</small></span><button data-activity-thread="${run.threadId}" data-activity-run="${run.runId}">Open</button></div>`).join("")}</section>
        </article>`).join("")}</div>
    </section>`;
}

function render() {
  document.getElementById("desktopShell").classList.toggle("channels-collapsed", !state.channelsVisible);
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  renderChannelPanel();
  renderTopbar();
  if (state.view === "workbench") renderWorkbench();
  if (state.view === "activity") renderActivity();
  if (state.view === "agents") renderAgents();
  bindEvents();
  updateUrl();
}

function openThread(threadId, runId, demo = "") {
  state.view = "workbench";
  defaultPanes(threadId, demo);
  if (runId) {
    state.selectedRunId = runId;
    const tab = createTab("agent", runId);
    state.panes[0] = { id: "a", tabs: [tab], activeKey: tab.key };
  }
  state.activePane = "a";
  render();
}

function openResource(type, resourceId, runId) {
  state.selectedRunId = runId;
  const pane = state.panes.find((item) => item.id === state.activePane);
  const workspace = findWorkspaceByRun(runId);
  const terminal = workspace.terminals.find((item) => item.id === resourceId);
  const tab = createTab(type, resourceId, {
    runId,
    label: terminal?.label
  });
  if (!pane.tabs.some((item) => item.key === tab.key)) pane.tabs.push(tab);
  pane.activeKey = tab.key;
  render();
}

function setLayout(layout) {
  state.split = layout;
  if (layout !== "single" && !state.panes[1].tabs.length) {
    const run = allRuns()[Math.min(1, allRuns().length - 1)];
    const tab = createTab("agent", run.id);
    state.panes[1] = { id: "b", tabs: [tab], activeKey: tab.key };
  }
  render();
}

function moveActiveTab(fromPaneId) {
  const from = state.panes.find((pane) => pane.id === fromPaneId);
  const to = state.panes.find((pane) => pane.id !== fromPaneId);
  const tab = from.tabs.find((item) => item.key === from.activeKey);
  if (!tab || !to) return;
  from.tabs = from.tabs.filter((item) => item.key !== tab.key);
  if (!to.tabs.some((item) => item.key === tab.key)) to.tabs.push(tab);
  to.activeKey = tab.key;
  from.activeKey = from.tabs[0]?.key || "";
  state.activePane = to.id;
  render();
}

function closeTab(paneId, key) {
  const pane = state.panes.find((item) => item.id === paneId);
  const index = pane.tabs.findIndex((tab) => tab.key === key);
  pane.tabs.splice(index, 1);
  if (pane.activeKey === key) pane.activeKey = pane.tabs[Math.max(0, index - 1)]?.key || "";
  render();
}

function togglePanel(panel) {
  if (panel === "channels") state.channelsVisible = !state.channelsVisible;
  if (panel === "conversation") state.conversationVisible = !state.conversationVisible;
  if (panel === "tree") state.treeVisible = !state.treeVisible;
  render();
}

function setViewPreset(preset) {
  if (preset === "focus") {
    state.channelsVisible = false;
    state.conversationVisible = false;
    state.treeVisible = true;
  } else if (preset === "thread") {
    state.channelsVisible = false;
    state.conversationVisible = true;
    state.treeVisible = true;
  } else {
    state.channelsVisible = true;
    state.conversationVisible = true;
    state.treeVisible = true;
  }
  render();
}

function handleConversationSubmit(event) {
  event.preventDefault();
  const input = event.currentTarget.querySelector("textarea");
  const body = input.value.trim();
  if (!body) return toast("Nothing to send", "Write a Thread Reply or direct Run input first.");
  if (state.directMode) {
    if (!sendToRun(state.selectedRunId, body)) return;
    input.value = "";
    return;
  }
  state.dynamicReplies[state.threadId].push({
    type: "human",
    agent: "Alex",
    tone: "human",
    time: "now",
    body: esc(body),
    note: body.includes("@") ? "Mention created durable Attention" : "Ordinary Thread Reply"
  });
  input.value = "";
  render();
  toast("Reply published", "The Thread remains the public source of truth.");
}

function updateDynamicRunItem(runId, itemId, changes) {
  const item = state.dynamicRunItems[runId].find((entry) => entry.id === itemId);
  if (item) Object.assign(item, changes);
}

function sendToRun(runId, body) {
  const run = findRun(runId);
  if (["Failed", "Completed", "Cancelled"].includes(run.status)) {
    toast(`${runId} is ${run.status}`, "Create a Successor or Replacement Run before sending new input.");
    return false;
  }
  const itemId = `${runId}-human-${Date.now()}`;
  state.dynamicReplies[state.threadId].push({
    type: "human",
    agent: "Alex",
    tone: "human",
    time: "now",
    body: esc(body),
    note: `Message + RunInput assigned to ${runId}`
  });
  state.dynamicRunItems[runId].push({
    id: itemId,
    type: "input",
    author: "Alex",
    text: body,
    disposition: "Pending",
    deliveryStatus: "Pending",
    source: `New public Thread Message · ${runId}`
  });
  render();
  toast(`Sent to ${runId}`, "The public Thread Message and RunInput were committed together.");
  setTimeout(() => {
    updateDynamicRunItem(runId, itemId, { deliveryStatus: "Delivered" });
    render();
  }, 700);
  setTimeout(() => {
    updateDynamicRunItem(runId, itemId, { deliveryStatus: "Accepted" });
    render();
  }, 1500);
  return true;
}

function handleRunSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const runId = form.dataset.runComposer;
  const run = findRun(runId);
  const input = form.querySelector("textarea");
  const body = input.value.trim();
  if (!body) return toast("Nothing to send", `Write guidance for ${run.agent} · ${run.id} first.`);

  if (body.toLowerCase().includes("[fail]")) {
    state.composerDrafts[runId] = body;
    state.composerErrors[runId] = "Atomic send failed. No Thread Message or RunInput was created; your draft is preserved.";
    render();
    return;
  }

  delete state.composerErrors[runId];
  state.composerDrafts[runId] = "";
  sendToRun(runId, body);
}

function replayStream(runId) {
  const fullText = runTimelines[runId]?.find((item) => item.streaming)?.text;
  if (!fullText) return;
  clearInterval(state.streamTimers[runId]);
  state.streamText[runId] = "";
  render();
  let index = 0;
  state.streamTimers[runId] = setInterval(() => {
    index += 2;
    state.streamText[runId] = fullText.slice(0, index);
    const target = document.querySelector(`[data-stream-text="${runId}"]`);
    if (target) {
      target.innerHTML = `${esc(state.streamText[runId])}<span class="stream-caret"></span>`;
      const timeline = document.querySelector(`[data-run-timeline="${runId}"]`);
      if (timeline && !state.scrollDetached[runId]) timeline.scrollTop = timeline.scrollHeight;
    }
    if (index >= fullText.length) {
      clearInterval(state.streamTimers[runId]);
      delete state.streamTimers[runId];
    }
  }, 36);
}

function handleTerminalSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const paneId = form.dataset.terminalForm;
  const input = form.querySelector("input");
  const command = input.value.trim();
  if (!command) return;
  input.value = "";
  const screen = document.getElementById(`terminalScreen-${paneId}`);
  const line = document.createElement("div");
  line.className = "terminal-line";
  line.textContent = `/worktrees/current ❯ ${command}`;
  screen.appendChild(line);
  if (command.toLowerCase().includes("npm test")) {
    ["✓ Conversation remains visible", "✓ Worktree provenance is retained", "✓ Split panels are independent Client views"].forEach((text) => {
      const output = document.createElement("div");
      output.className = "terminal-line success";
      output.textContent = text;
      screen.appendChild(output);
    });
  } else {
    const output = document.createElement("div");
    output.className = "terminal-line output";
    output.textContent = `Mock execution: ${command}`;
    screen.appendChild(output);
  }
  screen.scrollTop = screen.scrollHeight;
}

function toast(title, detail) {
  const node = document.createElement("div");
  node.className = "toast";
  node.innerHTML = `<strong>${esc(title)}</strong>${esc(detail)}`;
  document.getElementById("toastRegion").appendChild(node);
  setTimeout(() => node.remove(), 3200);
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
    state.view = button.dataset.view;
    render();
  }));
  document.querySelectorAll("[data-thread]").forEach((button) => button.addEventListener("click", () => openThread(button.dataset.thread)));
  document.querySelectorAll("[data-toggle-panel]").forEach((button) => button.addEventListener("click", () => togglePanel(button.dataset.togglePanel)));
  document.querySelectorAll("[data-view-preset]").forEach((button) => button.addEventListener("click", () => setViewPreset(button.dataset.viewPreset)));
  document.querySelectorAll("[data-focus-run]").forEach((button) => button.addEventListener("click", () => openResource("agent", button.dataset.focusRun, button.dataset.focusRun)));
  document.querySelectorAll("[data-resource]").forEach((button) => button.addEventListener("click", () => openResource(button.dataset.resource, button.dataset.resourceId, button.dataset.runId)));
  document.querySelectorAll("[data-layout]").forEach((button) => button.addEventListener("click", () => setLayout(button.dataset.layout)));
  document.querySelectorAll("[data-move-tab]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    moveActiveTab(button.dataset.moveTab);
  }));
  document.querySelectorAll("[data-pane]").forEach((pane) => pane.addEventListener("mousedown", () => {
    state.activePane = pane.dataset.pane;
    document.querySelectorAll("[data-pane]").forEach((item) => item.classList.toggle("focused", item.dataset.pane === state.activePane));
  }));
  document.querySelectorAll("[data-select-tab]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    const pane = state.panes.find((item) => item.id === button.dataset.paneId);
    state.activePane = pane.id;
    pane.activeKey = button.dataset.selectTab;
    render();
  }));
  document.querySelectorAll("[data-close-tab]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(button.dataset.paneId, button.dataset.closeTab);
  }));
  document.querySelectorAll("[data-activity-filter]").forEach((button) => button.addEventListener("click", () => {
    state.activityFilter = button.dataset.activityFilter;
    render();
  }));
  document.querySelectorAll("[data-activity-thread]").forEach((button) => button.addEventListener("click", () => openThread(button.dataset.activityThread, button.dataset.activityRun, "agents")));
  document.getElementById("conversationComposer")?.addEventListener("submit", handleConversationSubmit);
  document.getElementById("toggleComposerMode")?.addEventListener("click", () => {
    state.directMode = !state.directMode;
    render();
  });
  document.querySelectorAll("[data-run-composer]").forEach((form) => {
    form.addEventListener("submit", handleRunSubmit);
    const runId = form.dataset.runComposer;
    form.querySelector("textarea").addEventListener("input", (event) => {
      state.composerDrafts[runId] = event.currentTarget.value;
      delete state.composerErrors[runId];
    });
  });
  document.querySelectorAll("[data-tool-toggle]").forEach((button) => button.addEventListener("click", () => {
    const toolId = button.dataset.toolToggle;
    if (state.expandedTools.has(toolId)) state.expandedTools.delete(toolId);
    else state.expandedTools.add(toolId);
    render();
  }));
  document.querySelectorAll("[data-replay-stream]").forEach((button) => button.addEventListener("click", () => replayStream(button.dataset.replayStream)));
  document.querySelectorAll("[data-create-successor]").forEach((button) => button.addEventListener("click", () => {
    const runId = button.dataset.createSuccessor;
    toast(`Successor requested for ${runId}`, "The prototype would create a new Run and Worktree while preserving this terminal history.");
  }));
  document.querySelectorAll("[data-run-timeline]").forEach((timeline) => {
    const runId = timeline.dataset.runTimeline;
    if (!state.scrollDetached[runId]) timeline.scrollTop = timeline.scrollHeight;
    timeline.addEventListener("scroll", () => {
      const detached = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight > 90;
      state.scrollDetached[runId] = detached;
      timeline.querySelector(".jump-latest")?.classList.toggle("visible", detached);
    });
  });
  document.querySelectorAll("[data-jump-latest]").forEach((button) => button.addEventListener("click", () => {
    const runId = button.dataset.jumpLatest;
    const timeline = document.querySelector(`[data-run-timeline="${runId}"]`);
    state.scrollDetached[runId] = false;
    if (timeline) timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
    button.classList.remove("visible");
  }));
  document.querySelectorAll("[data-terminal-form]").forEach((form) => form.addEventListener("submit", handleTerminalSubmit));
  document.querySelectorAll("[data-open-shortcuts]").forEach((button) => button.addEventListener("click", () => document.getElementById("shortcutDialog").showModal()));
}

document.getElementById("closeShortcuts").addEventListener("click", () => document.getElementById("shortcutDialog").close());

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey) return;
  if (event.key === "1") {
    event.preventDefault();
    togglePanel("conversation");
  }
  if (event.key === "2") {
    event.preventDefault();
    togglePanel("tree");
  }
  if (event.key === "3") {
    event.preventDefault();
    setViewPreset(!state.channelsVisible && !state.conversationVisible ? "context" : "focus");
  }
  if (event.key === "\\") {
    event.preventDefault();
    setLayout(event.shiftKey ? "horizontal" : "vertical");
  }
});

const params = new URLSearchParams(location.search);
state.view = params.get("view") || "workbench";
state.threadId = threads[params.get("thread")] ? params.get("thread") : "mvp";
state.split = ["single", "vertical", "horizontal"].includes(params.get("layout")) ? params.get("layout") : "single";
state.channelsVisible = params.get("channels") !== "0";
state.conversationVisible = params.get("conversation") !== "0";
state.treeVisible = params.get("tree") !== "0";
if (params.get("mode") === "thread") {
  state.channelsVisible = false;
  state.conversationVisible = true;
}
if (params.get("mode") === "focus") {
  state.channelsVisible = false;
  state.conversationVisible = false;
}
state.activityFilter = ["all", "needs", "running", "done"].includes(params.get("filter")) ? params.get("filter") : "all";
state.clientName = params.get("client") === "B" ? "Client B" : "Client A";
state.directDemo = params.get("directDemo") === "1";
state.runInputDemo = params.get("runInputDemo") === "1";
state.streamDemo = params.get("streamDemo") === "1";
defaultPanes(state.threadId, params.get("demo") || "");
state.terminalDemo = params.get("terminalDemo") === "1";
if (params.get("tool")) state.expandedTools.add(params.get("tool"));
if (state.directDemo) {
  state.directMode = true;
  state.dynamicReplies.mvp.push({
    type: "human",
    agent: "Alex",
    tone: "human",
    time: "now",
    body: "Keep the file and Agent panels open while handling this follow-up.",
    note: "Message + RunInput assigned to R184"
  });
}
if (state.runInputDemo) {
  state.dynamicReplies.mvp.push({
    type: "human",
    agent: "Alex",
    tone: "human",
    time: "now",
    body: "Keep the Tool Call details open and verify that this instruction remains visible in the public Thread.",
    note: "Message + RunInput assigned to R184"
  });
  state.dynamicRunItems.R184.push({
    id: "R184-human-demo",
    type: "input",
    author: "Alex",
    text: "Keep the Tool Call details open and verify that this instruction remains visible in the public Thread.",
    disposition: "Pending",
    deliveryStatus: "Accepted",
    source: "Public Thread Message · RunInput #11"
  });
}
if (params.get("run") && allRuns().some((run) => run.id === params.get("run"))) {
  state.selectedRunId = params.get("run");
  const requestedTab = createTab("agent", state.selectedRunId);
  state.panes[0] = { id: "a", tabs: [requestedTab], activeKey: requestedTab.key };
}
render();
if (state.streamDemo) setTimeout(() => replayStream(state.selectedRunId), 250);
