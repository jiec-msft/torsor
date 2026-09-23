# Torsor

> 简体中文（主要版本） | [English](README.md)

Torsor 是一个面向人与软件 Agent 持久协作的开源环境。

Agent 可以停止、重启或迁移到其他主机，而工作应当从持久状态继续。

> Agent 会变化，工作会延续。

## 为什么叫 Torsor？

在数学中，torsor 类似一个没有指定原点的空间：即使没有任何一点永久居于中心，各点之间的关系仍然有意义。

Torsor 将这一思想用于 Agent 协作。任何 Agent Session 都不应成为某个目标、决策或下一步行动不可替代的唯一所有者。

## 状态

Torsor 仍处于早期设计和实现阶段。第一个可工作切片将聚焦于：一个人通过持久工作状态协调可替换的 Agent Session。

## Quick start

### 前置条件

- Git
- Node.js **22.13 或更高版本**
- Node.js 自带的 npm

以下命令都从仓库根目录运行，已在 Windows PowerShell 验证；Node 命令在 POSIX Shell
中也可直接使用。

```powershell
npm ci
```

先运行聚焦的无凭据 Quick start 测试，或运行完整仓库验证：

```powershell
npm run test:quickstart
npm run ci
```

### 启动 Synthetic MVP

第一个终端：

```powershell
npm run quickstart:host
```

该命令构建 Server 及其依赖，并在 `http://127.0.0.1:4317` 启动只绑定本机的 Host。
它使用[完整合成 Bootstrap](examples/working-quickstart/bootstrap.json)、生产
`createLocalRuntimeHost` 组合路径和固定 `DeterministicFakeAdapter`，不需要模型、
模型凭据或网络，也不会改变生产 CLI 的 Provider 默认值。状态写入
`.torsor/quickstart`。可选 `--host` 参数只接受显式 Loopback 字面量
`127.0.0.1` 与 `::1`。

第二个终端运行已检查的最小 HTTP Journey：

```powershell
npm run quickstart:http
```

脚本检查 `/health`，用本地 Bearer `torsor-local-demo` 换取 HttpOnly Session Cookie
和 CSRF Token，读取 Bootstrap，创建目标为 `agent-orbit` 的 Thread，等待 Run 完成，
再读取 Run 和 Activity。动态 ID 来自真实响应，并写入
`.torsor/quickstart/last-run.json`。

在第一个终端按 `Ctrl+C`，重新运行 `npm run quickstart:host`，然后验证同一持久 Run：

```powershell
npm run quickstart:http -- --verify
```

需要非交互式监督时，可用 `npm run quickstart:host -- --shutdown-stdin` 启动，并向标准输入
写入一行 `shutdown`。该选择加入的控制会调用与信号处理相同的 HTTP/Runtime/Kernel
关闭路径；完成后进程输出 `Torsor synthetic quickstart stopped cleanly` 并以状态码 0
退出。

### Web 开发与本地静态预览

保持 Synthetic Host 运行。开发服务器将 `/api` 和 `/health` 代理到本机 Host：

```powershell
npm run dev:web
```

两个根级 Web 命令都会选择 `@torsor/web` Workspace，并把外层 `--` 后的可选 Vite 参数
转发给 Workspace Script。

打开 Vite 输出的 URL，使用本地 Token `torsor-local-demo`。若要检查构建后的静态文件，
使用同样仅面向本机 Smoke 的 Preview 代理：

```powershell
npm run build --workspace @torsor/web
npm run preview:web
```

`preview:web` 不是生产部署或生产反向代理。仓库当前不提供生产 Web Server；真实部署
必须自行以同源方式托管 `apps/web/dist` 并将 `/api` 代理到 Torsor Host。

### ACP 确定性 Mock

该命令启动独立 ACP v1 Mock，不需要模型、凭据或网络；用 `Ctrl+C` 停止：

```powershell
npm run build --workspace @torsor/acp-conformance
npm exec -- acp-conformance mock packages/acp-conformance/examples/basic.json
```

更完整的场景和真实 Provider 显式启用规则见
[ACP Conformance Quick start](packages/acp-conformance/README.zh-cn.md)。

## 文档

- [产品定义](docs/product.zh-cn.md) ([English](docs/product.md))
- [MVP 0.1 内核与交互原型](docs/prototype/001-overview.zh-cn.md) ([English](docs/prototype/001-overview.md))
- [独立 ACP Provider 一致性 Harness](packages/acp-conformance/README.zh-cn.md) ([English](packages/acp-conformance/README.md))
- [文档语言与配对策略](docs/documentation.zh-cn.md) ([English](docs/documentation.md))
- [公开内容策略](docs/public-content.zh-cn.md) ([English](docs/public-content.md))
- [贡献指南](CONTRIBUTING.zh-cn.md) ([English](CONTRIBUTING.md))
- [安全策略](SECURITY.zh-cn.md) ([English](SECURITY.md))

## Human Run 控件

在生产 Web 的 Run detail 中，`Cancel Run` 取消可操作 Run 的逻辑工作线；`Withdraw Input` 仅撤回你分配的 Pending 输入，不删除公开 Message。取消成功不代表 Provider 已物理停止或 Worktree 已安全释放；当前视图无法确认物理停止和 quarantine。响应未知时使用 `Retry same action`，不要新建替代请求。revision / conflict 拒绝后先刷新并审阅；重新认证或同一窗口重载后保留原身份恢复。已确认提交但读取失败时，使用控件内只读刷新。详见 [Human 控件规范](docs/prototype/001-overview.zh-cn.md#4421-human-cancel-和-withdraw-控件)。

## 许可证

Torsor 使用 Apache License 2.0。
