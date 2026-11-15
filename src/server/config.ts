import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderInfo } from "@/lib/types";

/**
 * 用动态键读取环境变量。
 * Next.js/webpack 会把静态的 process.env.X 在构建期内联成常量；一旦用户改了 .env，
 * 旧产物里就会出现「部分 chunk 用旧值、部分用新值」的混合状态。动态键不会被内联。
 */
function env(key: string): string {
  return process.env[key] ?? "";
}

/** Next.js 会自动加载 .env，但 Vitest 与独立脚本不会。只填补缺失项，不覆盖显式注入值。 */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      const value = match[2].trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // 没有 .env 时依赖真实环境变量
  }
}

loadDotEnv();

function intEnv(key: string, fallback: number): number {
  const value = Number(env(key));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** 布尔开关：1/true/yes/on 为真，0/false/no/off 为假，未设置或无法识别时取默认值。 */
function boolEnv(key: string, fallback: boolean): boolean {
  const value = env(key).trim().toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
}

function resolveCredentialsKey(): Buffer {
  const raw = env("CREDENTIALS_KEY").trim();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "CREDENTIALS_KEY 缺失或不是 64 位十六进制字符串。生产环境必须配置，否则无法安全加密账号凭据。"
    );
  }
  console.warn("[config] 未配置有效的 CREDENTIALS_KEY，开发环境使用临时派生密钥（请勿用于生产）");
  return createHash("sha256").update("viggle-studio-dev-only").digest();
}

export const config = {
  isProduction: process.env.NODE_ENV === "production",
  credentialsKey: resolveCredentialsKey(),
  databaseUrl: env("DATABASE_URL") || "file:./viggle-studio.db",
  viggle: {
    baseUrl: (env("VIGGLE_BASE_URL") || "https://viggle.ai").replace(/\/$/, ""),
    userAgent:
      env("VIGGLE_USER_AGENT") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
    signSalt: env("VIGGLE_SIGN_SALT") || "qdsnfXVFGS1dVCYTju",
    /** httpcloak 的 timeout 单位是秒 */
    requestTimeoutSeconds: Math.max(1, Math.round(intEnv("VIGGLE_REQUEST_TIMEOUT_MS", 60_000) / 1000)),
    uploadTimeoutSeconds: Math.max(1, Math.round(intEnv("VIGGLE_UPLOAD_TIMEOUT_MS", 120_000) / 1000)),
  },
  poll: {
    intervalMs: intEnv("TASK_POLL_INTERVAL_MS", 4000),
    maxAgeMs: intEnv("TASK_POLL_MAX_AGE_MS", 15 * 60 * 1000),
  },
  /**
   * 落盘根目录（相对 process.cwd()，可用 VIDEO_STORAGE_DIR 覆盖）。
   * 根目录下自动使用两个子目录：videos/ 放视频、covers/ 放封面。
   */
  storageDir: env("VIDEO_STORAGE_DIR") || "./storage",
  /** 落盘加密主密码（Sakura Encryptor 容器）；留空则无法开启加密 */
  storagePassword: env("STORAGE_PASSWORD"),
  /** 是否在任务成功后自动下载视频与封面；VIDEO_AUTO_SAVE=false 可关闭 */
  autoSaveVideo: boolEnv("VIDEO_AUTO_SAVE", true),
} as const;

export function providerInfo(): ProviderInfo {
  return { id: "viggle", label: "Viggle 上游" };
}
