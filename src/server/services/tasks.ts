import type { Prisma, Task } from "@prisma/client";
import {
  ASPECT_RATIOS,
  BUSY_QUEUED_TTL_MS,
  FREE_TIER,
  MAX_REFERENCE_MEDIA,
  isCreditsExhausted,
} from "@/lib/constants";
import type { AssetRole, LocalAssetView, TaskAssetView, TaskView } from "@/lib/types";
import { config } from "../config";
import { decryptSecret } from "../crypto";
import { prisma } from "../db";
import { AppError, errors } from "../errors";
import { publish } from "../events";
import { logger } from "../logger";
import { getProvider } from "../provider";
import type { GenerationPayload, RemoteMediaSource } from "../provider/types";
import { createTaskSchema, parse } from "../validation";
import {
  busyTaskFilter,
  getAccountCredentials,
  getActiveCredentials,
  withAutoAccount,
  type ActiveCredentials,
} from "./accounts";
import { autoPersistTaskVideo } from "./local-videos";
import {
  isRemoteAssetFresh,
  removeTemporaryLocalAssets,
  resolveLocalAssetForAccount,
  saveLocalAsset,
  toLocalAssetView,
} from "./local-assets";
import { getKeepAssets } from "./storage-settings";

type TaskWithAccount = Task & { account: { label: string; tokenCipher: string } };

const includeAccount = {
  account: { select: { label: true, tokenCipher: true } },
} satisfies Prisma.TaskInclude;

function toView(task: TaskWithAccount): TaskView {
  return {
    id: task.id,
    remoteId: task.remoteId,
    accountId: task.accountId,
    // 自动选号期间账户还没定下来，用阶段文案代替占位账号，避免误导。
    accountLabel: task.stage === "选号中" ? "自动选号中" : task.account.label,
    mode: task.mode as TaskView["mode"],
    prompt: task.prompt,
    aspectRatio: task.aspectRatio,
    duration: task.duration,
    resolution: task.resolution,
    qualityType: task.qualityType,
    status: task.status as TaskView["status"],
    stage: task.stage,
    progress: task.progress,
    errorMessage: task.errorMessage,
    videoUrl: task.videoUrl,
    coverUrl: task.coverUrl,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    // 只在上游任务尚未创建、且仍保留提交快照时允许重试，避免重复消耗额度。
    retryable: task.status === "failed" && !task.remoteId && Boolean(task.submitInputs),
  };
}

/** 更新任务阶段并广播；任务已被删除时返回 null。 */
async function updateTaskStage(
  taskId: string,
  data: { stage?: string; accountId?: string }
): Promise<TaskWithAccount | null> {
  try {
    const updated = await prisma.task.update({
      where: { id: taskId },
      data,
      include: includeAccount,
    });
    publish({ type: "task.updated", task: toView(updated) });
    return updated;
  } catch (err) {
    // 任务被删除按「无需继续」处理；其它写库错误必须抛出，
    // 否则任务可能在账号没有真正占位的情况下继续提交，造成同账号并发。
    if (err && typeof err === "object" && (err as { code?: string }).code === "P2025") {
      return null;
    }
    throw err;
  }
}

export function assertFreeTier(input: {
  duration: number;
  resolution: string;
  qualityType: number;
  aspectRatio: string;
}): void {
  if (input.duration !== FREE_TIER.duration) throw errors.validation("免费档仅支持 5 秒时长");
  if (!FREE_TIER.resolutions.includes(input.resolution as (typeof FREE_TIER.resolutions)[number])) {
    throw errors.validation("免费档仅支持 480p / 768p 分辨率");
  }
  if (input.qualityType !== FREE_TIER.qualityType) {
    throw errors.validation("免费档仅支持 Flash 质量");
  }
  if (!(ASPECT_RATIOS as readonly string[]).includes(input.aspectRatio)) {
    throw errors.validation("不支持的画面比例");
  }
}

/** 入队时冻结的提交参数：素材上传在后台进行，失败重试时靠它还原原始选择。 */
interface StoredSubmitInput {
  autoAccount: boolean;
  /** 素材库直选的上游素材 */
  assets: Array<{ id: string; role: AssetRole; position: number }>;
  /** 本地素材箱里的文件 */
  localAssets: Array<{ id: string; role: AssetRole; position: number }>;
}

/** 进程内正在后台提交的任务，防止重复重试并发提交同一个任务。 */
const submittingTasks = new Set<string>();

/** 素材已删除 / 失效等无法通过重试恢复的错误，重试前就应让用户重新选择。 */
function unrecoverable(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400, { retryable: false });
}

/** 重启恢复只执行一次：并发调用共享同一个 Promise，避免和新建任务抢时序。 */
let recoveryPromise: Promise<number> | null = null;

/**
 * 服务重启后，停留在 preparing 的任务已经失去后台提交流程，
 * 标记为可重试，让用户能在任务队列里点重试。
 */
export function recoverInterruptedSubmissions(): Promise<number> {
  recoveryPromise ??= (async () => {
    // 旧版本的 queued 占位没有 upstream ID，超过 TTL 也不会再有人提交，直接标记失败。
    const zombies = await prisma.task.updateMany({
      where: {
        status: "queued",
        remoteId: null,
        createdAt: { lt: new Date(Date.now() - BUSY_QUEUED_TTL_MS) },
      },
      data: {
        status: "failed",
        stage: "提交失败",
        errorMessage: "提交中断，请重新发起生成",
        finishedAt: new Date(),
      },
    });
    const selecting = await prisma.task.updateMany({
      where: { status: "preparing", stage: "选号中" },
      data: {
        status: "failed",
        stage: "选号失败",
        errorMessage: "服务重启导致选号中断，请重试",
        finishedAt: new Date(),
      },
    });
    const submitting = await prisma.task.updateMany({
      where: { status: "preparing", stage: "提交中" },
      data: {
        status: "failed",
        stage: "提交中断",
        errorMessage: "提交过程中服务重启，结果未知，请确认上游后再决定是否重试",
        finishedAt: new Date(),
      },
    });
    const uploading = await prisma.task.updateMany({
      where: { status: "preparing" },
      data: {
        status: "failed",
        stage: "上传素材失败",
        errorMessage: "服务重启导致提交中断，请重试",
        finishedAt: new Date(),
      },
    });
    const count = selecting.count + submitting.count + uploading.count + zombies.count;
    if (count) logger.warn("task.interrupted_submissions", { count });
    return count;
  })().catch((err) => {
    logger.error("task.recover_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  });
  return recoveryPromise;
}

export async function createTask(raw: unknown): Promise<TaskView> {
  const input = parse(createTaskSchema, raw);
  assertFreeTier(input);
  await recoverInterruptedSubmissions();

  const localInputs = input.localAssets;
  const inputs = [...input.assets, ...localInputs].sort((a, b) => a.position - b.position);
  const references = inputs.filter((a) => a.role === "reference");
  const first = inputs.find((a) => a.role === "first");
  const last = inputs.find((a) => a.role === "last");

  if (input.mode === "references") {
    if (!references.length) throw errors.validation("参考素材模式至少上传 1 个素材");
    if (references.length > MAX_REFERENCE_MEDIA) {
      throw errors.validation(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`);
    }
    if (first || last) throw errors.validation("参考素材模式不接受首尾帧");
  } else if (input.mode === "frames") {
    if (!first) throw errors.validation("首尾帧模式需要先上传首帧");
    if (references.length) throw errors.validation("首尾帧模式不接受参考素材");
  } else if (inputs.length) {
    throw errors.validation("纯文本模式不需要上传素材");
  }

  const stored: StoredSubmitInput = {
    autoAccount: Boolean(input.autoAccount),
    assets: input.assets,
    localAssets: localInputs,
  };

  /**
   * 先落任务、再在后台选号与上传：
   * 点击提交后立刻出现在任务队列里，阶段从「选号中」或「上传素材中」开始推进。
   * 自动模式用当前激活账号占位，选号成功后由后台覆盖 accountId。
   */
  let placeholderId: string;
  if (input.autoAccount) {
    const active = await prisma.account.findFirst({
      where: { isActive: true },
      select: { id: true },
    });
    if (!active) throw errors.noActiveAccount();
    placeholderId = active.id;
  } else {
    placeholderId = (await getActiveCredentials()).account.id;
  }

  // 直接素材先确认仍然存在；归属校验留到选号完成后（自动模式可能换号）。
  const directIds = [...new Set(input.assets.map((a) => a.id))];
  const owned = directIds.length
    ? await prisma.asset.findMany({ where: { id: { in: directIds } } })
    : [];
  if (owned.length !== directIds.length) {
    throw errors.validation("部分素材已失效，请重新选择");
  }
  if (!input.autoAccount && owned.some((asset) => asset.accountId !== placeholderId)) {
    throw errors.validation("素材不属于当前激活账号，请重新上传");
  }

  // 上游素材约 7 天后失效：没有本地副本的无法恢复，入队前就拒绝；
  // 有本地副本的交给后台重传续期，不再阻塞这次提交。
  const expired = owned.find((asset) => !isRemoteAssetFresh(asset) && !asset.localAssetId);
  if (expired) {
    throw errors.validation(`素材「${expired.filename}」已在云端过期，请重新选择`);
  }

  // 本地素材先确认都存在，避免任务落库后才发现文件已被删除。
  const localIds = [...new Set(localInputs.map((item) => item.id))];
  const localRows = localIds.length
    ? await prisma.localAsset.findMany({ where: { id: { in: localIds } } })
    : [];
  if (localRows.length !== localIds.length) {
    throw errors.validation("部分素材已被删除，请重新选择");
  }

  // 固定账号不做选号，提交时就在这里挡住同账号并发：
  // 免费账号同时只能跑一个视频，第二单会被上游直接拒绝。
  if (!input.autoAccount) {
    const busy = await prisma.task.count({ where: busyTaskFilter(placeholderId) });
    if (busy > 0) {
      throw new AppError("CONFLICT", "该账号正在生成其他任务，请稍后再试", 409);
    }
  }

  const task = await prisma.task.create({
    data: {
      accountId: placeholderId,
      mode: input.mode,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      duration: input.duration,
      resolution: input.resolution,
      qualityType: input.qualityType,
      status: "preparing",
      // 阶段串起整个后台流程：选号中 → 上传素材中 → 提交中 → 排队中 → 模型生成中
      stage: input.autoAccount ? "选号中" : "上传素材中",
      submitInputs: JSON.stringify(stored),
    },
    include: includeAccount,
  });

  // 预检与落库之间可能被自动选号抢先占用同一账号：落库后再核对一次，
  // 冲突就撤销刚建的记录，避免同账号并发被上游拒绝。
  if (!input.autoAccount) {
    const conflict = await prisma.task.count({
      where: { id: { not: task.id }, ...busyTaskFilter(placeholderId) },
    });
    if (conflict > 0) {
      await prisma.task.delete({ where: { id: task.id } }).catch(() => undefined);
      throw new AppError("CONFLICT", "该账号正在生成其他任务，请稍后再试", 409);
    }
  }

  publish({ type: "task.created", task: toView(task) });

  // 立即返回：选号、素材上传和上游提交都在后台继续，失败会更新任务状态供用户重试。
  void runSubmission(task.id).catch((err) => {
    logger.error("task.submit_background_failed", {
      taskId: task.id,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return toView(task);
}

/**
 * 后台选号、上传素材并提交上游。失败时把任务标记为失败：
 * 选号 / 素材上传阶段可重试；上游已开始创建后的失败不提供重试。
 */
async function runSubmission(taskId: string): Promise<void> {
  if (submittingTasks.has(taskId)) return;
  submittingTasks.add(taskId);
  // 阶段决定失败文案与是否可重试：选号、上传失败可重试，提交失败不重试。
  let phase: "select" | "prepare" | "submit" = "select";
  try {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    // 已被删除或没有提交快照（已提交成功）的任务无需继续
    if (!task?.submitInputs) return;
    const stored = JSON.parse(task.submitInputs) as StoredSubmitInput;

    let creds: ActiveCredentials;
    if (stored.autoAccount) {
      // 选号在后台串行进行，选中后立刻把任务改挂到该账号并推进阶段。
      creds = await withAutoAccount(async (selected) => {
        // 选号期间（含上游校验）可能有固定账号的任务占用了它，占位前再确认一次。
        // 自己的任务此时还是「选号中」，不会被算成忙碌。
        const busy = await prisma.task.count({ where: busyTaskFilter(selected.account.id) });
        if (busy > 0) {
          throw errors.validation("账号刚被其他任务占用，请稍后重试");
        }
        await updateTaskStage(taskId, { accountId: selected.account.id, stage: "上传素材中" });
        return selected;
      });
    } else {
      phase = "prepare";
      creds = await getAccountCredentials(task.accountId);
    }
    phase = "prepare";
    // 选号期间用户可能已经把任务删掉了，别为一个不存在的任务继续上传/消耗额度。
    const alive = await prisma.task.findUnique({ where: { id: taskId }, select: { id: true } });
    if (!alive) return;
    const { ctx, account } = creds;

    // 直接素材重新校验归属：重试时可能已经换到另一个账号。
    const directIds = stored.assets.map((a) => a.id);
    const owned = directIds.length
      ? await prisma.asset.findMany({ where: { id: { in: directIds }, accountId: account.id } })
      : [];
    if (owned.length !== new Set(directIds).size) {
      const existingIds = await prisma.asset.findMany({
        where: { id: { in: directIds } },
        select: { id: true },
      });
      if (existingIds.length !== new Set(directIds).size) {
        throw unrecoverable("部分素材已失效，请重新选择");
      }
      throw unrecoverable("素材不属于当前账号，请重新选择");
    }

    // 上游素材过期时用本地副本重新上传续期，和本地上传并行执行。
    const refreshedOwned = new Map<string, Awaited<ReturnType<typeof resolveLocalAssetForAccount>>>();
    const localIds = [...new Set(stored.localAssets.map((item) => item.id))];
    const localRows = localIds.length
      ? await prisma.localAsset.findMany({ where: { id: { in: localIds } } })
      : [];
    if (localRows.length !== localIds.length) {
      throw unrecoverable("部分素材已被删除，请重新选择");
    }

    const resolvedLocal = new Map<string, Awaited<ReturnType<typeof resolveLocalAssetForAccount>>>();
    await Promise.all([
      ...owned.map(async (asset) => {
        if (isRemoteAssetFresh(asset)) {
          refreshedOwned.set(asset.id, asset);
          return;
        }
        if (!asset.localAssetId) {
          throw unrecoverable(`素材「${asset.filename}」已在云端过期，请重新选择`);
        }
        refreshedOwned.set(
          asset.id,
          await resolveLocalAssetForAccount(asset.localAssetId, account.id, ctx)
        );
      }),
      ...localRows.map(async (row) => {
        resolvedLocal.set(row.id, await resolveLocalAssetForAccount(row.id, account.id, ctx));
      }),
    ]);

    // 按原始顺序合并：直选素材用上游记录，本地素材用上传后得到的记录。
    const resolved = [
      ...stored.assets.map((item) => ({
        assetId: item.id,
        role: item.role,
        position: item.position,
      })),
      ...stored.localAssets.map((item) => ({
        assetId: resolvedLocal.get(item.id)!.id,
        role: item.role,
        position: item.position,
      })),
    ].sort((a, b) => a.position - b.position);

    const byId = new Map(
      [...refreshedOwned.values(), ...resolvedLocal.values()].map((asset) => [asset.id, asset])
    );

    // 同一素材被重复选择时只登记一次：TaskAsset 的主键是 (任务, 素材, 角色)，
    // 而本地素材按内容哈希去重，重复上传同一文件会拿到同一个 Asset。
    const uniqueResolved = resolved.filter(
      (item, index) =>
        resolved.findIndex(
          (other) => other.assetId === item.assetId && other.role === item.role
        ) === index
    );
    const firstAsset = uniqueResolved.find((a) => a.role === "first");
    const lastAsset = uniqueResolved.find((a) => a.role === "last");
    const payload: GenerationPayload = {
      mode: task.mode as GenerationPayload["mode"],
      prompt: task.prompt,
      aspectRatio: task.aspectRatio,
      duration: task.duration,
      resolution: task.resolution,
      qualityType: task.qualityType,
      referenceMedia: uniqueResolved
        .filter((a) => a.role === "reference")
        .map((a) => ({
          id: byId.get(a.assetId)!.remoteId,
          type: byId.get(a.assetId)!.kind === "video" ? 1 : 0,
        })),
      ...(firstAsset ? { startFrameId: byId.get(firstAsset.assetId)!.remoteId } : {}),
      ...(lastAsset ? { endFrameId: byId.get(lastAsset.assetId)!.remoteId } : {}),
    };

    // 重试时清掉上一次留下的自动关联，手动关联保持不变。
    await prisma.taskAsset.deleteMany({ where: { taskId } });
    await prisma.taskLocalAsset.deleteMany({ where: { taskId, manual: false } });

    if (uniqueResolved.length) {
      await prisma.taskAsset.createMany({
        data: uniqueResolved.map((a) => ({
          taskId,
          assetId: a.assetId,
          role: a.role,
          position: a.position,
        })),
      });

      // 同时把有本地副本的素材写进不依赖任务的关联表：
      // 之后不管任务、账号怎么删，本地文件详情和复用都还能找到它们。
      // 临时素材提交后会删除，不登记。
      const bound = await prisma.asset.findMany({
        where: {
          id: { in: uniqueResolved.map((a) => a.assetId) },
          localAssetId: { not: null },
        },
        select: {
          id: true,
          localAssetId: true,
          localAsset: { select: { temporary: true } },
        },
      });
      const localByAsset = new Map(
        bound
          .filter((item) => item.localAsset && !item.localAsset.temporary)
          .map((item) => [item.id, item.localAssetId as string])
      );
      const links = new Map<string, { role: string; position: number }>();
      for (const item of uniqueResolved) {
        const localAssetId = localByAsset.get(item.assetId);
        if (!localAssetId || links.has(localAssetId)) continue;
        links.set(localAssetId, { role: item.role, position: item.position });
      }
      if (links.size) {
        await prisma.taskLocalAsset.createMany({
          data: [...links].map(([localAssetId, link]) => ({
            taskId,
            localAssetId,
            role: link.role,
            position: link.position,
            manual: false,
          })),
        });
      }
    }

    // 任务在素材上传期间被删除时不再提交，避免留下没有本地记录的孤儿上游任务。
    const marked = await updateTaskStage(taskId, { stage: "提交中" });
    if (!marked) {
      logger.warn("task.deleted_before_submit", { taskId });
      return;
    }
    // 从这里开始上游可能已经创建任务，失败不再提供重试，避免重复消耗额度。
    phase = "submit";
    const { remoteId } = await getProvider().create(ctx, payload);
    // 任务行可能在素材上传期间被用户删除；此时上游已创建成功，不能让整条请求 500。
    const running = await prisma.task
      .update({
        where: { id: taskId },
        data: {
          remoteId,
          status: "running",
          // 上游任务已创建，等待上游排队与生成；后续阶段由轮询覆盖。
          stage: "排队中",
          submitInputs: null,
        },
        include: includeAccount,
      })
      .catch(() => null);
    if (!running) {
      logger.warn("task.deleted_while_submitting", { taskId, remoteId });
      return;
    }
    publish({ type: "task.updated", task: toView(running) });
    // 未开启「自动存盘 → 素材」时，文件已上传到上游，本地临时副本可以清掉。
    const temporaryIds = localRows.filter((row) => row.temporary).map((row) => row.id);
    if (temporaryIds.length) {
      void removeTemporaryLocalAssets(temporaryIds).catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "提交失败";
    const details = err instanceof AppError ? (err.details as { retryable?: boolean } | undefined) : undefined;
    // 只有选号 / 准备阶段、且错误可恢复时才保留快照供重试；上游创建失败不重试，避免重复消耗额度。
    const canRetry = phase !== "submit" && details?.retryable !== false;
    const failStage =
      phase === "select" ? "选号失败" : phase === "prepare" ? "上传素材失败" : "提交失败";
    const failed = await prisma.task
      .update({
        where: { id: taskId },
        data: {
          status: "failed",
          stage: failStage,
          errorMessage: message,
          finishedAt: new Date(),
          ...(canRetry ? {} : { submitInputs: null }),
        },
        include: includeAccount,
      })
      .catch(() => null);
    if (failed) publish({ type: "task.updated", task: toView(failed) });
    logger.warn("task.background_failed", { taskId, phase, message });
  } finally {
    submittingTasks.delete(taskId);
  }
}

/**
 * 重试一个选号 / 素材上传阶段失败的任务。
 * 自动模式重新走一遍后台选号；固定账号忙碌时先拒绝，避免顶掉正在生成的任务。
 */
export async function retryTask(id: string): Promise<TaskView> {
  // 与服务重启恢复保持顺序，避免刚恢复的 preparing 行被误判为中断。
  await recoverInterruptedSubmissions();
  const task = await getTaskRow(id);
  if (!task.submitInputs || task.status !== "failed" || task.remoteId) {
    throw errors.badRequest("该任务当前不可重试");
  }
  if (submittingTasks.has(id)) {
    throw new AppError("CONFLICT", "任务正在提交中，请稍候", 409);
  }

  const stored = JSON.parse(task.submitInputs) as StoredSubmitInput;

  // 固定账号先做预检，避免重置成准备中之后才发现根本提交不了。
  if (!stored.autoAccount) {
    const account = await prisma.account.findUnique({ where: { id: task.accountId } });
    if (!account) throw errors.validation("任务对应账号已被删除");
    if (account.status === "invalid") {
      throw errors.validation("任务对应账号登录态已失效，请先更新 JWT");
    }
    if (isCreditsExhausted(account.creditsResetAt)) {
      throw errors.validation("该账号今日免费积分已用完，请切换账号后再试");
    }
    const busy = await prisma.task.count({
      where: { id: { not: id }, ...busyTaskFilter(task.accountId) },
    });
    if (busy > 0) {
      throw new AppError("CONFLICT", "该账号正在生成其他任务，请稍后再试", 409);
    }
    // 凭据解不开时提前报错，而不是把任务重置成功后再失败。
    await getAccountCredentials(task.accountId);
  }

  const updated = await prisma.task.update({
    where: { id },
    data: {
      status: "preparing",
      // 自动模式重新选号，固定账号直接从上传素材开始。
      stage: stored.autoAccount ? "选号中" : "上传素材中",
      errorMessage: null,
      finishedAt: null,
      progress: 0,
    },
    include: includeAccount,
  });
  publish({ type: "task.updated", task: toView(updated) });
  void runSubmission(id).catch((err) => {
    logger.error("task.retry_background_failed", {
      taskId: id,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  return toView(updated);
}

export async function listTasks(options: { accountId?: string; limit?: number } = {}): Promise<TaskView[]> {
  // 首次拉取前先完成重启恢复，避免界面把中断的 preparing 任务当成仍在提交。
  await recoverInterruptedSubmissions();
  const take = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const base = options.accountId ? { accountId: options.accountId } : {};
  // 未结束与失败的任务必须全部返回（失败记录要留在队列里让用户重试/删除），
  // 不能被条数上限挤掉；只有已成功的历史视频按 limit 截断。
  const [unfinished, succeeded] = await Promise.all([
    prisma.task.findMany({
      where: { ...base, status: { in: ["preparing", "queued", "running", "failed"] } },
      include: includeAccount,
      orderBy: { createdAt: "desc" },
    }),
    prisma.task.findMany({
      where: { ...base, status: "succeeded" },
      include: includeAccount,
      orderBy: { createdAt: "desc" },
      take,
    }),
  ]);
  return [...unfinished, ...succeeded]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(toView);
}

/** 只删除本地历史记录，不影响上游任务或已生成的视频。 */
export async function deleteTask(
  id: string,
  options: { deleteRemote?: boolean } = {}
): Promise<void> {
  const task = await prisma.task.findUnique({
    where: { id },
    select: {
      id: true,
      remoteId: true,
      accountId: true,
      status: true,
      account: { select: { tokenCipher: true } },
    },
  });
  if (!task) throw errors.notFound("任务不存在");

  // 进行中的任务还占着账号名额：删掉本地记录后，这个占用就看不见了，
  // 后续自动选号可能把同一个账号再派给新任务，被上游拒绝并发。
  if (task.status === "preparing" || task.status === "queued" || task.status === "running") {
    throw new AppError(
      "CONFLICT",
      "任务仍在提交或生成中，等它结束后再删除",
      409
    );
  }

  if (options.deleteRemote) {
    if (!task.remoteId) {
      throw errors.validation("这条记录没有上游任务 ID，无法删除 Viggle 视频；请取消勾选后仅删除本地记录");
    }
    let token: string;
    try {
      token = decryptSecret(task.account.tokenCipher, config.credentialsKey);
    } catch {
      throw errors.validation("账号凭据无法解密，请更新该账号的 JWT 后重试");
    }
    // 上游删除成功才移除本地记录；失败时保留记录，用户仍可重试。
    await getProvider().deleteRemoteTask(
      { accountId: task.accountId, token },
      task.remoteId
    );
  }

  await prisma.task.delete({ where: { id } });
  publish({ type: "task.deleted", id });
}

export interface DeleteTasksResult {
  deleted: number;
  deletedIds: string[];
  failed: Array<{ id: string; message: string }>;
}

/**
 * 批量删除历史记录：单条失败不影响其它记录，逐条复用现有删除逻辑。
 * 勾选删除上游时，没有上游任务 ID 的记录只删本地，避免整条失败。
 */
export async function deleteTasks(
  ids: string[],
  options: { deleteRemote?: boolean } = {}
): Promise<DeleteTasksResult> {
  const uniqueIds = [...new Set(ids)];
  const result: DeleteTasksResult = { deleted: 0, deletedIds: [], failed: [] };
  if (!uniqueIds.length) return result;

  const rows = await prisma.task.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, remoteId: true },
  });
  const withRemote = new Set(rows.filter((row) => row.remoteId).map((row) => row.id));

  for (const id of uniqueIds) {
    try {
      await deleteTask(id, {
        deleteRemote: Boolean(options.deleteRemote) && withRemote.has(id),
      });
      result.deleted += 1;
      result.deletedIds.push(id);
    } catch (err) {
      result.failed.push({ id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export async function getTask(id: string): Promise<TaskView> {
  const task = await prisma.task.findUnique({ where: { id }, include: includeAccount });
  if (!task) throw errors.notFound("任务不存在");
  return toView(task);
}

export async function getTaskRow(id: string): Promise<TaskWithAccount> {
  const task = await prisma.task.findUnique({ where: { id }, include: includeAccount });
  if (!task) throw errors.notFound("任务不存在");
  return task;
}

export interface ReuseTaskAsset {
  role: AssetRole;
  position: number;
  asset: LocalAssetView;
}

/**
 * 本地副本缺失时，按任务的上游记录解析素材的最新直链。
 * 上游记录约 7 天后清理，解析失败只记日志，不影响详情展示与其它素材。
 */
async function loadTaskMediaSources(taskId: string): Promise<Map<string, RemoteMediaSource>> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { accountId: true, remoteId: true },
  });
  if (!task?.remoteId) return new Map();
  try {
    const { ctx } = await getAccountCredentials(task.accountId);
    const items = await getProvider().getReferenceMedia(ctx, task.remoteId);
    return new Map(items.map((item) => [item.remoteId, item]));
  } catch (err) {
    logger.warn("task.media_sources_failed", {
      taskId,
      message: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * 任务详情里展示用到的素材：优先用本地副本地址，否则按上游记录实时解析。
 * 只读不下载，和「复用」分开。
 */
export async function listTaskAssets(taskId: string): Promise<TaskAssetView[]> {
  const [rows, manual] = await Promise.all([
    prisma.taskAsset.findMany({
      where: { taskId },
      include: { asset: { include: { localAsset: true } } },
    }),
    // 本地素材关联排在真实素材后面展示
    prisma.taskLocalAsset.findMany({
      where: { taskId },
      orderBy: { position: "asc" },
      include: { localAsset: true },
    }),
  ]);
  // 没有本地副本的素材需要上游地址；本地视频没有本地封面时，也要取一次上游封面。
  // 超过保留期的记录上游一定 404，直接用占位，不再发请求。
  const sources = rows.some((row) => {
    const local = row.asset.localAsset;
    return (
      isRemoteAssetFresh(row.asset) &&
      (!local || (local.kind === "video" && !toLocalAssetView(local).coverUrl))
    );
  })
    ? await loadTaskMediaSources(taskId)
    : new Map<string, RemoteMediaSource>();
  const weight = (role: string) => (role === "first" ? 0 : role === "last" ? 2 : 1);
  const views: TaskAssetView[] = rows
    .sort((a, b) => weight(a.role) - weight(b.role) || a.position - b.position)
    .map((row) => {
      const asset = row.asset;
      const local = asset.localAsset ? toLocalAssetView(asset.localAsset) : null;
      const source = sources.get(asset.remoteId);
      // 优先使用本地缩略图；无封面的小图回退原图，视频回退上游封面或占位。
      const previewUrl = local
        ? local.coverUrl ??
          (local.kind === "video" ? source?.previewUrl ?? null : local.url)
        : source?.previewUrl ?? null;
      return {
        role: row.role as AssetRole,
        position: row.position,
        kind: asset.kind as TaskAssetView["kind"],
        filename: asset.filename,
        mime: asset.mime,
        previewUrl,
      };
    });
  const shownLocalIds = new Set(rows.map((row) => row.asset.localAssetId).filter(Boolean));
  manual.forEach((item) => {
    const local = toLocalAssetView(item.localAsset);
    // 这份文件可能已经作为真实素材的本地副本展示过了，不重复出现
    if (shownLocalIds.has(local.id)) return;
    shownLocalIds.add(local.id);
    views.push({
      role: item.role as AssetRole,
      position: item.position,
      kind: local.kind as TaskAssetView["kind"],
      filename: local.originalName,
      mime: local.mime,
      previewUrl: local.coverUrl ?? (local.kind === "video" ? null : local.url),
      manual: item.manual,
    });
  });
  return views;
}

/**
 * 手动把本地素材箱里的文件关联到历史任务：
 * 用于上游文件已删、素材箱虽然有同一份文件却无法自动匹配的情况。
 * 任务记录可能已经删除（本地文件详情仍可打开），所以不要求 Task 存在。
 */
export async function addTaskManualAssets(
  taskId: string,
  localAssetIds: string[]
): Promise<TaskAssetView[]> {
  const unique = [...new Set(localAssetIds)].filter(Boolean).slice(0, 20);
  if (!unique.length) throw errors.validation("请选择要关联的本地素材");
  const localRows = await prisma.localAsset.findMany({ where: { id: { in: unique } } });
  if (!localRows.length) throw errors.validation("素材文件不存在，可能已被删除");

  const byId = new Map(localRows.map((row) => [row.id, row]));
  const picked = unique
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
  const existing = await prisma.taskLocalAsset.findMany({
    where: { taskId },
    select: { localAssetId: true, position: true },
  });
  const existingIds = new Set(existing.map((row) => row.localAssetId));
  const fresh = picked.filter((row) => !existingIds.has(row.id));
  if (fresh.length) {
    const start =
      existing.reduce((max, row) => Math.max(max, row.position), -1) + 1;
    await prisma.taskLocalAsset.createMany({
      data: fresh.map((row, index) => ({
        taskId,
        localAssetId: row.id,
        role: "reference",
        manual: true,
        position: start + index,
      })),
    });
  }
  return listTaskAssets(taskId);
}

/**
 * 把历史任务用到的素材重新落到本地素材箱，供工作台复用。
 * 优先使用仍存在的本地副本；副本已被清理时回退到上游地址重新下载。
 * 单个素材失败只记日志并跳过，不影响其它素材和提示词本身。
 */
export async function reuseTaskAssets(
  taskId: string
): Promise<{ assets: ReuseTaskAsset[]; skipped: number }> {
  const [task, localLinks] = await Promise.all([
    prisma.task.findUnique({
      where: { id: taskId },
      include: {
        assets: {
          orderBy: { position: "asc" },
          include: { asset: { include: { localAsset: true } } },
        },
      },
    }),
    prisma.taskLocalAsset.findMany({
      where: { taskId },
      orderBy: { position: "asc" },
      include: { localAsset: true },
    }),
  ]);
  // 任务记录已删（例如从本地文件详情复用）时，本地素材关联仍能还原
  if (!task) {
    return {
      assets: localLinks.map((item, index) => ({
        role: item.role as AssetRole,
        position: item.position ?? index,
        asset: toLocalAssetView(item.localAsset),
      })),
      skipped: 0,
    };
  }

  // 首帧、参考素材、尾帧依次排列，参考素材按原始顺序
  const weight = (role: string) => (role === "first" ? 0 : role === "last" ? 2 : 1);
  const rows = [...task.assets].sort(
    (a, b) => weight(a.role) - weight(b.role) || a.position - b.position
  );
  // 没有本地副本的素材要靠上游记录重新解析地址；上游记录过期就只能跳过
  const sources = rows.some((row) => !row.asset.localAsset && isRemoteAssetFresh(row.asset))
    ? await loadTaskMediaSources(taskId)
    : new Map<string, RemoteMediaSource>();

  const assets: ReuseTaskAsset[] = [];
  let skipped = 0;
  // 与上传保持一致：关闭「自动存盘 → 素材」时，复用产生的副本也算临时文件
  const keepAssets = await getKeepAssets();
  for (const row of rows) {
    const role = row.role as AssetRole;
    if (row.asset.localAsset) {
      assets.push({ role, position: row.position, asset: toLocalAssetView(row.asset.localAsset) });
      continue;
    }
    const sourceUrl = isRemoteAssetFresh(row.asset)
      ? sources.get(row.asset.remoteId)?.url ?? null
      : null;
    if (!sourceUrl) {
      skipped += 1;
      continue;
    }
    try {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const saved = await saveLocalAsset({
        buffer,
        mime: row.asset.mime || (row.asset.kind === "video" ? "video/mp4" : "image/png"),
        originalName: row.asset.filename,
        temporary: !keepAssets,
      });
      // 记下本地副本：详情缩略图优先用它，再次复用也不必重复下载
      await prisma.asset
        .updateMany({ where: { id: row.asset.id, localAssetId: null }, data: { localAssetId: saved.id } })
        .catch(() => {});
      assets.push({ role, position: row.position, asset: toLocalAssetView(saved) });
    } catch (err) {
      skipped += 1;
      logger.warn("task.reuse_asset_failed", {
        taskId,
        assetId: row.asset.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 本地素材关联：本来就在本地，直接还原，不需要下载。
  // 生成时写入的保留原角色；手动补关联的按参考素材处理，
  // 首尾帧模式则按顺序补齐缺失的首帧 / 尾帧。
  const usedLocalIds = new Set(assets.map((item) => item.asset.id));
  for (const item of localLinks) {
    if (usedLocalIds.has(item.localAssetId) || task.mode === "text") continue;
    let role = item.role as AssetRole;
    if (item.manual && task.mode === "frames") {
      if (!assets.some((asset) => asset.role === "first")) role = "first";
      else if (!assets.some((asset) => asset.role === "last")) role = "last";
      else continue;
    }
    assets.push({
      role,
      position: role === "first" ? 0 : role === "last" ? 1 : item.position,
      asset: toLocalAssetView(item.localAsset),
    });
    usedLocalIds.add(item.localAssetId);
  }
  return { assets, skipped };
}

async function markFailed(task: TaskWithAccount, message: string): Promise<TaskView> {
  const updated = await prisma.task.update({
    where: { id: task.id },
    data: {
      status: "failed",
      stage: "生成失败",
      errorMessage: message,
      finishedAt: new Date(),
    },
    include: includeAccount,
  });
  const view = toView(updated);
  publish({ type: "task.updated", task: view });
  return view;
}

/** 单个任务的一次状态刷新，由后台守护或手动刷新调用。 */
export async function refreshTask(id: string): Promise<TaskView> {
  const task = await getTaskRow(id);
  // 已结束的任务不再请求上游：本地文件被手动删除后，这里也不会把它重新下回来。
  if (task.status !== "queued" && task.status !== "running") return toView(task);
  if (!task.remoteId) {
    // queued 表示上游创建请求仍在进行，此时没有 remoteId 属于正常状态。
    if (task.status === "queued") return toView(task);
    return markFailed(task, "任务尚未获得上游 ID，请重新发起生成");
  }

  let token: string;
  try {
    token = decryptSecret(task.account.tokenCipher, config.credentialsKey);
  } catch {
    return markFailed(task, "账号凭据无法解密，请检查 CREDENTIALS_KEY");
  }

  try {
    const state = await getProvider().poll(
      { accountId: task.accountId, token },
      task.remoteId,
      task.createdAt
    );
    const terminal = state.status === "succeeded" || state.status === "failed";
    // 进度、阶段这类心跳写入不能刷新 updatedAt，否则守护进程按「最后状态变化」
    // 计算的超时窗口会被每次轮询重置，任务就永远卡在生成中。
    const meaningfulChange =
      task.status !== state.status ||
      task.remoteStatus !== state.remoteStatus ||
      task.videoUrl !== state.videoUrl ||
      task.errorMessage !== state.errorMessage;
    const updated = await prisma.task.update({
      where: { id },
      data: {
        remoteStatus: state.remoteStatus,
        status: state.status,
        stage: state.stage,
        progress: state.progress,
        videoUrl: state.videoUrl,
        coverUrl: state.coverUrl,
        errorMessage: state.errorMessage,
        ...(terminal ? { finishedAt: new Date() } : {}),
        ...(meaningfulChange ? {} : { updatedAt: task.updatedAt }),
      },
      include: includeAccount,
    });
    const view = toView(updated);
    publish({ type: "task.updated", task: view });
    // 成功即落盘：不阻塞轮询循环，内部自行吞掉下载失败并记日志（受设置页开关控制）。
    if (state.status === "succeeded") void autoPersistTaskVideo(updated);
    return view;
  } catch (err) {
    if (err instanceof AppError && err.code === "TOKEN_INVALID") {
      await prisma.account.update({
        where: { id: task.accountId },
        data: { status: "invalid" },
      });
      void import("./accounts").then((m) => m.syncAccounts());
      return markFailed(task, "该账号登录态已失效，请更新 JWT");
    }
    throw err;
  }
}

export async function markTaskTimedOut(id: string): Promise<TaskView> {
  const task = await getTaskRow(id);
  if (task.status === "succeeded" || task.status === "failed") return toView(task);
  return markFailed(task, "轮询超时：上游在限定时间内未返回结果");
}

/**
 * 恢复一个被误判失败、但上游任务仍在生成的记录。
 * 不重新调用创建接口，因此不会重复消耗额度。
 */
export async function resumeTask(id: string): Promise<TaskView> {
  const task = await getTaskRow(id);
  if (!task.remoteId) throw errors.badRequest("该任务没有上游 ID，无法恢复跟踪");
  if (task.status === "succeeded") return toView(task);

  const updated = await prisma.task.update({
    where: { id },
    data: {
      status: "running",
      stage: "重新同步中",
      errorMessage: null,
      finishedAt: null,
      progress: Math.max(task.progress, 5),
    },
    include: includeAccount,
  });
  const view = toView(updated);
  publish({ type: "task.updated", task: view });
  return view;
}
