import type { NextRequest } from "next/server";
import { errors, ok, withErrors } from "@/server/errors";
import { uploadAsset } from "@/server/services/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 使用真正的 multipart/form-data，替代旧项目 base64 进 JSON（体积膨胀 33%）。 */
export const POST = withErrors(async (req: NextRequest) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw errors.badRequest("请求必须是 multipart/form-data");
  }
  const entry = form.get("file");
  if (!(entry instanceof File)) throw errors.validation("缺少文件字段 file");

  const buffer = Buffer.from(await entry.arrayBuffer());
  const asset = await uploadAsset({
    buffer,
    mime: entry.type,
    filename: entry.name,
  });
  return ok({ asset }, { status: 201 });
});
