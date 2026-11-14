import type { NextRequest } from "next/server";
import { MAX_REFERENCE_MEDIA } from "@/lib/constants";
import { errors, ok, readJson, withErrors } from "@/server/errors";
import { importLibraryAssets, LIBRARY_MAX_PAGES, listLibraryAssets } from "@/server/services/assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseKind(value: unknown): "image" | "video" {
  return value === "video" ? "video" : "image";
}

function parsePage(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 && n <= LIBRARY_MAX_PAGES ? n : 1;
}

/** 拉取当前账号的上游素材库（图片 / 视频），只读、不消耗积分。 */
export const GET = withErrors(async (req: NextRequest) => {
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  const page = parsePage(req.nextUrl.searchParams.get("page"));
  return ok(await listLibraryAssets(kind, page));
});

/** 把选中的上游素材登记到本地素材表，返回可直接用于生成的 AssetView。 */
export const POST = withErrors(async (req: NextRequest) => {
  const body = await readJson(req);
  const kind = parseKind(body.kind);
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  if (!ids.length) throw errors.validation("请先选择素材");
  if (ids.length > MAX_REFERENCE_MEDIA) {
    throw errors.validation(`一次最多添加 ${MAX_REFERENCE_MEDIA} 个素材`);
  }
  const maxPage = parsePage(body.maxPage);
  return ok({ assets: await importLibraryAssets(kind, ids, maxPage) }, { status: 201 });
});
