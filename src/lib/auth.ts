/**
 * 可选的访问密码：设置 ACCESS_PASSWORD 后，middleware 会要求先登录。
 * cookie 里存的是 HMAC 派生值，不包含明文密码。
 */
export const AUTH_COOKIE = "viggle_access";
const AUTH_MESSAGE = "viggle-studio-access";

/**
 * Middleware（Edge）与 Node 路由必须拿到同一个值，因此统一用静态键读取。
 * 注意：密码在构建时确定，修改 ACCESS_PASSWORD 后需要重新 build 再启动。
 */
export function accessPassword(): string | undefined {
  const value = process.env.ACCESS_PASSWORD;
  return value?.trim() || undefined;
}

/** 用凭据密钥派生 cookie 值，避免把密码本身写进浏览器。 */
export function authSecret(): string {
  return process.env.CREDENTIALS_KEY?.trim() || "viggle-studio-dev-only";
}

export async function createAuthToken(password: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${AUTH_MESSAGE}:${password}`)
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
