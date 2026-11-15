#!/usr/bin/env node
/**
 * 浏览器自动化底座：借真实 Chrome（CDP）读取 viggle.ai 的 localStorage.viggleToken
 * 既能单独跑（下面有用法），也被同目录的 renew-agent.mjs 复用。
 *
 * 为什么这样做：Turnstile 的 sitekey 绑定 viggle.ai 域名，只有真实浏览器在
 * 该域名下登录才能拿到 token。所以让用户在真实 Chrome 里登录一次（验证码可以
 * 手动过），脚本只在旁边等 localStorage 里出现 token，然后打印出来。
 *
 * 零依赖：只用 Node 20+ 自带的 fetch / WebSocket，不装任何包。
 *
 * 用法：
 *   node chrome-cdp.mjs --account 邮箱 --password 密码
 *       打开 Chrome → 自动切到邮箱登录 → 自动填账号密码 →
 *       你只需要点「登录」并过一下 Verify you are human，剩下交给脚本
 *
 *   node chrome-cdp.mjs --accounts-file accounts.json   # 多个账号，逐个填
 *   node chrome-cdp.mjs --port 9223         # 换调试端口（被占用时会自动加 1）
 *   node chrome-cdp.mjs --login-url https://viggle.ai/meme/app/zh-CN/login
 *   node chrome-cdp.mjs --timeout 1800      # 最长等待秒数，默认 1800
 *   node chrome-cdp.mjs --out token.json    # 结果写到指定文件（默认 out/token.json）
 *   node chrome-cdp.mjs --self-test         # 只验证 Chrome + CDP 链路（headless，不弹窗）
 *   node chrome-cdp.mjs --attach            # 复用已经开着调试端口的 Chrome（不再新开）
 *
 * 抓到 token 后直接写进远端（或本机）的 Viggle Studio 服务：
 *   node chrome-cdp.mjs --account 邮箱 --password 密码 --push http://127.0.0.1:3000 --access-password 访问密码 --label siher
 *   node chrome-cdp.mjs --from-file out/token.json --push http://127.0.0.1:3000 --access-password 访问密码 --label siher
 *
 *   --push <baseUrl>       服务地址；服务端在 Linux 服务器时，用 SSH 隧道即可，无需对外开放端口：
 *                          ssh -N -L 3000:127.0.0.1:3000 root@服务器
 *   --access-password <pw> 服务端 ACCESS_PASSWORD，脚本会自动登录换 cookie（不用手动复制）
 *   --cookie <value>       viggle_access 的值（也可以放环境变量 VIGGLE_ACCESS_COOKIE）
 *   --label <关键词>        按账号 label / email / nickname 模糊匹配目标账号
 *   --account-id <id>      已知账号 uuid 时可直接指定，跳过匹配
 *   --from-file <path>     只推送已经抓到的 token，不启动 Chrome
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "https://viggle.ai/meme/app/zh-CN/login";

/* ------------------------------- 参数 ------------------------------- */

function parseArgs(argv) {
  const args = { port: 9222, timeout: 1800, out: "out/token.json", attach: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => argv[++i];
    switch (key) {
      case "--port": args.port = Number(next()); break;
      case "--timeout": args.timeout = Number(next()); break;
      case "--out": args.out = next(); break;
      case "--login-url": args.loginUrl = next(); break;
      case "--profile": args.profile = next(); break;
      case "--attach": args.attach = true; break;
      case "--self-test": args.selfTest = true; break;
      case "--account": args.account = next(); break;
      case "--password": args.password = next(); break;
      case "--accounts-file": args.accountsFile = next(); break;
      case "--push": args.push = next(); break;
      case "--cookie": args.cookie = next(); break;
      case "--access-password": args.accessPassword = next(); break;
      case "--from-file": args.fromFile = next(); break;
      case "--label": args.label = next(); break;
      case "--account-id": args.accountId = next(); break;
      default:
        if (key.startsWith("--")) {
          console.error(`未知参数：${key}`);
          process.exit(2);
        }
    }
  }
  args.loginUrl ??= DEFAULT_URL;
  return args;
}

/* ---------------------------- Chrome 定位 ---------------------------- */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (p && existsSync(p)) return p;
  }
  throw new Error("找不到 Chrome/Edge，请用 --chrome 或环境变量 CHROME_PATH 指定可执行文件");
}

/* ------------------------------ CDP 客户端 ------------------------------ */

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
    });
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
    return this;
  }

  send(method, params = {}, timeoutMs = 15_000) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, (msg) => {
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`${method} 超时`));
        }
      }, timeoutMs);
    });
  }

  /** 在页面里执行表达式并取回值 */
  async evaluate(expression, timeoutMs = 15_000) {
    const r = await this.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "页面执行异常");
    return r.result?.value;
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------ 启动 Chrome ------------------------------ */

export function launchChrome({ port, url, headless, profile }) {
  const bin = findChrome();
  const userDataDir = profile ?? resolve(HERE, "chrome-profile");
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    url,
  ];
  if (headless) args.unshift("--headless=new");
  const child = spawn(bin, args, { stdio: "ignore", detached: false });
  child.on("error", (err) => console.error("Chrome 启动失败：", err.message));
  return { child, bin, userDataDir };
}

/** 端口上已经有别的 Chrome（比如 chrome-devtools-mcp 那个）时，直接连过去会读错页面 */
export async function portHasChrome(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function findFreePort(start) {
  for (let p = start; p < start + 20; p += 1) {
    if (!(await portHasChrome(p))) return p;
  }
  throw new Error(`从 ${start} 起找不到可用的调试端口，请先关掉多余的 Chrome 或用 --port 指定`);
}

/** 等调试端口就绪，返回页面 target */
export async function waitForPageTarget(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const pages = list.filter((t) => t.type === "page");
      // 优先挑已经在 viggle.ai 上的页面，其次任意页面
      const pick = pages.find((t) => t.url.includes("viggle.ai")) ?? pages[0];
      if (pick?.webSocketDebuggerUrl) return pick;
    } catch {
      // 端口还没起来，继续等
    }
    await sleep(300);
  }
  throw new Error(`等待 Chrome 调试端口 ${port} 超时`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ JWT 解析 ------------------------------ */

export function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const decode = (seg) => {
    const pad = seg.length % 4 === 0 ? "" : "=".repeat(4 - (seg.length % 4));
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  };
  try {
    const payload = decode(parts[1]);
    const exp = typeof payload.exp === "number" ? payload.exp : null;
    return {
      payload,
      exp,
      expiresAt: exp ? new Date(exp * 1000) : null,
      remainingDays: exp ? Math.round(((exp * 1000 - Date.now()) / 86_400_000) * 10) / 10 : null,
    };
  } catch {
    return null;
  }
}

/* --------------------------- 自动填表 --------------------------- */

/** 账号可以从 --account/--password 传，也可以复用 accounts.json（取第一条） */
function resolveLogin(args) {
  if (args.account) return { account: args.account, password: args.password ?? "" };
  if (args.accountsFile) {
    const file = resolve(HERE, args.accountsFile);
    const rows = JSON.parse(readFileSync(file, "utf8"));
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row) return { account: row.account ?? row.email, password: row.password ?? row.passwd ?? "" };
  }
  return null;
}

/**
 * 在登录页里自动完成「切到邮箱登录 + 填账号密码」。
 * 点「登录」和过 Verify you are human 留给用户，脚本只在旁边等 token 出现。
 * React 受控输入必须走原生 value setter + input 事件，直接赋 value 不会进表单状态。
 */
export async function fillLoginForm(cdp, account, password) {
  const expr = `(async () => {
    const account = ${JSON.stringify(account)};
    const password = ${JSON.stringify(password)};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const pick = (list) => list.map((s) => document.querySelector(s)).find(visible) || null;
    const accountInput = () => pick(['input[name="account"]', 'input[type="email"]', 'input[autocomplete="username"]']);
    const passwordInput = () => pick(['input[name="passwd"]', 'input[type="password"]']);

    // Cloudflare 挑战通过后 SPA 还要几秒才渲染表单，先等
    for (let i = 0; i < 80 && !accountInput(); i += 1) await sleep(500);

    if (!accountInput()) {
      const btn = [...document.querySelectorAll('button, a, [role="button"]')]
        .find((el) => visible(el) && /通过邮箱登录|邮箱登录|sign in with email/i.test(el.innerText || ''));
      if (btn) {
        btn.click();
        for (let i = 0; i < 40 && !accountInput(); i += 1) await sleep(500);
      }
    }

    const a = accountInput();
    const p = passwordInput();
    if (!a || !p) return { ok: false, reason: '没找到账号/密码输入框', url: location.href, title: document.title };

    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      el.focus();
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    };
    setValue(a, account);
    setValue(p, password);

    // 顺手确认一下填进去的值没被清空
    const ok = a.value === account && p.value === password;
    return { ok, url: location.href, title: document.title, reason: ok ? '' : '输入框里的值被页面清掉了' };
  })()`;
  // 页面里的等待最长 40 秒，CDP 这侧要留足余量
  return cdp.evaluate(expr, 70_000);
}

/**
 * profile 里可能残留上次的登录态。只清 localStorage 是不够的：
 * 站点会拿残留的 cookie / session 自动续签一个新 token 写回 localStorage，
 * 表现就是「还没点登录就抓到了」。所以这里把 cookie、localStorage、IndexedDB
 * 全部清掉，强制走一次真实的登录。
 */
export async function prepareRelogin(cdp, loginUrl) {
  const origin = new URL(loginUrl).origin;
  const state = await cdp
    .evaluate(
      `(() => {
        let had = false;
        try { had = !!localStorage.getItem('viggleToken'); } catch {}
        return { had, path: location.pathname + location.search };
      })()`
    )
    .catch(() => ({ had: false, path: "" }));

  const onLogin = /\/login/i.test(state.path || "");

  // 站点数据（cookie / localStorage / sessionStorage / IndexedDB…）一并清掉
  await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }).catch(() => {});
  // 兜底：有些 Chrome 版本上 Storage 域不可用时，直接清浏览器 cookie
  await cdp.send("Network.clearBrowserCookies").catch(() => {});

  if (onLogin) {
    // 已经在登录页：reload 让上面的清理生效（页面内存里可能还留着旧会话）
    await cdp.evaluate("location.reload()").catch(() => {});
  } else {
    await cdp
      .evaluate(`(() => { location.href = ${JSON.stringify(loginUrl)}; })()`)
      .catch(() => {});
  }
  await sleep(4000);
  return state.had
    ? "已清除上次的登录态（含 cookie），需要重新登录一次"
    : "已清除站点缓存，准备登录";
}

/* --------------------------- 推送到服务端 --------------------------- */

/**
 * 本地 Chrome 抓到 token 后直接 PATCH 到 Viggle Studio。
 * 服务端在 Linux 上时不用对外开放端口，用 SSH 隧道把它的 3000 映射到本地即可：
 *   ssh -N -L 3000:127.0.0.1:3000 user@server
 *   node chrome-cdp.mjs --push http://127.0.0.1:3000 --cookie <viggle_access> --label siher
 */
const AUTH_COOKIE = "viggle_access";

/** 用服务端的 ACCESS_PASSWORD 换一个 viggle_access cookie，省得手动从浏览器里复制 */
async function loginCookie(base, args) {
  if (!args.accessPassword) return null;
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: args.accessPassword }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(
      `服务端登录失败：${body?.error?.message ?? `HTTP ${res.status}`}（检查 --access-password 是否为 ACCESS_PASSWORD）`
    );
  }
  if (body.enabled === false) return ""; // 服务端没配 ACCESS_PASSWORD，无需 cookie
  const jar = res.headers.getSetCookie?.() ?? [];
  const line = jar.find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  if (!line) throw new Error("服务端登录成功但没返回 viggle_access cookie");
  return line.slice(AUTH_COOKIE.length + 1).split(";")[0];
}

async function pushToken(args, token, info) {
  const base = String(args.push).replace(/\/+$/, "");
  let cookie = args.cookie ?? process.env.VIGGLE_ACCESS_COOKIE ?? null;
  if (!cookie) cookie = await loginCookie(base, args);
  if (cookie === null) {
    throw new Error("缺少鉴权：用 --password <服务访问密码> 自动登录，或 --cookie <viggle_access>");
  }
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `${AUTH_COOKIE}=${cookie}`;

  const call = async (path, init) => {
    const res = await fetch(`${base}${path}`, { ...init, headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) {
      const code = body?.error?.code ?? `HTTP ${res.status}`;
      const message = body?.error?.message ?? "无响应内容";
      if (code === "UNAUTHORIZED") {
        throw new Error(
          `服务端鉴权失败：--cookie 不是有效的 viggle_access（打开 ${base}/login 登录后，从 DevTools → Application → Cookies 复制）`
        );
      }
      throw new Error(`请求 ${path} 失败：${code} ${message}`);
    }
    return body.data;
  };

  let id = args.accountId;
  if (!id) {
    const { accounts = [] } = await call("/api/accounts");
    const keywords = [args.label, info?.payload?.email, info?.payload?.nickname]
      .filter((v) => typeof v === "string" && v.trim())
      .map((v) => v.trim().toLowerCase());
    if (!keywords.length) {
      throw new Error("无法确定要更新哪个账号：请加 --label 关键词或 --account-id");
    }
    const hits = accounts.filter((a) =>
      keywords.some((kw) =>
        [a.label, a.email, a.nickname].some((v) => typeof v === "string" && v.toLowerCase().includes(kw))
      )
    );
    if (hits.length === 1) {
      id = hits[0].id;
    } else if (hits.length > 1) {
      const list = hits.map((a) => `    - ${a.label}（id=${a.id}）`).join("\n");
      throw new Error(`匹配到 ${hits.length} 个账号，请用 --account-id 精确指定：\n${list}`);
    } else {
      const list = accounts.map((a) => `    - ${a.label}（id=${a.id}）`).join("\n") || "    （服务端还没有账号）";
      throw new Error(`服务端没有匹配「${keywords[0]}」的账号，现有：\n${list}`);
    }
  }

  const { account } = await call(`/api/accounts/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ token }),
  });
  console.log("\n=== 已推送到服务端 ===");
  console.log(`地址 : ${base}`);
  console.log(`账号 : ${account?.label ?? id}（id=${account?.id ?? id}）`);
  console.log("结果 : token 已加密入库，该账号的上游 session 已重置，下次请求即生效");
}

/* ------------------------------ 主流程 ------------------------------ */

async function selfTest(args) {
  console.log("· 自检：启动 headless Chrome 并验证 CDP 链路…");
  const { child, bin } = launchChrome({ port: args.port, url: "about:blank", headless: true });
  try {
    const target = await waitForPageTarget(args.port);
    const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
    const result = await cdp.evaluate("2 + 2");
    cdp.close();
    console.log(`· Chrome: ${bin}`);
    console.log(`· CDP 正常，页面求值 2+2 = ${result}`);
    console.log("· 自检通过（真实抓取请去掉 --self-test 后再运行）");
  } finally {
    child.kill();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest(args);

  // 只推送已经抓到的 token：不启动 Chrome，也不覆盖 out/token.json
  if (args.fromFile) {
    const file = resolve(HERE, args.fromFile);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const savedToken = saved?.token;
    if (!savedToken || savedToken.split(".").length !== 3) throw new Error(`${file} 里没有合法的 token`);
    const savedInfo = decodeJwt(savedToken);
    console.log(`· 读取 ${file}（抓取于 ${saved.capturedAt ?? "未知时间"}，剩余 ${savedInfo?.remainingDays ?? "?"} 天）`);
    if (!args.push) {
      console.log("· 未指定 --push，只做本地检查；加 --push <服务地址> 才会写进服务端");
      return;
    }
    await pushToken(args, savedToken, savedInfo);
    return;
  }

  let child = null;
  // 同一个 user-data-dir 再开第二个 Chrome，它只会把 URL 甩给已有实例然后自己退出，
  // 新端口根本不会起来。所以端口上已经有调试 Chrome 时，直接复用更稳。
  if (!args.attach && (await portHasChrome(args.port))) {
    console.log(`· 127.0.0.1:${args.port} 上已有开着调试端口的 Chrome，直接复用（不新开）`);
    args.attach = true;
  }
  if (!args.attach) {
    console.log(`· 启动 Chrome，打开 ${args.loginUrl}`);
    const launched = launchChrome({ port: args.port, url: args.loginUrl, headless: false, profile: args.profile });
    child = launched.child;
    console.log(`  浏览器：${launched.bin}`);
    console.log(`  资料目录：${launched.userDataDir}`);
  } else {
    console.log(`· 直接复用 127.0.0.1:${args.port} 上已开启调试端口的 Chrome`);
  }

  const target = await waitForPageTarget(args.port);
  const cdp = await new Cdp(target.webSocketDebuggerUrl).connect();
  console.log(`· 已连接页面：${target.url || target.title}`);

  // 自动填账号密码，剩下的（点登录 + 过 Verify you are human）交给用户
  const login = resolveLogin(args);
  if (login?.account) {
    console.log(`· ${await prepareRelogin(cdp, args.loginUrl)}`);
    console.log("· 正在自动填写账号密码（等页面渲染，最多 40 秒）…");
    const filled = await fillLoginForm(cdp, login.account, login.password).catch((err) => ({
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }));
    if (filled?.ok) {
      console.log(`  ✓ 账号密码已填好：${login.account}`);
      console.log("  → 现在请在浏览器里点「登录」，然后勾一下 Verify you are human");
    } else {
      console.log(`  ! 自动填表没成功：${filled?.reason ?? "未知原因"}（页面：${filled?.url ?? "-"}）`);
      console.log("    请手动输入账号密码后继续，脚本照样会自动抓 token");
    }
  } else {
    console.log("· 没传 --account/--password（或 accounts-file），请在窗口里手动登录");
  }

  const deadline = Date.now() + args.timeout * 1000;
  let token = null;
  let dots = 0;
  while (Date.now() < deadline) {
    try {
      token = await cdp.evaluate(
        "(() => { try { return JSON.parse(localStorage.getItem('viggleToken') ?? 'null'); } catch { return localStorage.getItem('viggleToken'); } })()"
      );
    } catch {
      // 页面正在跳转，忽略这一轮
    }
    if (token && typeof token === "string" && token.split(".").length === 3) break;
    token = null;
    process.stdout.write(dots++ % 20 === 0 ? "\n· 等待登录…" : ".");
    await sleep(1000);
  }

  if (!token) {
    cdp.close();
    console.log("\n× 等待超时，没有在 localStorage 里发现 viggleToken");
    process.exitCode = 1;
    return;
  }

  const info = decodeJwt(token);
  console.log("\n\n=== 抓到了 ===");
  if (info) {
    const { payload, expiresAt, remainingDays } = info;
    console.log(`账号 ID   : ${payload.id ?? payload.sub ?? "-"}`);
    console.log(`昵称/邮箱 : ${payload.nickname ?? "-"} / ${payload.email ?? "-"}`);
    console.log(`签发时间  : ${payload.iat ? new Date(payload.iat * 1000).toLocaleString() : "-"}`);
    console.log(`过期时间  : ${expiresAt ? expiresAt.toLocaleString() : "-"}`);
    console.log(`剩余天数  : ${remainingDays ?? "-"} 天`);
  } else {
    console.log("（JWT payload 解析失败，仅输出原文）");
  }

  const outPath = resolve(HERE, args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({ token, capturedAt: new Date().toISOString(), jwt: info?.payload ?? null }, null, 2),
    "utf8"
  );
  console.log(`\n已写入：${outPath}`);
  console.log("\n提示：这个 JSON 里的 token 就是要在项目「账号管理 → 更新 Token」里粘贴的值。");
  console.log("     它是 30 天有效期的账号凭据，别提交到 git，也别发群里。");

  cdp.close();

  if (args.push) {
    try {
      await pushToken(args, token, info);
    } catch (err) {
      console.error(`\n× 推送失败：${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }

  if (child && !args.attach) {
    console.log("\n（Chrome 保持打开；关掉窗口即可，不影响已写出的文件）");
  }
}

/** 只有直接 `node chrome-cdp.mjs` 时才跑主流程；被 renew-agent 引用时只导出函数 */
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error("× 失败：", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
