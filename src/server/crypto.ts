import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/** 密文格式：v1.<iv base64>.<tag base64>.<ciphertext base64> */
export function encryptSecret(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("加密密钥必须为 32 字节");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(".");
}

export function decryptSecret(payload: string, key: Buffer): string {
  if (key.length !== 32) throw new Error("加密密钥必须为 32 字节");
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("凭据密文格式无效或版本不受支持");
  }
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const body = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error("凭据密文长度异常");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * 兼容三种粘贴方式：裸 JWT、Bearer 前缀、以及 localStorage 里的 JSON 字符串形式。
 * 只做格式规整，不解析/验证签名内容（由上游验证）。
 */
export function normalizeToken(raw: string): string {
  let token = String(raw || "").trim();
  if (!token) throw new Error("Token 不能为空");
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      token = String(JSON.parse(token)).trim();
    } catch {
      // 保留原值，后续格式校验会报错
    }
  }
  token = token.replace(/^bearer\s+/i, "").trim();
  if (token.split(".").length !== 3 || token.length < 32) {
    throw new Error("JWT 格式不正确，应包含 header.payload.signature 三段");
  }
  return token;
}

/** 仅用于 UI 展示的脱敏串，绝不回传完整凭据。 */
export function maskToken(token: string): string {
  const head = token.slice(0, 10);
  const tail = token.slice(-6);
  return `${head}••••••${tail}`;
}

/** 常量时间比较两个等长 Buffer，用于测试与配置校验。 */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
