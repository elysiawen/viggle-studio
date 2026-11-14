import { describe, expect, it } from "vitest";
import { createAuthToken } from "./auth";

describe("访问密码 token", () => {
  it("同一密码与密钥生成稳定的 token", async () => {
    const first = await createAuthToken("secret", "key");
    const second = await createAuthToken("secret", "key");
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("密码或密钥变化时 token 不同", async () => {
    const base = await createAuthToken("secret", "key");
    expect(await createAuthToken("other", "key")).not.toBe(base);
    expect(await createAuthToken("secret", "other")).not.toBe(base);
  });
});
