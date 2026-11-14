import { z } from "zod";
import { ASPECT_RATIOS, RESOLUTIONS } from "@/lib/constants";
import { errors } from "./errors";

export const createAccountSchema = z.object({
  label: z.string().trim().min(1, "请填写账号名称").max(40, "名称不能超过 40 字"),
  token: z.string().min(1, "请粘贴 JWT"),
  note: z.string().trim().max(200, "备注不能超过 200 字").optional(),
});

/** 多选批量操作：校验允许省略 ids（表示全部账号），删除则必须指定 ids。 */
const accountIds = z
  .array(z.string().trim().min(1))
  .min(1, "请先选择账号")
  .max(500, "一次最多操作 500 个账号");

export const verifyAccountsSchema = z.object({ ids: accountIds.optional() });
export const deleteAccountsSchema = z.object({ ids: accountIds });

export const importAccountsSchema = z.object({
  accounts: z
    .array(
      z.object({
        label: z.string().trim().min(1, "账号名称不能为空").max(40, "名称不能超过 40 字"),
        token: z.string().min(1, "JWT 不能为空"),
      })
    )
    .min(1, "没有可导入的 Viggle 账号")
    .max(100, "一次最多导入 100 个账号"),
});

export const updateAccountSchema = z
  .object({
    label: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().max(200).nullable().optional(),
    token: z.string().min(1).optional(),
  })
  .refine((value) => Object.values(value).some((x) => x !== undefined), {
    message: "没有需要更新的字段",
  });

export const deleteTasksSchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1, "请先选择记录")
    .max(200, "一次最多删除 200 条记录"),
  remote: z.boolean().optional(),
});

export const createTaskSchema = z.object({
  mode: z.enum(["references", "frames", "text"]),
  prompt: z.string().trim().min(1, "请输入提示词"),
  aspectRatio: z.enum(ASPECT_RATIOS),
  duration: z.number().int(),
  resolution: z.enum(RESOLUTIONS),
  qualityType: z.number().int(),
  assets: z
    .array(
      z.object({
        id: z.string().min(1),
        role: z.enum(["reference", "first", "last"]),
        position: z.number().int().min(0),
      })
    )
    .max(5)
    .default([]),
});

export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") || "参数";
    throw errors.validation(
      issue ? `${path}：${issue.message}` : "参数校验失败",
      result.error.flatten()
    );
  }
  return result.data;
}
