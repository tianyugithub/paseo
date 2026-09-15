# 自建 Paseo Relay

把默认的 `relay.paseo.sh` 换成自己的域名，配对链接就不再依赖官方服务。

## 它是什么

relay 是**端到端加密的中转**：daemon 和客户端各连一条 WebSocket 上来，relay 只转发密文，
拿不到明文。所以自建不需要信任 Cloudflare 之外的东西 —— 加密密钥在两端，不在 relay。

部署形态是 **Cloudflare Worker + Durable Object**（每个会话一个 DO 实例，用 WebSocket
休眠控成本）。源码在 `packages/relay/src/cloudflare-adapter.ts`。

## 前提

- `llmzx.com` 已托管在 Cloudflare
- Cloudflare 账号已开通 **Workers**（Durable Objects 需要 Workers 付费版；SQLite 后端
  的 DO 在免费版可用，配置里已经用的是 `new_sqlite_classes`）

## 部署

在仓库根目录：

```bash
npx wrangler login          # 或者 export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config deploy/relay/wrangler.toml
```

首次 deploy 时 wrangler 会：

1. 创建 Worker
2. 为 `relay.llmzx.com` 建 DNS 记录并签发证书
3. 应用 Durable Object 迁移

## 接上 daemon

relay 起来后，在 daemon 的 `config.json` 里改 endpoint：

```json
{
  "daemon": {
    "relay": {
      "enabled": true,
      "endpoint": "relay.llmzx.com:443",
      "useTls": true
    }
  }
}
```

然后 `paseo daemon reload`（改 config.json 不用重启）。

确认生效：

```bash
paseo daemon status        # Relay 一行应显示 wss://relay.llmzx.com:443
paseo daemon pair          # offer 里的 relay.endpoint 应变成 relay.llmzx.com:443
```

## 验证真的走自己的 relay

配对链接里 `#offer=` 的 base64 解出来应该看到：

```json
{ "relay": { "endpoint": "relay.llmzx.com:443", "useTls": true } }
```

只要还是 `relay.paseo.sh` 就说明没生效。

## 不要设 `PASEO_RELAY_UPSTREAM`

上游 `packages/relay/wrangler.toml` 里有这一行：

```toml
PASEO_RELAY_UPSTREAM = "https://paseo-relay-next.fly.dev"
```

`cloudflare-adapter.ts` 开头是：

```ts
if (env.PASEO_RELAY_UPSTREAM) {
  return createCutoverProxy(env.PASEO_RELAY_UPSTREAM).fetch(request);
}
```

也就是说**设了它，Worker 会把流量整体转发给官方 relay**，你建的只是个空壳。
`deploy/relay/wrangler.toml` 刻意没有这一行。

## 回滚

daemon 侧改回默认即可（`relay.paseo.sh:443`），Workers 侧 `npx wrangler delete`。
