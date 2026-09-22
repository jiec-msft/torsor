# `@torsor/acp-conformance`

> 简体中文（主要版本） | [English](README.md)

独立的 ACP v1 Provider 场景执行器，不依赖 Torsor Kernel、Runtime 或 Host。规范和复用决策见[中英文配对规格](../../docs/specs/acp-conformance.zh-cn.md)。它验证明确的协议子集，而不是完整 ACP 认证。

## 快速开始

在仓库根目录安装依赖并构建：

```powershell
npm ci
npm run build --workspace @torsor/acp-conformance
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json
npm exec -- acp-conformance run packages\acp-conformance\examples\cancel.yaml packages\acp-conformance\examples\malformed.yaml
npm run test:acp-conformance
```

上面的路径为 PowerShell 形式；POSIX Shell 使用 `/`。`basic.json` 与 `basic.yaml` 语义相同；不要把两个相同 ID 同时放入 CLI Suite。默认只运行本地确定性 Mock，不访问模型、网络或凭据。

```ts
import { loadScenario, runScenario, runSuite, toJsonl } from "@torsor/acp-conformance";

const scenario = loadScenario(syntheticScenarioText, { format: "yaml" });
const result = await runScenario(scenario);
const transcript = toJsonl(result);
const suite = await runSuite([scenario]);
```

唯一配置 Schema 在 `src/schema.ts`。JSON/YAML 先解析成相同的有界 JSON，再执行严格验证；控制字段不允许未知值。`ConfigurationError.paths` 提供结构路径，不回显输入值。输入最多 256 KiB、深度 32。`schemaVersion` 必须为 `1`。

## 场景与 Mock

`request` 开始一个带本地标签的异步请求，`response` 消费结果。`notification` 发送通知，`update` 消费匹配的 Session Update，`close-stdin` 和 `exit` 检查进程生命周期。`response.expect` 和 `update.expect` 使用 `{ path, equals }` 或 `{ path, kind }`，其中 `path` 为 RFC 6901 JSON Pointer。`errorCode` 可断言 RPC 错误。断言针对协议事实，不匹配模型措辞。

参数支持 `{ "$ref": "workspace" }` 和 `{ "$ref": "session#/sessionId" }`；第二种引用已消费的响应。没有字符串插值、环境展开或执行代码。

`session/new` 返回的非空 ID 在本连接必须唯一。每个 Session 的初始 `tool_call` ID 也必须非空且唯一；先宣布 Tool，再发送引用它的 Update 或 Permission 请求。内容/工具 Update 和 Permission 需要活动 Prompt；合法 Permission 一律 `cancelled`，无效生命周期在应答前拒绝。新 Prompt 不允许复用该 Session 的初始 Tool ID。

`mock.handlers` 的 `method` / `kind` 注册 SDK Handler；动作包括 `reply`、`notify`、反向 `request`、具名 `wait` / `release` Gate 和 `fault`。`mock.onStdinClose` 可确定性注入 EOF 之后的输出。`fault.kind` 包括 `malformed`、`oversized`、`stderr`、`stdout-close`、`stdin-close`、`exit`、`hang`、`wire`。`wire.message` 为显式 JSON 消息，`wire.newline: false` 用于半帧；`oversized` / `stderr` 使用 `bytes`。这些是测试故障，不是生产兼容行为。

```powershell
npm exec -- acp-conformance mock packages\acp-conformance\examples\basic.json
```

该命令在 stdin/stdout 上提供标准 ACP 对端，其他 Client 可以直接启动它。正常协议关联和派发复用官方 SDK，不另造 JSON-RPC 引擎。

`stdout-close` / `stdin-close` 故障要求 Runner 管理的 Mock 控制通道，独立 `mock` 命令不提供这两个故障。Windows 使用 MIT 的 Koffi 预编译原生绑定建立 Job Object，不需要运行时编译或 PowerShell；所有权设置失败时不启动 Provider。安装时不要省略与平台匹配的原生可选包。POSIX 使用独立进程组。

## 结果与预算

`--out <directory>` 生成每场景的 `<id>.artifacts/`，包含 `result.json`、`transcript.jsonl` 和记录版本、场景 ID、提交 UUID、数据文件字节数及 SHA-256 的 `manifest.json`，拒绝覆盖。返回状态为 `passed`、`failed` 或 `skipped`。CLI 退出码分别为全通过 `0`、失败 `1`、配置/用法/I/O 错误 `2`、真实 Provider 未启用 `3`；失败优先于跳过。

Bundle 是唯一的消费者提交边界，替代旧的平铺文件（不自动迁移/删除旧文件）。在唯一的隐藏尝试目录内暂存并同步完整内容，再用 Windows/Linux 同文件系统禁止替换的原子目录 Rename 发布；任何现有目标（包括空目录、文件、Symlink 或 Junction）均保持不变。不要读取隐藏暂存目录。

普通重试会先通过 OS 独占锁和严格、限长、绑定文件身份的版本化 Claim 恢复死亡 Writer 的已知暂存，不依赖 PID/时间或仅凭文件名删除。清理只删除已验证的暂存文件及空目录，不跟随链接，也不修改最终 Bundle。活跃 Writer、未知/损坏 Claim、额外文件或身份变化的残留会保留；无法验证的残留给出固定警告，但唯一尝试名使它不阻止新提交。发布前终止可正常重试；发布后、确认前终止时完整 Bundle 已提交，重试保留它并拒绝覆盖。I/O/清理失败明确报错。需要 Windows/Linux 本地文件系统的原生锁、稳定文件身份和 no-replace Rename；不降级为覆盖式 Rename，也不保证网络文件系统、掉电或跨场景原子性。完整边界见[规格 §2.1](../../docs/specs/acp-conformance.zh-cn.md#21-可恢复的-artifact-发布)。

Diagnostic 包含稳定 `code`、从零开始的 `step`（启动阶段为 `-1`）和不包含原始值的说明。`expectFailure` 用于测试 Harness 的错误路径；匹配时保留 Diagnostic，清理失败永不视为成功。

可覆盖 `limits.frameBytes`、`stdoutBytes`、`stderrBytes`、`events`、`startupMs`、`stepMs`、`runMs`、`shutdownMs`。默认依次为 262144、1048576、65536、2048、15000、5000、30000、2000。启动预算与协议步骤分离；真实 Provider 通常需要显式提高 `stepMs` / `runMs`；失败不会自动重试。

JSONL 只记录白名单协议事实、稳定 ID 和顺序；逻辑 Timestamp 每事件增加 1 ms，不用于测量耗时。Prompt、生成内容、stderr、错误文本、环境、机器路径和未知负载全部被省略或脱敏。它适合结构 Diff，不是无损 Wire Capture，也没有本切片的 Replay API。

## 可选真实 Provider

必须显式启用；环境中存在凭据不能开启测试。仅对受信任命令使用此功能，Harness 不是 OS Sandbox。

```powershell
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json --allow-real --profile copilot-cli-v1 --inherit-env COPILOT_GITHUB_TOKEN
npm exec -- acp-conformance run packages\acp-conformance\examples\basic.json --allow-real -- provider-executable --acp
```

只授权必要环境名称；不要将凭据放入场景、参数、Artifact 或仓库。未设置的环境名称明确报错。默认隔离 HOME、配置、缓存和临时目录，不自动复用登录文件。具名 Copilot Profile 禁用工具和非必要集成，并将日志限制在临时 Workspace。生命周期有效的权限请求自动 `cancelled`，无效请求令场景失败；其他客户端工具请求返回 Method Not Found。合法工具活动通知本身不等于协议违规。

API 使用 `runScenario(scenario, { allowReal: true, provider: { command, args, environment } })` 或 `provider: { profile: "copilot-cli-v1", environment }`。Command/Args 分离且不开 Shell；Windows `.cmd` / `.bat` 被拒绝。普通 CI 永不启用真实 Provider。`basic` 是 Mock/真实 Provider 共用的 Smoke 子集；取消和故障例子要求脚本化协调，不能假定任意真实模型会匹配。

## 维护边界

Paseo 的公开 ACP Adapter 服务应用 Session/Timeline，而不是此处的原始协议判定；不深层导入或复制其代码。官方 ACP SDK 1.4.0（Apache-2.0）负责协议，Ajv（MIT）验证该 SDK 的公开方法 Schema，Zod（MIT）定义场景，YAML（ISC）负责配置解析。

延后完整 Replay、Fuzzing、广泛 Provider Matrix、ACP v2、认证流程、允许工具执行和富 DSL。现有 Torsor Adapter/Host 测试保持独立。
