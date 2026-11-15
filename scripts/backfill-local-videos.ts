/**
 * 批量把「历史记录里已成功」的视频补存到本地（视频 + 封面），并写入 LocalVideo 表。
 *
 * 用法：
 *   npm run storage:backfill -- --dry-run          # 只看会补存哪些，不下载
 *   npm run storage:backfill                       # 全部补存
 *   npm run storage:backfill -- --limit 20         # 只补最近的 20 条
 *   npm run storage:backfill -- --account 3fa2     # 只补某个账号（ID 前缀或 label）
 *   npm run storage:backfill -- --interval 1500    # 每条之间等待 1.5s，避免触发上游限流
 *
 * 说明：
 * - 是否加密由画廊「本地文件」里的开关（Setting 表）决定，脚本与服务端行为一致；
 * - 已经登记过的任务自动跳过，可以反复执行；
 * - 单条失败只记录并继续，结束时给出汇总。
 */
import { config } from "../src/server/config";
import { prisma } from "../src/server/db";
import { persistTaskVideo } from "../src/server/services/local-videos";
import { getStorageEncryption } from "../src/server/services/storage-settings";

interface Options {
  dryRun: boolean;
  limit: number;
  account: string | null;
  interval: number;
}

function readOptions(argv: string[]): Options {
  const value = (name: string): string | null => {
    const withEquals = argv.find((item) => item.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
    return null;
  };

  const number = (name: string, fallback: number): number => {
    const raw = value(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
  };

  return {
    dryRun: argv.includes("--dry-run"),
    limit: number("limit", 0),
    account: value("account"),
    interval: number("interval", 0),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function shortId(id: string): string {
  return id.slice(0, 8);
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));

  const encryption = await getStorageEncryption();
  console.log(`落盘目录：${config.storageDir}（videos/ 与 covers/）`);
  console.log(
    `加密落盘：${encryption.enabled ? "已开启（.ske）" : "未开启（明文）"}` +
      (encryption.available ? "" : " · 未配置 STORAGE_PASSWORD，无法启用加密")
  );

  const tasks = await prisma.task.findMany({
    where: {
      status: "succeeded",
      videoUrl: { not: null },
      ...(options.account
        ? {
            OR: [
              { accountId: options.account },
              { accountId: { startsWith: options.account } },
              { account: { label: options.account } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "asc" },
    take: options.limit > 0 ? options.limit : undefined,
    include: { account: { select: { label: true } } },
  });

  const registered = new Set(
    (await prisma.localVideo.findMany({ select: { taskId: true } })).map((row) => row.taskId)
  );
  const pending = tasks.filter((task) => !registered.has(task.id));

  console.log(
    `匹配到 ${tasks.length} 条成功任务，其中 ${tasks.length - pending.length} 条已登记、${pending.length} 条待补存。`
  );

  if (pending.length === 0) {
    console.log("没有需要补存的任务。");
    return;
  }

  if (options.dryRun) {
    for (const task of pending) {
      console.log(
        `  · ${shortId(task.id)}  ${task.account.label}  ${task.duration}s/${task.resolution}  ${task.prompt.slice(0, 48)}`
      );
    }
    console.log("\n--dry-run 模式，未下载任何文件。去掉该参数即可真正补存。");
    return;
  }

  let saved = 0;
  let failed = 0;
  for (const [index, task] of pending.entries()) {
    const prefix = `[${index + 1}/${pending.length}] ${shortId(task.id)}`;
    process.stdout.write(`${prefix} ${task.prompt.slice(0, 36)} … `);

    const ok = await persistTaskVideo(task);
    if (ok) {
      saved += 1;
      console.log("ok");
    } else {
      failed += 1;
      console.log("失败（详见服务端日志：上游直链失效 / 账号 token 失效 / 写入异常）");
    }

    if (options.interval > 0 && index < pending.length - 1) await sleep(options.interval);
  }

  console.log(`\n完成：成功 ${saved} 条，失败 ${failed} 条，跳过 ${tasks.length - pending.length} 条（已登记）。`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error("批量落盘中断：", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
