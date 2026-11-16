import { errors, ok, readJson, withErrors } from "@/server/errors";
import {
  getStorageSettings,
  setAutoSaveVideo,
  setStorageDir,
  setStorageEncryption,
} from "@/server/services/storage-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前存储设置：自动存盘、加密存盘与生效中的落盘目录。 */
export const GET = withErrors(async () => ok(await getStorageSettings()));

/** 修改存储设置；三个字段都可选，改目录会先校验可写。 */
export const PATCH = withErrors(async (req: Request) => {
  const body = await readJson(req);
  if (body.autoSave !== undefined && typeof body.autoSave !== "boolean") {
    throw errors.validation("autoSave 必须是布尔值");
  }
  if (body.encrypt !== undefined && typeof body.encrypt !== "boolean") {
    throw errors.validation("encrypt 必须是布尔值");
  }
  if (body.storageDir !== undefined && typeof body.storageDir !== "string") {
    throw errors.validation("storageDir 必须是字符串");
  }

  // 目录校验最容易失败，先做，避免开关已改而目录被拒。
  if (typeof body.storageDir === "string") await setStorageDir(body.storageDir);
  if (typeof body.encrypt === "boolean") await setStorageEncryption(body.encrypt);
  if (typeof body.autoSave === "boolean") await setAutoSaveVideo(body.autoSave);

  return ok(await getStorageSettings());
});
