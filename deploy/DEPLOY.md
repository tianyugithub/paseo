# Paseo 自托管部署手册 — paseo.llmzx.com

目标：把 Paseo 全部指向自建服务器，**砍掉官方 relay / Hub**，Android / iOS / Mac 直连自己的域名。

---

## 一、现状（已实地核实）

### 服务器

| 项 | 值 |
|---|---|
| 地址 | `154.21.194.105:19958`（root，密钥 `~/.ssh/server_154_21_194_105`） |
| 系统 | Debian 12 bookworm，8 核 / 15G 内存 / 160G 磁盘（已用 65G） |
| ⚠️ 无 swap | 0B，跑重型构建有 OOM 风险 |
| 面板 | 宝塔 BT-Panel（18920），nginx vhost 在 `/www/server/panel/vhost/nginx/` |

### 这台机器**同时跑着生产服务**（改动务必小心）

`node.miapi.cc`（Xboard 面板，Docker，`127.0.0.1:7001`）、`agent.llmzx.com`（Docker，`5174`）、
MySQL / PostgreSQL / Redis、sub2api(3000)、BT-Panel(18920)、x11vnc+websockify(6080) 等。

**nginx 占用 80 / 443 / 888，不要动全局配置，只加 vhost。**

### 现有 Paseo 安装

| 项 | 值 |
|---|---|
| 代码位置 | `/opt/paseo`（**纯源码拷贝，不是 git 仓库**，文件属主 uid 502） |
| 版本 | **0.5.1**（上游已是 0.8.0，落后 3 个版本） |
| 服务 | systemd `paseo.service`，已跑 22 天 |
| `PASEO_HOME` | `/root/.paseo` |
| 监听 | `0.0.0.0:6767` |
| Node | `/www/server/nodejs/v24.18.0/bin/node` |
| relay | ❌ **开着**（`--relay` 标志 + `PASEO_RELAY_ENABLED=true`）→ 走官方 `relay.paseo.sh` |
| Web UI | ✅ 已开 |
| 认证 | `PASEO_PASSWORD`（在 `/root/.paseo-systemd.env`） |

### 已验证可用

```
curl http://127.0.0.1:6767/     → HTTP 200（Web UI）
curl /ws (Upgrade)              → HTTP 101（WebSocket 正常）
```

### 域名与证书

- `paseo.llmzx.com` → Cloudflare 代理（`172.67.170.109` / `104.21.28.84`）
- **nginx 里还没有 `paseo.llmzx.com` 的 vhost** ← 这是要补的
- 已有通配符证书 `*.llmzx.com`（Let's Encrypt，至 2026-10-17）→ **直接复用，无需签新证书**

---

## 二、目标架构

```
Android / iOS / Mac 客户端
        │  wss://paseo.llmzx.com/ws   （客户端内置 directTcp 直连模式）
        ▼
   Cloudflare  (TLS + WAF)
        │  HTTPS 回源
        ▼
   nginx :443  ──►  127.0.0.1:6767  Paseo daemon
                        └─ Web UI (自带)  + /ws
```

**官方 relay、Hub 全部不参与。** 客户端直连自己的域名即可 ——
`packages/app/src/types/host-connection.ts` 支持 `directTcp` / `directSocket` / `directPipe` / `relay` 四种模式，用第一种。

---

## 三、部署步骤

### 步骤 0：先备份（必做）

```bash
ssh -i ~/.ssh/server_154_21_194_105 -p 19958 root@154.21.194.105

cp /etc/systemd/system/paseo.service /root/paseo.service.bak.$(date +%F)
cp /root/.paseo/config.json        /root/paseo.config.json.bak.$(date +%F)
cp -r /www/server/panel/vhost/nginx /root/nginx-vhost-backup.$(date +%F)
```

### 步骤 1：装 nginx vhost

把 `deploy/paseo.llmzx.com.conf` 传到服务器：

```bash
scp -i ~/.ssh/server_154_21_194_105 -P 19958 \
  deploy/paseo.llmzx.com.conf \
  root@154.21.194.105:/www/server/panel/vhost/nginx/paseo.llmzx.com.conf
```

然后：

```bash
mkdir -p /www/wwwroot/paseo.llmzx.com
nginx -t                      # 必须先测试！
systemctl reload nginx
```

`nginx -t` 不通过就**不要 reload**，否则会影响同机其他线上站点。

### 步骤 2：本机验证（此时还没关 CF 限制）

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: paseo.llmzx.com' https://127.0.0.1/ -k
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: paseo.llmzx.com' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://127.0.0.1/ws -k
```

期望：`200` 和 `101`（本机回源已被 map 放行）。

### 步骤 3：改 systemd（关掉官方 relay + 指向自己的域名）

编辑 `/etc/systemd/system/paseo.service`：

**① ExecStart 里去掉 `--relay`**（必须删，CLI 标志优先级最高，留着它环境变量改不动）：

```diff
-ExecStart=/bin/bash -lc '... exec .../node /opt/paseo/packages/cli/bin/paseo daemon start --foreground --web-ui --relay --listen 0.0.0.0:6767 --home /root/.paseo'
+ExecStart=/bin/bash -lc '... exec .../node /opt/paseo/packages/cli/bin/paseo daemon start --foreground --web-ui --listen 0.0.0.0:6767 --home /root/.paseo'
```

**② `[Service]` 段补上环境变量：**

```ini
Environment=PASEO_RELAY_ENABLED=false
Environment=PASEO_APP_BASE_URL=https://paseo.llmzx.com
Environment=PASEO_CORS_ORIGINS=https://paseo.llmzx.com
```

> 💡 这里能用环境变量是因为 ExecStart 带了 `--foreground`。
> `packages/cli/src/commands/daemon/local-daemon.ts:59` 写的是
> `mode: options.foreground ? "deployment" : "managed"`，
> 只有 `deployment` 模式保留 `PASEO_*` 环境变量；`managed` 会全部删掉。
> **别把 `--foreground` 去掉。**

生效：

```bash
systemctl daemon-reload
systemctl restart paseo
systemctl status paseo --no-pager
```

### 步骤 4：验证

```bash
# relay 已关
tr '\0' '\n' < /proc/$(systemctl show -p MainPID --value paseo)/environ | grep PASEO_

# 外网访问
curl -s -o /dev/null -w '%{http_code}\n' https://paseo.llmzx.com/

# 确认没有连 relay.paseo.sh
ss -tnp | grep -i relay
```

### 步骤 5：客户端接入

Android / iOS / Mac 客户端里「添加主机」，填：

```
paseo.llmzx.com:443     （勾选 TLS）
密码：<PASEO_PASSWORD>
```

---

## 四、⚠️ 安全事项

1. **`PASEO_PASSWORD` 需要轮换。** 排查过程中该密码被读取并进入了本次会话日志。
   通过 `paseo daemon set-password` 或改 `/root/.paseo-systemd.env` 后 `systemctl restart paseo`，同时更新已连接客户端。
2. **直连源站防护**：vhost 里已按 `agent.llmzx.com` 的既有做法加了「只允许 CF 回源」的 map，
   非 CF 回源且非本机一律 403。这样源站 IP 泄露也无法绕过 WAF。
   调试期间如需 IP 直连，把 `if ($paseo_direct_block = 1)` 那两行注释掉再 reload。
3. `PASEO_HOME=/root/.paseo` 里存着 `daemon-keypair.json`、`server-id`、`cli-client-id`，
   权限已是 600，保持现状即可。
4. Cloudflare 侧建议确认 SSL 模式为 **Full (strict)**，避免回源明文。

---

## 五、后续：从 0.5.1 升到自己的 fork

当前服务器是 **0.5.1 的纯源码拷贝**，本地 clone 是 0.8.0。要二开需要：

1. 在本地把 0.8.0 改成自己的 fork（改品牌、加功能），推到自己的仓库
2. 服务器上把 `/opt/paseo` 换成 git 仓库：
   ```bash
   mv /opt/paseo /opt/paseo.0.5.1.bak
   git clone <你的仓库> /opt/paseo
   cd /opt/paseo && npm ci && npm run build:server
   ```
3. `/root/.paseo`（数据目录）**保留不动**，配置和会话历史都在里面

> ⚠️ 跨版本升级注意协议兼容：客户端 App 版本要和 daemon 对得上。
> 仓库的 `docs/protocol-compatibility.md` 说明了这个契约。
> 若手机端 App 还是 0.5.x，建议先把 App 一起升到 0.8.x 再换 daemon。

### 要改的官方地址（fork 时）

| 文件 | 内容 |
|---|---|
| `packages/app/src/desktop/updates/desktop-updates.ts:41` | `RELEASE_DOWNLOAD_BASE_URL` |
| `packages/app/src/changelog/internal/changelog-source.ts:4` | `CHANGELOG_URL` |

其余（relay / Hub / app base URL）全部已由上面步骤 3 的配置接管，不需要改代码。
