// DSH bridge 连通性验证：读 endpoint → TCP 连接 → initialize → ping / 目录查询
// 只读操作，不创建/修改任何会话。
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ep = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".dsh/agents-anywhere/bridge/endpoint.json"), "utf8"),
);

const sock = net.createConnection({ host: ep.host, port: ep.port });
let buf = "";
const pending = new Map();
let nextId = 1;

sock.setEncoding("utf8");
sock.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      // 服务端推送的通知
      console.log(`  [通知] ${msg.method}`);
    }
  }
});

function rpc(method, params, timeoutMs = 10000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`超时: ${method}`));
      }
    }, timeoutMs);
  });
}

sock.on("error", (e) => {
  console.error("连接失败:", e.message);
  process.exit(1);
});

sock.on("connect", async () => {
  console.log(`已连接 ${ep.host}:${ep.port}\n`);
  try {
    console.log("=== initialize ===");
    const init = await rpc("initialize", {
      authToken: ep.token,
      protocolVersion: "1.0",
      runtime: "dsh",
      connectorId: "paseo-probe-" + crypto.randomUUID(),
      sessionNamespace: "paseo-probe",
      clientInfo: { name: "paseo-bridge-probe", version: "0.0.1" },
    });
    console.log(JSON.stringify(init, null, 2).slice(0, 1500));

    console.log("\n=== ping ===");
    console.log(JSON.stringify(await rpc("ping", {})));

    console.log("\n=== runtime.getCapabilities ===");
    console.log(JSON.stringify(await rpc("runtime.getCapabilities", {}), null, 2).slice(0, 1200));

    console.log("\n=== catalog.listModels（前 3 个）===");
    const models = await rpc("catalog.listModels", {});
    const arr = Array.isArray(models) ? models : (models?.models ?? []);
    console.log(`共 ${arr.length} 个模型，前 3 个:`);
    console.log(JSON.stringify(arr.slice(0, 3), null, 2).slice(0, 900));

    console.log("\n=== session.list（前 2 条）===");
    const list = await rpc("session.list", {});
    const sessions = Array.isArray(list) ? list : (list?.sessions ?? []);
    console.log(`共 ${sessions.length} 个会话`);
    console.log(JSON.stringify(sessions.slice(0, 2), null, 2).slice(0, 1200));
  } catch (e) {
    console.error("RPC 失败:", e.message);
  } finally {
    sock.end();
    process.exit(0);
  }
});
