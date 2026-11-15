import type { NextRequest } from "next/server";
import { errors } from "./errors";
import { getProvider } from "./provider";
import { getAccountCredentials } from "./services/accounts";

export interface VideoTaskRef {
  id: string;
  accountId: string;
  remoteId: string | null;
  videoUrl: string | null;
}

/**
 * 把上游视频以流的形式转发给浏览器。
 *
 * 上游给的是对象存储的预签名地址，自带有效期，过期后浏览器直连只会拿到
 * `ExpiredRequest`。这里每次请求都让 provider 重新签发一次最新地址，
 * 所以播放 / 下载用的都是永久有效的本站地址。
 */
export async function respondWithVideo(
  task: VideoTaskRef,
  req: NextRequest,
  disposition: "inline" | "attachment"
): Promise<Response> {
  const { account, token } = await getAccountCredentials(task.accountId);
  const stream = await getProvider().getVideoStream(
    { accountId: account.id, token },
    { taskId: task.id, remoteId: task.remoteId, videoUrl: task.videoUrl },
    { range: req.headers.get("range") ?? undefined, signal: req.signal }
  );
  if (!stream) throw errors.notFound("视频源暂不可用，上游可能已删除该视频");

  const headers = new Headers();
  headers.set("Content-Type", stream.contentType);
  headers.set("Content-Disposition", `${disposition}; filename="${stream.filename}"`);
  headers.set("Cache-Control", "private, max-age=3600");
  if (stream.contentLength !== undefined) {
    headers.set("Content-Length", String(stream.contentLength));
  }
  if (stream.contentRange) headers.set("Content-Range", stream.contentRange);
  if (stream.acceptRanges) headers.set("Accept-Ranges", stream.acceptRanges);

  return new Response(stream.body, { status: stream.statusCode ?? 200, headers });
}
