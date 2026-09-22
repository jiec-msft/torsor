# Torsor MVP 0.1 原型

> 简体中文（主要版本） | [English](README.md)

这是一个静态、无依赖的桌面原型，用于展示 Torsor 以对话为先、Agent-native 的协作模型。

持久事实的来源关系保持为：

```text
Channel -> Root Message -> Thread Replies -> Run -> Worktree
```

UI 不会把这组关系变成彼此替换的页面，而是将相同事实投影到可以独立折叠的界面区域：

```text
Rail | Channels | Conversation | Thread Workspaces | Run Canvas
```

## 运行

在本目录执行：

```powershell
python -m http.server 4173
```

然后打开 `http://localhost:4173`。

## 三种上下文模式

顶部工具栏让上下文切换保持可逆，而不是强制后退导航：

```text
完整上下文
Rail | Channels | Conversation | Workspaces | Run Canvas

Thread 协作
Rail | Conversation | Workspaces | Run Canvas

Run 专注
Rail | Workspaces | one or two Run panes
```

- **Channels** 和 **Conversation** 可以独立折叠。
- **Focus runs** 一次折叠两者。
- **Restore context** 一次恢复两者。
- **Workspaces** 也可以独立折叠。
- 每个聚焦的 Run 都保留可见的来源 Channel、Thread、Worktree generation 和 branch。

可用路由：

```text
/?view=workbench&thread=mvp&layout=single
/?view=workbench&thread=mvp&layout=single&mode=thread
/?view=workbench&thread=mvp&layout=vertical&demo=agents&mode=focus
/?view=workbench&thread=mvp&layout=single&mode=focus&tree=0&tool=R184-edit
/?view=workbench&thread=mvp&layout=single&mode=thread&tree=0&runInputDemo=1
/?view=workbench&thread=recovery&run=R210&mode=focus&tree=0&tool=R210-shell
/?view=activity
/?view=agents
```

## Agent Run 交互

Agent Pane 是持续工作的界面，而不是静态状态卡：

```text
Run header and provenance
Run summary pills
Typed activity timeline
├─ Human RunInput
├─ Agent user-visible output
├─ Tool Call
├─ File or Artifact change
├─ delivery / Provider status
└─ explicit completion or failure
Fixed Send-to-Run composer
```

包含的交互：

- 展开或折叠 Tool Call，同时始终显示 running、completed 或 failed 状态。
- 重放模拟的 streaming output。
- Human 向上滚动时停止自动跟随，并可通过 **Latest activity** 回到底部。
- 从固定 Run composer 发送指导。
- 原子模拟一条公开 Thread Message 和一个 RunInput。
- 当交付状态按 `Pending -> Delivered -> Accepted` 推进时，语义 disposition 仍保持 `Pending`。
- 在 Run composer 中输入 `[fail]` 模拟原子发送失败；保留草稿，并且不创建 Message 或 RunInput。
- 拒绝向终态 Run 发送输入，并提供 Successor 或 Replacement。
- 将 Agent、File、Terminal 和 Artifact Resource 作为 Tab 打开。
- 向右或向下分屏，并将活动 Tab 移到另一个 Pane。
- 在 Human 控制的 Terminal 中运行模拟命令；浏览器绝不执行真实 Host 命令。

## 投影边界

Panel 可见性、Tab、分屏方向、已展开 Tool Call、草稿和滚动位置都属于 Client view state。

Message、Attention、Run、RunInput、ProviderAttempt、Worktree generation、TerminalSession、RunActivityEvent、Artifact 和外部引用仍然是持久或运行时事实。

Streaming output 不会自动成为公开 Message。Run composer 是显式桥梁：它发布一条 Thread Message，并将该 Message 的确切 revision 分配给所选 Run。

## 有序证据

证据集同时包含完整桌面视图和较窄的局部截图，使 Tool Call 和 Composer 文本在手机上仍然可读。

| 文件 | 展示的核心 UX 场景 |
|---|---|
| `001-full-context-thread-and-run.png` | Channel、Root Message、Reply、Worktree、Agent Timeline 和 Composer 同时存在 |
| `002-channel-column-collapsed.png` | Channels 折叠后公开 Thread 仍然可见 |
| `003-focus-mode-single-run.png` | Channels 与 Conversation 一起折叠，来源仍然可见 |
| `004-streaming-timeline-and-composer.png` | 用户可见 Streaming、已完成/运行中 Tool Call 和固定 Run composer |
| `005-expanded-tool-call-detail.png` | 按需展开 Tool Call 细节，包括文件、变更摘要、Writer Authority 和 fencing token |
| `006-failed-tool-call-detail.png` | 失败的 Provider attempt、被放弃的 input、late output 和 Replacement 操作 |
| `007-run-input-visible-in-thread-and-timeline.png` | 同一条 Human 指令同时出现在公开 Thread 和所选 Run Timeline |
| `008-two-agent-runs-two-worktrees.png` | 两个 Agent 在不同 Worktree 和分屏 Pane 中并发工作 |
| `009-conflict-and-coordination-worktree.png` | 冲突的不可变候选保持分离，由第三个 Run 协调 |
| `010-failed-and-replacement-runs.png` | Failed 与 Replacement Run 共存，保留来源和终态控制 |
| `011-read-only-investigation.png` | 只读 Capability Scope、零写入、已发布报告和显式完成 |
| `012-human-terminal-writer-takeover.png` | Human Terminal 拥有完整命令控制和显式 Writer Authority |
| `013-delegation-budget-guard.png` | Agent 委派、子 Run、深度限制和不静默丢弃 |
| `014-activity-across-all-threads.png` | 跨 Thread 聚合 Human 相关 Activity，并显示来源路径 |
| `015-agent-concurrency-overview.png` | 稳定 Agent Identity 在独立 Thread 中拥有并发 Run |
| `016-client-a-context-layout.png` | Client A 在共享服务端事实之上保留完整上下文布局 |
| `017-client-b-independent-focus-layout.png` | Client B 用独立的聚焦分屏查看相同事实 |

## 当前边界

该原型有意模拟 Provider 执行、持久化、认证、Worktree 集成、外部工具和多 Client 传输。它展示 MVP 信息架构、交互语义、状态差异和专注行为，但不会为 Workspace、Tab、Pane、Tool Call UI 或 Composer 新增领域对象。
