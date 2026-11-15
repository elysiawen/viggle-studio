#!/usr/bin/env node
/**
 * 客户机续期助手
 *
 * 只跑在客户机（有图形界面、能上 viggle.ai 的那台电脑）上，监听 127.0.0.1:3021。
 * 网页「账号编辑 → 保存并续期」点下去之后，由它接管：
 *   1. 用访问密码登录内网服务，取该账号的登录邮箱 / 密码
 *   2. 启动（或复用）Chrome，自动切到邮箱登录并填好账密
 *   3. 用户在窗口里点「登录」+ 过 Verify you are human
 *   4. 抓到 localStorage.viggleToken，PATCH 回服务端
 *
 * 位置：项目根的 tool/，与同目录的 chrome-cdp.mjs 一起构成完整工具
 *
 * 用法：
 *   node renew-agent.mjs              # 或直接双击同目录的 renew-agent.bat
 *   node renew-agent.mjs --server http://192.168.50.100:3020 --access-password ******
 *   node renew-agent.mjs --port 3021  # 换本地监听端口（网页端固定读 3021）
 *
 * 配置会存到同目录的 renew-agent.json（含访问密码，别提交 git）。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  Cdp,
  decodeJwt,
  fillLoginForm,
  launchChrome,
  portHasChrome,
  prepareRelogin,
  sleep,
  waitForPageTarget,
} from "./chrome-cdp.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(HERE, "renew-agent.json");
const LOGIN_URL = "https://viggle.ai/meme/app/zh-CN/login";
const DEBUG_PORT = 9222;
const AUTH_COOKIE = "viggle_access";
/** 用户在 Chrome 里手动点登录 + 过验证，给足 20 分钟 */
const WAIT_LOGIN_MS = 20 * 60 * 1000;

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    switch (key) {
      case "--server": args.server = next(); break;
      case "--access-password": args.accessPassword = next(); break;
      case "--port": args.port = Number(next()); break;
      default:
        if (key.startsWith("--")) {
          console.error(`未知参数：${key}`);
          process.exit(2);
        }
    }
  }
  return args;
}

/* ------------------------------- 配置 ------------------------------- */

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    console.error(`× ${CONFIG_FILE} 不是合法 JSON，请删掉重来`);
    process.exit(1);
  }
}

async function ensureConfig(args) {
  const config = { ...loadConfig(), ...Object.fromEntries(Object.entries(args).filter(([, v]) => v)) };
  if (config.server && config.accessPassword) return config;

  console.log("· 第一次运行，需要填两个值（会存到 renew-agent.json）");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (!config.server) {
      const answer = await rl.question("  内网服务地址（例如 http://192.168.50.100:3020）：");
      config.server = answer.trim() || "http://192.168.50.100:3020";
    }
    if (!config.accessPassword) {
      config.accessPassword = (await rl.question("  访问密码（项目里设置的 ACCESS_PASSWORD）：")).trim();
    }
  } finally {
    rl.close();
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
  console.log(`  已保存到 ${CONFIG_FILE}`);
  return config;
}

/* --------------------------- 服务端 API --------------------------- */

const baseUrl = (config) => String(config.server).replace(/\/+$/, "");

async function serverLogin(config) {
  const res = await fetch(`${baseUrl(config)}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: config.accessPassword }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`服务端登录失败：${body?.error?.message ?? `HTTP ${res.status}`}（检查 accessPassword）`);
  }
  if (body.enabled === false) return "";
  const jar = res.headers.getSetCookie?.() ?? [];
  const line = jar.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  if (!line) throw new Error("服务端没返回 viggle_access cookie");
  return line.slice(AUTH_COOKIE.length + 1).split(";")[0];
}

async function serverCall(config, cookie, path, init = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `${AUTH_COOKIE}=${cookie}`;
  const res = await fetch(`${baseUrl(config)}${path}`, { ...init, headers });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(`${path} 失败：${body?.error?.code ?? res.status} ${body?.error?.message ?? ""}`);
  }
  return body.data;
}

/* ------------------------------ 浏览器 ------------------------------ */

const isJwt = (v) => typeof v === "string" && v.split(".").length === 3 && v.length > 32;

async function openChrome() {
  if (await portHasChrome(DEBUG_PORT)) {
    console.log("· 复用已开着调试端口的 Chrome");
    const target = await waitForPageTarget(DEBUG_PORT, 15_000);
    return { cdp: await new Cdp(target.webSocketDebuggerUrl).connect(), launched: false };
  }
  console.log("· 启动 Chrome 并打开登录页");
  launchChrome({ port: DEBUG_PORT, url: LOGIN_URL, headless: false });
  const target = await waitForPageTarget(DEBUG_PORT);
  return { cdp: await new Cdp(target.webSocketDebuggerUrl).connect(), launched: true };
}

async function waitForToken(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await cdp
      .evaluate(
        "(() => { try { return JSON.parse(localStorage.getItem('viggleToken') ?? 'null'); } catch { return localStorage.getItem('viggleToken'); } })()",
        10_000
      )
      .catch(() => null);
    if (isJwt(token)) return token;
    await sleep(1000);
  }
  return null;
}

/* ------------------------------ 任务状态 ------------------------------ */

let current = { state: "idle", accountId: null, message: "等待续期请求", startedAt: null, finishedAt: null };

function setState(patch) {
  current = { ...current, ...patch };
  console.log(`· [${current.state}] ${current.message}`);
}

async function runRenew(config, cookie, accountId) {
  setState({ state: "running", accountId, message: "正在读取账号凭据…", startedAt: new Date().toISOString(), finishedAt: null });
  const creds = await serverCall(config, cookie, `/api/accounts/${accountId}/credentials`);
  if (!creds.loginEmail || !creds.password) {
    throw new Error("该账号还没保存登录邮箱/密码，请先在「编辑账号」里填写并保存");
  }

  console.log(`  账号：${creds.label} <${creds.loginEmail}>`);
  setState({ message: `开始续期：${creds.loginEmail}`, accountId });

  const { cdp } = await openChrome();
  try {
    setState({ message: `正在准备登录页（${creds.loginEmail}）…` });
    await prepareRelogin(cdp, LOGIN_URL);

    setState({ message: `正在填写 ${creds.loginEmail} 的账号密码…` });
    const filled = await fillLoginForm(cdp, creds.loginEmail, creds.password);
    if (!filled?.ok) throw new Error(`自动填表失败：${filled?.reason ?? "未知原因"}`);

    console.log(`  已填好：${creds.loginEmail}`);
    setState({ message: `请在弹出的 Chrome 里用 ${creds.loginEmail} 点「登录」并完成 Verify you are human` });
    const token = await waitForToken(cdp, WAIT_LOGIN_MS);
    if (!token) throw new Error("等待登录超时（20 分钟），没有抓到 token");

    setState({ message: "已拿到 token，正在写回服务端…" });
    await serverCall(config, cookie, `/api/accounts/${accountId}`, {
      method: "PATCH",
      body: JSON.stringify({ token }),
    });
    const info = decodeJwt(token);
    const days = info?.remainingDays ?? "?";

    // 写回后立刻用新 token 打一次上游：把 status / 昵称 / 额度一起刷新，
    // 免得界面停在「未校验」，也顺便验证这个 token 真能用。
    setState({ message: "正在用新 token 校验…" });
    let checkNote = "";
    try {
      const { profile } = await serverCall(config, cookie, `/api/accounts/${accountId}/verify`, {
        method: "POST",
        body: "{}",
      });
      checkNote = profile?.nickname ? `，已校验（${profile.nickname}）` : "，已校验通过";
    } catch (err) {
      checkNote = `，但校验没通过：${err instanceof Error ? err.message : String(err)}`;
    }

    setState({
      state: "done",
      message: `${creds.loginEmail} 续期成功，剩余 ${days} 天${checkNote}`,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    cdp.close();
  }
}

/* ------------------------------ HTTP ------------------------------ */

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chrome 私有网络访问（公网/私网页面 → 127.0.0.1）需要这个响应头
    "access-control-allow-private-network": "true",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((ok) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        ok(JSON.parse(raw || "{}"));
      } catch {
        ok({});
      }
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await ensureConfig(args);
  const port = args.port ?? Number(process.env.AGENT_PORT ?? 3021);

  console.log("");
  console.log("=== Viggle 续期助手 ===");
  console.log(`服务地址：${config.server}`);
  console.log(`本地监听：http://127.0.0.1:${port}`);
  console.log("用法：在账号卡片点「续期」（可多选后批量续期），这个窗口不要关。");
  console.log("按 Ctrl+C 退出。");
  console.log("");

  let cookie = null;
  /** 批量续期：账号排队，串行处理，一个弄完自动接下一个 */
  const queue = [];
  let draining = false;

  async function drainQueue() {
    if (draining) return;
    draining = true;
    let done = 0;
    let failed = 0;
    try {
      while (queue.length) {
        const accountId = queue.shift();
        try {
          if (!cookie) cookie = await serverLogin(config);
          await runRenew(config, cookie, accountId);
          done += 1;
        } catch (err) {
          // cookie 可能是过期/被改密码，下次重登
          cookie = null;
          failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          setState({ state: "failed", message, finishedAt: new Date().toISOString() });
        }
      }
      setState({
        state: failed ? "failed" : "done",
        message: `队列处理完毕：成功 ${done} 个${failed ? `，失败 ${failed} 个` : ""}`,
        finishedAt: new Date().toISOString(),
      });
    } finally {
      draining = false;
    }
  }

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-allow-private-network": "true",
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      sendJson(res, 200, {
        ok: true,
        agent: "viggle-renew",
        server: config.server,
        status: current,
        pending: queue.length,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/status") {
      sendJson(res, 200, { ok: true, status: current, pending: queue.length });
      return;
    }

    if (req.method === "POST" && url.pathname === "/renew") {
      const body = await readBody(req);
      // 支持单个 accountId 和批量 accountIds，统一进队列
      const ids = (Array.isArray(body.accountIds) ? body.accountIds : body.accountId ? [body.accountId] : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean);
      if (!ids.length) {
        sendJson(res, 400, { ok: false, error: "缺少 accountId / accountIds" });
        return;
      }

      queue.push(...ids);
      setState({
        state: draining ? current.state : "queued",
        message: `已加入队列 ${ids.length} 个，待处理 ${queue.length} 个`,
      });
      sendJson(res, 202, { ok: true, queued: ids.length, pending: queue.length });
      void drainQueue();
      return;
    }

    sendJson(res, 404, { ok: false, error: "未知路径" });
  });

  server.on("error", (err) => {
    if (err?.code === "EADDRINUSE") {
      console.error(`× 端口 ${port} 已被占用：可能已经开着一个续期助手窗口了，直接用它即可`);
    } else {
      console.error("× 本地服务启动失败：", err.message);
    }
    process.exitCode = 1;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`· 已就绪，等待网页点「保存并续期」…`);
  });
}

main().catch((err) => {
  console.error("× 失败：", err instanceof Error ? err.message : err);
  spawn("cmd", ["/c", "pause"], { stdio: "inherit" }).on("error", () => {});
  process.exitCode = 1;
});
