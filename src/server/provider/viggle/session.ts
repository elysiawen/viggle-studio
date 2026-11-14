import { logger } from "../../logger";
import { errors } from "../../errors";

type SessionCtor = typeof import("httpcloak").Session;
type SessionInstance = InstanceType<SessionCtor>;

type Pool = Map<string, SessionInstance>;
const globalForSessions = globalThis as unknown as {
  __viggleSessionPool?: Pool;
  __viggleSessionCtor?: SessionCtor;
};

function pool(): Pool {
  globalForSessions.__viggleSessionPool ??= new Map();
  return globalForSessions.__viggleSessionPool;
}

/**
 * 动态加载 httpcloak：它依赖 koffi 原生 FFI，按需加载避免影响无上游请求的场景。
 * 每个上游账号使用独立 Session，避免 Cloudflare Cookie 在多账号间串号。
 */
async function loadCtor(): Promise<SessionCtor> {
  if (globalForSessions.__viggleSessionCtor) return globalForSessions.__viggleSessionCtor;
  try {
    const mod = await import("httpcloak");
    globalForSessions.__viggleSessionCtor = mod.Session;
    return mod.Session;
  } catch (err) {
    logger.error("viggle.session.load_failed", { message: String(err) });
    throw errors.unavailable("无法加载 httpcloak 原生模块。请确认已安装对应平台的二进制依赖。");
  }
}

export async function getSession(accountId: string): Promise<SessionInstance> {
  const sessions = pool();
  const existing = sessions.get(accountId);
  if (existing && typeof existing.isActive === "function" && existing.isActive()) {
    return existing;
  }
  if (existing) {
    try {
      existing.close();
    } catch {
      // 已失效的句柄无需处理
    }
  }
  const Ctor = await loadCtor();
  const session = new Ctor({ preset: "chrome-latest" });
  sessions.set(accountId, session);
  return session;
}

export function closeSession(accountId: string): void {
  const session = pool().get(accountId);
  if (!session) return;
  try {
    session.close();
  } catch {
    // 忽略关闭异常
  }
  pool().delete(accountId);
}

export function closeAllSessions(): void {
  for (const id of [...pool().keys()]) closeSession(id);
}
