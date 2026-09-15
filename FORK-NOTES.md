# Paseo 自托管二开笔记

> 本文件是 fork 本地笔记，不随上游同步。基于 `getpaseo/paseo` v0.8.0（commit `7d74916`）审计。

## 目标

砍掉官方云依赖（`*.paseo.sh`），全部指向自建服务器；同时保留加自定义 Agent / 工具的能力。

## 结论先说

**好消息：把整套东西指向自建服务器，基本不需要改代码。**

daemon 已经把外部依赖做成了配置项，唯一必须动代码的只有 **2 处**（都是客户端侧的更新/更新日志地址，与核心功能无关）。

---

## 一、外呼审计表

| # | 外呼目标 | 默认地址 | 能否配置 | 说明 |
|---|---|---|---|---|
| 1 | **Relay**（远程访问通道） | `relay.paseo.sh:443` | ✅ 完全可控 | `PASEO_RELAY_ENDPOINT` / `PASEO_RELAY_ENABLED`。可自建，源码在 `packages/relay`，含 Cloudflare Worker 适配器。**也可以完全不用**（直连 / Tailscale / VPN）。新版默认 `enabled: false`。 |
| 2 | **Hub**（触发器编排层） | `https://hub.paseo.sh` | ✅ 完全可控 | `PASEO_HUB_URL`（CLI 侧 `DEFAULT_HUB_ORIGIN` 见 `packages/cli/src/commands/hub/authority.ts:16`）。**纯 opt-in**，`docs/hub.md` 明确「Running a daemon does not register it with a Hub」。 |
| 3 | **Web App 基址**（配对链接 + CORS） | `https://app.paseo.sh` | ✅ 完全可控 | `PASEO_APP_BASE_URL`（`config.ts:542`）+ `PASEO_CORS_ORIGINS`（`config.ts:417`）。指向自建 Web UI 即可。 |
| 4 | **Web UI 托管** | 官方 `app.paseo.sh` | ✅ 可自托管 | `PASEO_WEB_UI_ENABLED` / `PASEO_WEB_UI_DIST_DIR`，配合根目录 `npm run build:daemon-web-ui`。 |
| 5 | **Daemon 自更新** | npm registry | ⚠️ 可绕开 | `daemon-self-updater.ts`。只在用户主动触发时发生，不触发就不外呼。 |
| 6 | **桌面端自动更新** | `github.com/getpaseo/paseo/releases/download` | ❌ **硬编码** | `packages/app/src/desktop/updates/desktop-updates.ts:41`。**fork 必改**。 |
| 7 | **更新日志拉取** | `raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md` | ❌ **硬编码** | `packages/app/src/changelog/internal/changelog-source.ts:4`。仅 UI 展示，可改可删。 |
| 8 | **Docker 镜像** | `ghcr.io/getpaseo/paseo` | ❌ 硬编码 | `docker/docker-compose.example.yml:7`、`docker/Dockerfile.agents.example:8`。自己 build 即可。 |
| 9 | **遥测 / 分析** | 无 | — | ✅ **确认没有**。全仓搜 posthog/mixpanel/sentry/analytics 无生产代码命中（命中的都是本地语音 runtime 指标）。 |

### 必须改代码的清单（就这 3 个文件）

```
packages/app/src/desktop/updates/desktop-updates.ts:41     → RELEASE_DOWNLOAD_BASE_URL
packages/app/src/changelog/internal/changelog-source.ts:4  → CHANGELOG_URL
docker/docker-compose.example.yml:7                        → image（配置问题，非代码）
docker/Dockerfile.agents.example:8                         → FROM image
```

---

## 二、自托管配置

### 配置优先级（`config.ts`）

```
CLI flag  >  环境变量  >  $PASEO_HOME/config.json  >  内置默认值
```

### `$PASEO_HOME/config.json`

默认 `PASEO_HOME` = `~/.paseo`（Docker 里是 `/home/paseo`）。schema 严格（`.strict()`），**多写字段会报错**。

```json
{
  "version": 1,
  "daemon": {
    "listen": "0.0.0.0:6767",
    "cors": {
      "allowedOrigins": ["https://paseo.example.com"]
    },
    "relay": {
      "enabled": false
    }
  },
  "app": {
    "baseUrl": "https://paseo.example.com"
  }
}
```

字段定义见 `packages/server/src/server/persisted-config.ts:269-284`。

relay 自建时改成：

```json
"relay": {
  "enabled": true,
  "endpoint": "relay.example.com:443",
  "publicEndpoint": "relay.example.com:443",
  "useTls": true,
  "publicUseTls": true
}
```

### 环境变量版（Docker / 部署模式）

```bash
PASEO_PASSWORD=change-me                     # 认证，必设
PASEO_LISTEN=0.0.0.0:6767
PASEO_APP_BASE_URL=https://paseo.example.com
PASEO_CORS_ORIGINS=https://paseo.example.com
PASEO_HOSTNAMES=paseo.example.com,.lan       # 允许的 DNS 名
PASEO_ALLOWED_HOSTS=paseo.example.com
PASEO_TRUSTED_PROXIES=<反代 IP>              # 放在 nginx/caddy 后面时
PASEO_RELAY_ENABLED=false                    # 不用 relay 就关掉
PASEO_WEB_UI_ENABLED=true
PASEO_WEB_UI_DIST_DIR=/path/to/web-ui/dist
```

全部可用键见 `packages/server/src/server/config-environment.ts:3-58`。

---

## 三、⚠️ 最大的坑：managed 模式会清空环境变量

`packages/server/src/server/config-environment.ts:82-84`：

```ts
if (input.mode === "managed") {
  for (const key of DAEMON_SETTING_ENV_KEYS) delete env[key];
}
```

**桌面端（Electron）启动 daemon 时用的是 `mode: "managed"`**
（`packages/desktop/src/daemon/daemon-manager.ts:309`），
它会**删掉全部 `PASEO_*` 配置环境变量**。

含义：

- 用 **CLI / Docker / 裸机部署** → 环境变量生效 ✅
- 用 **桌面端 App** → 环境变量被吞，必须走 `$PASEO_HOME/config.json` ✅（配置文件不受影响）

所以自托管部署要做两件事：配好 `config.json`，**并且**别指望桌面端读环境变量。

---

## 四、Relay / Hub 怎么选

### Relay

只是「客户端连不上 daemon 时的加密中转」。判断标准：

- 服务器有公网 IP + 能开端口 → **直接不用 relay**（`enabled: false`），客户端直连
- 服务器在 NAT 后 / 想手机随时连 → 用 Tailscale 等 VPN，或自建 relay
- 要自建 → `packages/relay` 已开源，有 Cloudflare Worker 适配器（`cloudflare-adapter.ts`），无需改代码

### Hub

「触发器编排层」：让 GitHub / Slack / Discord / Linear 的事件自动拉起 agent。**与核心功能完全无关**，不需要就别装。

要的话，Hub 是**独立开源仓库**（`github.com/getpaseo/hub`，同为 Apache-2.0，v0.9.0），自建：

```bash
npx @getpaseo/hub                 # 内嵌 PGlite，http://localhost:3000
# 或
DATABASE_URL=postgres://... npx @getpaseo/hub
PASEO_HUB_URL=https://hub.example.com
```

自带 Dockerfile / compose.yml / fly.toml。

---

## 五、接自己的 Agent —— 不用 fork

两级方案，都不需要改核心代码：

### 1. ACP 协议接入（推荐）

任何实现了 [Agent Client Protocol](https://agentclientprotocol.com) 的 agent，直接写配置即可：

```json
{
  "agents": {
    "providers": {
      "my-agent": {
        "extends": "acp",
        "label": "My Agent",
        "command": ["my-agent-binary", "--acp"]
      }
    }
  }
}
```

App 里还内置了 ACP provider catalog（CodeWhale、Cursor、DeepAgents、Gemini CLI、Qwen Code、Kimi Code 等），选一下就能用，见 `docs/custom-providers.md:458`。

### 2. 插件（能力更强）

`paseo plugin init` 起一个受信任插件，能做：自定义 provider、workspace 面板、Command Center 命令、斜杠命令、timeline 条目、header 按钮、composer 药丸、主题、设置页、附件源，以及生命周期钩子（改配置 / 注入 MCP / 注入环境变量 / 决定工作区隔离 / 回合结束跟进 / 权限审批）。

现成例子在 `plugin-examples/`（13 个）。

> ⚠️ 插件**不受沙箱限制**：服务端代码以 daemon 用户权限运行。只装自己信得过的代码。

只有在「改 daemon 内部调度逻辑 / 改 wire 协议」时才需要 fork `packages/server`。

---

## 六、改动协议时的硬约束

如果确实要动 `packages/protocol`，注意仓库的强制契约（`docs/protocol-compatibility.md`）：

- 新增字段**必须可选**；不能删字段、不能收窄类型、不能变必填
- wire schema 必须是「纯」的：**禁用** `.transform()` / `.catch()` / `.preprocess()`
- 每个兼容垫片要打标签：`// COMPAT(name): added in vX, remove after <date>`
- 新 RPC 用点号命名空间 + 方向后缀：`domain.provider.operation.request` / `.response`

---

## 七、其他已知坑

| 坑 | 说明 |
|---|---|
| Node 版本 | `.tool-versions` 要求 **22.20.0**，本机是 24.16.0，需要 `mise install` 或 nvm 切换 |
| `CLAUDE.md` 已过时 | 文中说格式化用 **Biome**，实际是 **oxfmt + oxlint**（仓库里没有 `biome.json`，只有 `.oxfmtrc.json` / `.oxlintrc.json`）。别照着敲。 |
| 依赖体积 | `package-lock.json` 1.5MB，`npm ci` 较慢 |
| 发版设施绑上游 | fastlane、EAS、`ghcr.io/getpaseo/*`、Vercel、Fly —— fork 后需自行替换 |
| 上游迭代快 | CHANGELOG 已 184KB，fork 的长期 rebase 成本要提前算 |
| 商标 | Apache-2.0 §6：代码可自由使用/修改/商用，但**不能继续用 "Paseo" 名称和 logo**，白标必须改名 |

---

## 八、本机服务器的实际情况

已实地登入 `154.21.194.105`（密钥 `~/.ssh/server_154_21_194_105`，端口 19958）核查，结论与上面的通用方案有出入，**具体部署请看 [`deploy/DEPLOY.md`](deploy/DEPLOY.md)**：

- 服务器上 **Paseo 已经装好并在跑**（systemd `paseo.service`，已运行 22 天），不是全新部署
- 代码在 `/opt/paseo`，**版本 0.5.1**，且是**纯源码拷贝、不是 git 仓库**
- **官方 relay 目前是开着的**（`--relay` 标志），这次要关掉
- `paseo.llmzx.com` DNS 已指向 Cloudflare，但 **nginx 还没有对应 vhost**
- 已有通配符证书 `*.llmzx.com` 可直接复用
- ⚠️ 这台机器同时跑着 Xboard 面板等**生产服务**，nginx 占着 80/443/888，只能加 vhost、不能动全局
- ✅ ExecStart 带 `--foreground` ⇒ `deployment` 模式 ⇒ **环境变量不会被清空**，配置走 systemd env 即可

## 九、建议的落地顺序

1. **切 Node 22** → `npm ci` → `npm run build:server`，先把基线跑通
2. 跑 `npm run dev:server`，确认 daemon 能在本地起
3. 写 `$PASEO_HOME/config.json`，把 `app.baseUrl` / `cors.allowedOrigins` 指向自建域名
4. 决定 relay 取舍 → 要么关，要么自建
5. 改上面那 3 个文件的官方地址
6. 自建前端域名 + 反代（注意 `PASEO_TRUSTED_PROXIES`）
7. 最后再做业务功能扩展（优先插件，其次 ACP provider）
