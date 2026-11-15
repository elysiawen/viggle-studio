import { errors, ok, readJson, withErrors } from "@/server/errors";
import { getStorageEncryption, setStorageEncryption } from "@/server/services/storage-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 当前落盘加密状态（主密码只来自 env，不会回传）。 */
export const GET = withErrors(async () => ok(await getStorageEncryption()));

/** 切换是否加密落盘；未配置 STORAGE_PASSWORD 时拒绝开启。 */
export const PATCH = withErrors(async (req: Request) => {
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") throw errors.validation("enabled 必须是布尔值");
  return ok(await setStorageEncryption(body.enabled));
});
