import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, maskToken, normalizeToken, safeEqual } from "./crypto";

const key = randomBytes(32);

describe("AES-256-GCM 凭据加密", () => {
  it("加解密可往返且密文不含明文", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature-value";
    const cipher = encryptSecret(token, key);
    expect(cipher.startsWith("v1.")).toBe(true);
    expect(cipher).not.toContain(token);
    expect(decryptSecret(cipher, key)).toBe(token);
  });

  it("每次加密使用不同 IV，密文不重复", () => {
    const a = encryptSecret("same-token", key);
    const b = encryptSecret("same-token", key);
    expect(a).not.toBe(b);
  });

  it("篡改认证标签或密文会抛错", () => {
    const cipher = encryptSecret("secret", key);
    const parts = cipher.split(".");
    const tag = Buffer.from(parts[2], "base64");
    tag[0] ^= 0xff;
    const tampered = [parts[0], parts[1], tag.toString("base64"), parts[3]].join(".");
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it("错误密钥无法解密", () => {
    const cipher = encryptSecret("secret", key);
    expect(() => decryptSecret(cipher, randomBytes(32))).toThrow();
  });

  it("拒绝非 32 字节密钥与非法密文格式", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16))).toThrow();
    expect(() => decryptSecret("plain-text", key)).toThrow();
  });
});

describe("JWT 规整与脱敏", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmnop";

  it("接受裸 JWT、Bearer 前缀与 JSON 字符串形式", () => {
    expect(normalizeToken(token)).toBe(token);
    expect(normalizeToken(`Bearer ${token}`)).toBe(token);
    expect(normalizeToken(JSON.stringify(token))).toBe(token);
    expect(normalizeToken(`  ${token}  `)).toBe(token);
  });

  it("拒绝空值与非三段 JWT", () => {
    expect(() => normalizeToken("")).toThrow();
    expect(() => normalizeToken("not-a-jwt")).toThrow();
    expect(() => normalizeToken("a.b")).toThrow();
  });

  it("脱敏串不泄露完整凭据", () => {
    const masked = maskToken(token);
    expect(masked).toContain("••••••");
    expect(masked).not.toContain(token);
  });

  it("safeEqual 可比较等长 Buffer", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(safeEqual(Buffer.from("abc"), Buffer.from("ab"))).toBe(false);
  });
});
