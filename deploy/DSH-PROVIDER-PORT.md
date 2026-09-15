# DSH Provider 移植方案（Agents-Anywhere bridge → Paseo 插件）

> 目标：把 Agents-Anywhere 的 DSH 接入方式移植进 Paseo，让 DSH 出现在 Paseo 的 Providers 页面。
> 路线：**复用 DSH bridge，写成 Paseo 插件**（不走 ACP）。

---

## 一、先回答"要不要建分支"

**不需要。** 三条理由：

1. **Paseo 的 Providers 页面是纯动态的。** `packages/app/src/utils/provider-definitions.ts` 没有任何硬编码 provider 列表，
   直接遍历 daemon 返回的 `ProviderSnapshotEntry[]`。
2. **插件贡献的 provider 会被合并进这个 snapshot。**
   `provider-snapshot-manager.ts:284`：`this.providerClients = { ...this.extraClients, ...this.pluginProviders.clients() }`。
3. **插件是独立项目，不是 Paseo 的分支。** 它有自己的目录/仓库，用 `paseo plugin install <dir|git>` 装。
   你自己的仓库随便建分支，跟 Paseo 主干无关。

只有要改 Paseo 核心（timeline 投影、permission 语义、wire 协议）时才需要 fork Paseo 本身。

---

## 二、现状核实（已实测，非推测）

### DSH 侧：bridge 正在运行，不用装任何东西

```
endpoint:  ~/.dsh/agents-anywhere/bridge/endpoint.json
进程:      PID 72818 = DSH Desktop Helper（已跑 7.5h）
监听:      127.0.0.1:58278
```

`@agents-anywhere/dsh-bridge-next` 是 DSH Desktop 的**直接依赖**，跑在 DSH 进程内。

### 实测握手成功

```
initialize → {
  identity: { runtime: "dsh", runtimeVersion: "0.1.5-rc.2",
              bridgeVersion: "0.1.0-dev.0", protocolVersion: "1.0",
              displayName: "DeepSeek Harness" },
  storage: { mode: "dsh-native", sameSessionWriterLimit: 1 },
  features: { attachments: true, sessionDiscovery: true, approval: true,
              userQuestions: true, snapshotPagination: true,
              syncMode: "events", projectionVersion: 2 }
}
ping → { ok: true }
```

`session.list` 返回 **7 个真实会话**（带 title / cwd / metadata），
`catalog.listModels` 返回模型 + reasoning effort 选项。

### 协议契约

| 项 | 值 |
|---|---|
| 传输 | 回环 TCP（`127.0.0.1`，随机端口） |
| 鉴权 | `endpoint.json` 里的 `token`（43 字符），随 `initialize.authToken` 发送 |
| 协议 | JSON-RPC 2.0，**换行分隔**（JSON Lines），UTF-8，单帧上限 8 MiB |
| 版本 | `protocolVersion: "1.0"`，`projectionVersion: 2` |

**RPC 方法表**（从 `router.ts` 提取）：

```
runtime.sync.subscribe / .ack / .unsubscribe / .refresh
runtime.getConfig / .getCapabilities
session.createAndStart / .startTurn / .list / .getSnapshot / .getState
session.getCapabilities / .getNotices / .updateSelections / .interrupt
session.readSubagent / .sendSubagent / .respondInteraction
catalog.listModels / .listPermissions / .listAgentPresets
workspace.list
ping
```

### 关键利好：timeline 已经归一化

`session.getSnapshot` 返回的是**provider 中立的通用结构**，不是 DSH 私有格式：

```json
{
  "sessionId": "...", "externalSessionId": "...", "runtime": "dsh",
  "items": [{
    "id": "dsh_4f38...", "type": "tool", "status": "done", "role": "assistant",
    "turnId": "dsh_02c0...", "orderSeq": 3439000, "revision": 8889,
    "contentHash": "sha256:ffcc...",
    "content": { "kind": "command", "title": "bash", "toolName": "bash",
                 "input": {...}, "callId": "call_...", "isError": false, "output": "..." }
  }],
  "complete": true, "snapshotComplete": true, "nextCursor": ..., "watermark": ..., "metadata": {...}
}
```

**这意味着移植不用碰 DSH 内部结构**，只需把这个形状映射到 Paseo 的 `ProviderTimelineItem`。

---

## 三、移植工作量分解

参考实现（Python，共 ~2475 行）→ Paseo 插件（TypeScript）：

| # | 模块 | 参考 | 预估 TS | 性质 |
|---|---|---|---|---|
| 1 | Bridge 客户端（发现/连接/鉴权/JSON-RPC/分帧） | `bridge/client.py` (336) | ~350 | **机械移植** |
| 2 | 事件同步消费（subscribe/ack/批次） | `bridge/sync.py` (319) | ~350 | 机械移植 |
| 3 | Bridge DTO 类型 | `bridge/models.py` (460) | ~300 | 类型定义 |
| 4 | 目录映射（模型/权限/预设） | `provider.py` (246) | ~200 | 直接映射 |
| 5 | **投影层**：bridge item → `ProviderTimelineItem` | `runtime.py` (660) | ~500 | **需设计** |
| 6 | Provider 门面（`ProviderRegistration`/`ProviderConnection`） | `runtime.py` | ~400 | **需设计** |
| 7 | 插件脚手架（manifest + entries） | `provider-direct` 例子 | ~100 | 照抄 |

**合计约 2000–2200 行 TypeScript。**

真正需要动脑的是 #5 和 #6 —— 因为要跨两个不同的抽象：

**Paseo 的 `ProviderEvent`（输出侧）：**
```
catalog / sessions / request.completed / request.failed
session.opened / .ready / .closed / .runtime_failed / .persistence
session.prompt_result / .turn / .usage / .config / .commands
session.permission / .permission_resolved / .notice
timeline.item
```

**bridge 的等价物：** `session.getSnapshot` / `session.getState` / `runtime.sync.*` 通知 / `session.respondInteraction`。

好消息是两边都是事件驱动 + 归一化 item，映射是**同构的**，不是范式转换。

---

## 四、⚠️ 必须先解决的一个架构约束

**bridge 只监听 `127.0.0.1`。** 这意味着：

```
DSH Desktop（Mac）  ←─ 只有同机可连 ─←  Paseo daemon
```

**Paseo daemon 必须和 DSH Desktop 跑在同一台机器上。**

这对你现在的规划是个冲突：计划里 Paseo 部署在服务器 `154.21.194.105`，而 DSH Desktop 在这台 Mac 上。
服务器上的 Paseo **连不到** Mac 上的 bridge。

三个选项：

| 方案 | 说明 | 代价 |
|---|---|---|
| **A. Paseo 也跑在 Mac 上** | 本机 Paseo + 本机 DSH，bridge 直连 | 最简单；手机通过域名连 Mac 上的 daemon |
| **B. SSH 隧道** | 服务器 Paseo 通过隧道访问 Mac 的 bridge 端口 | 需要反向隧道常驻，拓扑脆弱 |
| **C. 在服务器上跑 headless DSH** | 服务器装 DSH CLI，让 bridge 在 Linux 上跑 | 需要确认 DSH CLI 在 Linux 能加载 bridge 插件；DSH Desktop 是 Electron GUI，服务器无桌面 |

**建议先走 A**，把 provider 跑通验证；之后再决定要不要为服务器场景做 B/C。

---

## 五、建议的实施顺序

1. **搭插件骨架** —— 照 `plugin-examples/provider-direct` 建目录，`server.registerProvider()` 注册一个空 provider，
   确认 Providers 页面能出现 "DeepSeek Harness"
2. **移植 Bridge 客户端**（模块 1+2）—— 用 `tools/dsh-bridge-probe.mjs` 当参考，先打通 `initialize` + `ping`
3. **接目录**（模块 4）—— 模型列表出现在 Paseo 的模型选择器里
4. **接会话列表**（`session.list`）—— 能看到 DSH 已有的 7 个会话
5. **接 timeline 投影**（模块 5）—— 最难，但 bridge 已归一化，先做文本 + 工具调用两类
6. **接发送与中断**（`session.createAndStart` / `startTurn` / `interrupt`）
7. **接权限与提问**（`session.respondInteraction`）

---

## 六、现成可用的调试工具

| 文件 | 用途 |
|---|---|
| `tools/dsh-bridge-probe.mjs` | 连通性验证：initialize / ping / capabilities / 模型目录 / 会话列表 |
| `tools/dsh-snapshot-probe.mjs` | 拉取指定会话的 timeline 快照，用于对照 projection 映射 |

两个脚本都从 `endpoint.json` 读 token，**不硬编码任何凭据**，且只做只读调用。

运行：

```bash
node tools/dsh-bridge-probe.mjs
node tools/dsh-snapshot-probe.mjs
```

---

## 七、参考资料坐标（Agents-Anywhere 仓库）

| 内容 | 路径 |
|---|---|
| Bridge 传输/鉴权/分帧 | `connector/connector/runtimes/dsh/bridge/client.py` |
| 事件同步 | `connector/connector/runtimes/dsh/bridge/sync.py` |
| DTO 定义 | `connector/connector/runtimes/dsh/bridge/models.py` |
| 投影 adapter | `connector/connector/runtimes/dsh/runtime.py` |
| 端点路径约定 | `connector/connector/runtimes/dsh/provider_config.py:113` |
| Bridge 服务端（DSH 侧） | `dsh-bridge-next/src/host/dsh-runtime/server.ts` |
| RPC 路由（方法表真源） | `dsh-bridge-next/src/host/dsh-runtime/router.ts` |
