import { ok, withErrors } from "@/server/errors";
import { listLocalVideos } from "@/server/services/local-videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 画廊「本地文件」标签页：列出落盘目录里成功任务的视频。 */
export const GET = withErrors(async () => {
  return ok({ videos: await listLocalVideos() });
});
