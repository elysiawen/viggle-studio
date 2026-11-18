import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { assertFreeTier } from "./services/tasks";
import {
  createAccountSchema,
  createTaskSchema,
  deleteAccountsSchema,
  deleteTasksSchema,
  parse,
  verifyAccountsSchema,
} from "./validation";

function expectValidation(fn: () => unknown): void {
  try {
    fn();
    throw new Error("应当抛出校验错误");
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("VALIDATION_ERROR");
  }
}

const validTask = {
  mode: "text",
  prompt: "a cat walking on the beach",
  aspectRatio: "16:9",
  duration: 5,
  resolution: "768p",
  qualityType: 0,
  assets: [],
};

describe("请求校验", () => {
  it("拒绝未知生成模式（旧项目会静默走文生视频）", () => {
    expectValidation(() => parse(createTaskSchema, { ...validTask, mode: "unknown" }));
  });

  it("拒绝空提示词，不限制提示词长度", () => {
    expectValidation(() => parse(createTaskSchema, { ...validTask, prompt: "  " }));
    const longPrompt = "x".repeat(5000);
    expect(parse(createTaskSchema, { ...validTask, prompt: longPrompt }).prompt).toBe(longPrompt);
  });

  it("拒绝非白名单参数", () => {
    expectValidation(() => parse(createTaskSchema, { ...validTask, aspectRatio: "2:1" }));
    expectValidation(() => parse(createTaskSchema, { ...validTask, resolution: "1080p" }));
  });

  it("参考素材最多 5 个", () => {
    const assets = Array.from({ length: 6 }, (_, i) => ({
      id: `asset-${i}`,
      role: "reference",
      position: i,
    }));
    expectValidation(() => parse(createTaskSchema, { ...validTask, mode: "references", assets }));
  });

  it("默认 assets 为空数组", () => {
    const input = parse(createTaskSchema, { ...validTask, assets: undefined });
    expect(input.assets).toEqual([]);
  });

  it("账号名称必填", () => {
    expectValidation(() => parse(createAccountSchema, { label: "", token: "a.b.c" }));
  });

  it("多选批量删除必须指定合法 ids", () => {
    expectValidation(() => parse(deleteAccountsSchema, { ids: [] }));
    expectValidation(() => parse(deleteAccountsSchema, { ids: [""] }));
    expectValidation(() => parse(deleteAccountsSchema, { ids: Array(501).fill("a") }));
    expect(parse(deleteAccountsSchema, { ids: ["a", "b"] }).ids).toEqual(["a", "b"]);
  });

  it("批量校验省略 ids 时表示全部账号", () => {
    expect(parse(verifyAccountsSchema, {}).ids).toBeUndefined();
    expect(parse(verifyAccountsSchema, { ids: ["a"] }).ids).toEqual(["a"]);
    expectValidation(() => parse(verifyAccountsSchema, { ids: [] }));
  });

  it("历史记录批量删除必须指定合法 ids", () => {
    expectValidation(() => parse(deleteTasksSchema, { ids: [] }));
    expectValidation(() => parse(deleteTasksSchema, { ids: Array(201).fill("a") }));
    const parsed = parse(deleteTasksSchema, { ids: ["a", "b"], remote: true });
    expect(parsed.ids).toEqual(["a", "b"]);
    expect(parsed.remote).toBe(true);
  });
});

describe("免费档约束", () => {
  const free = { duration: 5, resolution: "768p", qualityType: 0, aspectRatio: "16:9" };

  it("接受合法免费档参数", () => {
    expect(() => assertFreeTier(free)).not.toThrow();
    expect(() => assertFreeTier({ ...free, resolution: "480p" })).not.toThrow();
  });

  it("拒绝订阅档参数", () => {
    expectValidation(() => assertFreeTier({ ...free, duration: 10 }));
    expectValidation(() => assertFreeTier({ ...free, resolution: "1080p" }));
    expectValidation(() => assertFreeTier({ ...free, qualityType: 1 }));
    expectValidation(() => assertFreeTier({ ...free, aspectRatio: "2:1" }));
  });
});

