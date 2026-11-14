import { afterAll, describe, expect, it } from "vitest";
import { getProvider, setProvider } from "./index";

afterAll(() => setProvider(null));

describe("Provider 实例共享", () => {
  it("始终返回 Viggle 实现", () => {
    expect(getProvider().id).toBe("viggle");
  });

  it("跨调用共享同一实例", () => {
    expect(getProvider()).toBe(getProvider());
  });

  it("清空后可重新创建实例", () => {
    const before = getProvider();
    setProvider(null);
    expect(getProvider()).not.toBe(before);
  });
});
