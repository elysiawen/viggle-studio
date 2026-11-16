import { errors, ok, readJson, withErrors } from "@/server/errors";
import {
  getStorageSettings,
  setStorageAutoSave,
  setStorageDir,
  setStorageEncryption,
} from "@/server/services/storage-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前存储设置：自动存盘、加密存盘与生效中的落盘目录。 */
export const GET = withErrors(async () => ok(await getStorageSettings()));

/** 修改存储设置；各字段均可选，改目录会先校验可写。 */
export const PATCH = withErrors(async (req: Request) => {
  const body = await readJson(req);
  for (const key of ["autoSaveVideo", "autoSaveAsset"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      throw errors.validation(`${key} 必须是布尔值`);
    }
  }
  for (const key of ["encryptVideo", "encryptCover", "encryptAsset"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") {
      throw errors.validation(`${key} 必须是布尔值`);
    }
  }
  if (body.storageDir !== undefined && typeof body.storageDir !== "string") {
    throw errors.validation("storageDir 必须是字符串");
  }

  // 目录校验最容易失败，先做，避免开关已改而目录被拒。
  if (typeof body.storageDir === "string") await setStorageDir(body.storageDir);
  if (typeof body.encryptVideo === "boolean") await setStorageEncryption("video", body.encryptVideo);
  if (typeof body.encryptCover === "boolean") await setStorageEncryption("cover", body.encryptCover);
  if (typeof body.encryptAsset === "boolean") await setStorageEncryption("asset", body.encryptAsset);
  if (typeof body.autoSaveVideo === "boolean") await setStorageAutoSave("video", body.autoSaveVideo);
  if (typeof body.autoSaveAsset === "boolean") await setStorageAutoSave("asset", body.autoSaveAsset);

  return ok(await getStorageSettings());
});
