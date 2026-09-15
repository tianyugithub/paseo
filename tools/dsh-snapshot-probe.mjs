import net from "node:net"; import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
const ep = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".dsh/agents-anywhere/bridge/endpoint.json"), "utf8"));
const sock = net.createConnection({ host: ep.host, port: ep.port });
let buf = "", nextId = 1; const pending = new Map();
sock.setEncoding("utf8");
sock.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
  const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } } });
function rpc(method, params, t = 15000) { const id = nextId++; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("超时 " + method)); } }, t); }); }
sock.on("connect", async () => { try {
  await rpc("initialize", { authToken: ep.token, protocolVersion: "1.0", runtime: "dsh", connectorId: "probe-" + crypto.randomUUID(), sessionNamespace: "paseo-probe", clientInfo: { name: "probe", version: "0" } });
  const list = await rpc("session.list", {}); const sessions = Array.isArray(list) ? list : (list?.sessions ?? []);
  const target = sessions[0]; console.log("目标会话:", target.sessionId, "|", target.title, "\n");
  const snap = await rpc("session.getSnapshot", { sessionId: target.sessionId, limit: 5 });
  console.log("=== snapshot 顶层字段 ==="); console.log(Object.keys(snap).join(", "));
  console.log("\n=== 前 3 条 timeline item ===");
  const items = snap.items ?? snap.events ?? snap.timeline ?? [];
  console.log(JSON.stringify(items.slice(0, 3), null, 2).slice(0, 2200));
} catch (e) { console.error("失败:", e.message); } finally { sock.end(); process.exit(0); } });
sock.on("error", (e) => { console.error("连接失败:", e.message); process.exit(1); });
