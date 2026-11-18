import { config } from "./config";
import { prisma } from "./db";
import { logger } from "./logger";
import { markTaskTimedOut, recoverInterruptedSubmissions, refreshTask } from "./services/tasks";

/**
 * 进程内的统一轮询守护：所有账号的活跃任务由服务端集中跟踪，
 * 前端只通过 SSE 收事件，不再各自 while(true) 轮询。
 * 注意：这是长驻 Node 进程模型，不适用于无状态的 serverless 部署。
 */
class TaskManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  start(): void {
    if (this.timer) return;
    // 重启后残留的 preparing 任务已经没有后台提交，标记为可重试。
    void recoverInterruptedSubmissions();
    this.timer = setInterval(() => void this.tick(), config.poll.intervalMs);
    // 不阻止 Node 进程因无请求而退出
    this.timer.unref?.();
    logger.info("taskmanager.started", { intervalMs: config.poll.intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      // 活跃任务数量受账号数量约束，这里不截断，避免排在后面的任务永远轮不到。
      const pending = await prisma.task.findMany({
        where: { status: { in: ["queued", "running"] } },
        select: { id: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: "asc" },
      });
      for (const task of pending) {
        // 从最后一次状态更新计时，恢复跟踪的老任务才能获得新的窗口
        if (Date.now() - task.updatedAt.getTime() > config.poll.maxAgeMs) {
          await markTaskTimedOut(task.id);
          continue;
        }
        try {
          await refreshTask(task.id);
        } catch (err) {
          logger.warn("taskmanager.refresh_failed", {
            taskId: task.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.error("taskmanager.tick_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.ticking = false;
    }
  }
}

const globalForManager = globalThis as unknown as { __viggleTaskManager?: TaskManager };

export function ensureTaskManager(): void {
  globalForManager.__viggleTaskManager ??= new TaskManager();
  globalForManager.__viggleTaskManager.start();
}
