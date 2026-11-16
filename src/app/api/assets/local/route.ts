import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import {
  type LocalAssetKindFilter,
  listLocalAssets,
  removeAllLocalAssets,
  removeLocalAssets,
} from "@/server/services/local-assets";

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

/** 批量删除本地素材；ids=a,b 指定条目，all=1 清空整个素材箱。 */
export const DELETE = withErrors(async (req: NextRequest) => {
  if (req.nextUrl.searchParams.get("all") === "1") {
    return ok(await removeAllLocalAssets());
  }
  const raw = req.nextUrl.searchParams.get("ids") || "";
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ok(await removeLocalAssets(ids.slice(0, 200)));
});
