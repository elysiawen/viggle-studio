import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accessPassword } from "@/lib/auth";
import { config } from "@/server/config";
import { ok, withErrors } from "@/server/errors";
import { encryptionAvailable, getStorageDir } from "@/server/services/storage-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 应用版本，直接读 package.json，避免在两处维护。 */
function appVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** DATABASE_URL 的相对路径按 prisma/schema.prisma 所在目录解析。 */
function databasePath(): string {
  const url = config.databaseUrl;
  const raw = url.startsWith("file:") ? url.slice("file:".length) : url;
  return resolve(process.cwd(), "prisma", raw);
}

/** 设置页的只读系统信息；不返回任何密钥或凭据，只给是否配置。 */
export const GET = withErrors(async () => {
  const storageDir = await getStorageDir();
  return ok({
    version: appVersion(),
    mode: config.isProduction ? "production" : "development",
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    databasePath: databasePath(),
    storageDir,
    baseUrl: config.viggle.baseUrl,
    poll: {
      intervalMs: config.poll.intervalMs,
      maxAgeMs: config.poll.maxAgeMs,
    },
    flags: {
      accessPassword: Boolean(accessPassword()),
      storagePassword: encryptionAvailable(),
    },
  });
});
