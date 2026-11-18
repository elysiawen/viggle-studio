import type { NextRequest } from "next/server";
import { errors, ok, withErrors } from "@/server/errors";
import {
  type LocalAssetKindFilter,
  listLocalAssets,
  removeAllLocalAssets,
  removeLocalAssets,
  removeTemporaryLocalAssets,
  saveLocalAsset,
  toLocalAssetView,
} from "@/server/services/local-assets";
import { getKeepAssets } from "@/server/services/storage-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseKind(value: string | null): LocalAssetKindFilter {
  return value === "image" || value === "video" ? value : "all";
}

function parsePage(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

/** 本地素材箱列表；kind 省略时返回全部，供设置页统计与清理。 */
export const GET = withErrors(async (req: NextRequest) => {
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  const page = parsePage(req.nextUrl.searchParams.get("page"));
  return ok(await listLocalAssets(kind, page));
});

/**
 * 只落本地、不碰上游：生成提交时才按最终选中的账号上传。
 * 关闭「自动存盘 → 素材」时记为临时素材，生成结束后自动清理。
 */
export const POST = withErrors(async (req: NextRequest) => {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw errors.badRequest("请求必须是 multipart/form-data");
  }
  const entry = form.get("file");
  if (!(entry instanceof File)) throw errors.validation("缺少文件字段 file");

  // 视频封面由浏览器抓帧后带上；图片封面由服务端 sharp 生成，这里只做兜底接收。
  const thumbEntry = form.get("thumb");
  let thumbnail: Buffer | null = null;
  if (thumbEntry instanceof File && thumbEntry.size <= 512 * 1024) {
    const buffer = Buffer.from(await thumbEntry.arrayBuffer());
    // 只接受 JPEG，和 SKE 信封/封面接口的输出格式保持一致。
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      thumbnail = buffer;
    }
  }

  const buffer = Buffer.from(await entry.arrayBuffer());
  const asset = await saveLocalAsset({
    buffer,
    mime: entry.type,
    originalName: entry.name,
    temporary: !(await getKeepAssets()),
    thumbnail,
  });
  return ok({ asset: toLocalAssetView(asset) }, { status: 201 });
});

/**
 * 批量删除本地素材；ids=a,b 指定条目，all=1 清空整个素材箱。
 * temp=1 时只删临时素材，供前端移除未提交的草稿时清理。
 */
export const DELETE = withErrors(async (req: NextRequest) => {
  if (req.nextUrl.searchParams.get("all") === "1") {
    return ok(await removeAllLocalAssets());
  }
  const raw = req.nextUrl.searchParams.get("ids") || "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (req.nextUrl.searchParams.get("temp") === "1") {
    return ok(await removeTemporaryLocalAssets(ids.slice(0, 200)));
  }
  return ok(await removeLocalAssets(ids.slice(0, 200)));
});
