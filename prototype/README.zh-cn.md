# Torsor Chat 原型

> 简体中文（主要版本） | [English](README.md)

这是一个本地探索原型，用于研究一个部署者如何通过持久工作状态协调多个可替换的软件 Agent Session。

它是一个使用确定性内存状态的小型 React 应用。它不是生产架构，也不包含后端、认证、持久化或外部集成。

该原型用于交互探索。你可以切换 Workstream 和 Agent 对话、搜索本地工作、发送确定性 Message 和 Response、创建 Task 和 Workstream、检查 Artifact 与 Authority、重试 Run、Review Result，以及协调不确定的外部影响。

## 当前设计基线

这个 React 应用记录了较早的可执行探索。已接受的 MVP 0.1 内核、桌面交互模型和无依赖设计原型见 [MVP 0.1 设计基线](../docs/prototype/001-overview.zh-cn.md)及其[英文版本](../docs/prototype/001-overview.md)。

下一实现切片在替换或复用该探索中的行为时，应以该基线为准。

## 本地运行

```sh
npm install
npm run dev
```

打开 Vite 输出的本地 URL。

## 验证

```sh
npm test
npm run build
```

测试通过公开 Workspace 界面覆盖持久状态转换，包括：提升前的编辑失效、不可变的已提升 Message 来源、与来源关联的 Decision 和 Task、对话局部的 Composer 状态、确定性搜索目的地、原子的 Agent 生命周期变化、失败和重试的 Run，以及 Human Approval。
