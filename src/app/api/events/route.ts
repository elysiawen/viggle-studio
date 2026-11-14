import type { NextRequest } from "next/server";
import { createEventStream } from "@/server/events";
import { logger } from "@/server/logger";
import { listAccounts } from "@/server/services/accounts";
import { listTasks } from "@/server/services/tasks";
import { ensureTaskManager } from "@/server/task-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** SSE：连接建立后先推全量快照，之后由事件总线推送任务进度与账号变更。 */
export function GET(req: NextRequest): Response {
  ensureTaskManager();

  const stream = createEventStream({
    signal: req.signal,
    onConnect: (send) => {
      void Promise.all([listTasks({ limit: 50 }), listAccounts()])
        .then(([tasks, accounts]) => send({ type: "snapshot", tasks, accounts }))
        .catch((err) =>
          logger.error("events.snapshot_failed", {
            message: err instanceof Error ? err.message : String(err),
          })
        );
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
