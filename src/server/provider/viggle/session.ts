import { logger } from "../../logger";
import { errors } from "../../errors";

type SessionCtor = typeof import("httpcloak").Session;
type SessionInstance = InstanceType<SessionCtor>;

type Pool = Map<string, SessionInstance>;
const globalForSessions = globalThis as unknown as {
  __viggleSessionPool?: Pool;
  __viggleSessionCtor?: SessionCtor;
  __viggleSessionCreating?: Map<string, Promise<SessionInstance>>;
};

function pool(): Pool {
  globalForSessions.__viggleSessionPool ??= new Map();
  return globalForSessions.__viggleSessionPool;
}

/** 正在创建中的会话：并发首建共用同一个 Promise，避免旧句柄被覆盖后无人关闭。 */
function creating(): Map<string, Promise<SessionInstance>> {
  globalForSessions.__viggleSessionCreating ??= new Map();
  return globalForSessions.__viggleSessionCreating;
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
  const pending = creating().get(accountId);
  if (pending) return pending;

  const created = (async () => {
    const Ctor = await loadCtor();
    const session = new Ctor({ preset: "chrome-latest" });
    const stale = sessions.get(accountId);
    if (stale && stale !== session) {
      try {
        stale.close();
      } catch {
        // 已失效的句柄无需处理
      }
    }
    sessions.set(accountId, session);
    return session;
  })();
  const tracked = created.finally(() => creating().delete(accountId));
  creating().set(accountId, tracked);
  return tracked;
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
