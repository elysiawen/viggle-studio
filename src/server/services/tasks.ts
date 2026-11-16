import type { Prisma, Task } from "@prisma/client";
import {
  ASPECT_RATIOS,
  FREE_TIER,
  MAX_REFERENCE_MEDIA,
} from "@/lib/constants";
import type { TaskView } from "@/lib/types";
import { config } from "../config";
import { decryptSecret } from "../crypto";
import { prisma } from "../db";
import { AppError, errors } from "../errors";
import { publish } from "../events";
import { getProvider } from "../provider";
import type { GenerationPayload } from "../provider/types";
import { createTaskSchema, parse } from "../validation";
import { getActiveCredentials } from "./accounts";
import { autoPersistTaskVideo } from "./local-videos";

type TaskWithAccount = Task & { account: { label: string; tokenCipher: string } };

const includeAccount = {
  account: { select: { label: true, tokenCipher: true } },
} satisfies Prisma.TaskInclude;

function toView(task: TaskWithAccount): TaskView {
  return {
    id: task.id,
    remoteId: task.remoteId,
    accountId: task.accountId,
    accountLabel: task.account.label,
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
  };
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

type AssetInput = { id: string; role: "reference" | "first" | "last"; position: number };

export async function createTask(raw: unknown): Promise<TaskView> {
  const input = parse(createTaskSchema, raw);
  assertFreeTier(input);

  const assets: AssetInput[] = [...input.assets].sort((a, b) => a.position - b.position);
  const references = assets.filter((a) => a.role === "reference");
  const first = assets.find((a) => a.role === "first");
  const last = assets.find((a) => a.role === "last");

  if (input.mode === "references") {
    if (!references.length) throw errors.validation("参考素材模式至少上传 1 个素材");
    if (references.length > MAX_REFERENCE_MEDIA) {
      throw errors.validation(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`);
    }
    if (first || last) throw errors.validation("参考素材模式不接受首尾帧");
  } else if (input.mode === "frames") {
    if (!first) throw errors.validation("首尾帧模式需要先上传首帧");
    if (references.length) throw errors.validation("首尾帧模式不接受参考素材");
  } else if (assets.length) {
    throw errors.validation("纯文本模式不需要上传素材");
  }

  const { ctx, account } = await getActiveCredentials();

  // 素材必须属于当前激活账号，杜绝切换账号后跨号混用。
  const ids = assets.map((a) => a.id);
  const owned = ids.length
    ? await prisma.asset.findMany({ where: { id: { in: ids }, accountId: account.id } })
    : [];
  if (owned.length !== new Set(ids).size) {
    throw errors.validation("素材不属于当前激活账号，请重新上传");
  }
  const byId = new Map(owned.map((a) => [a.id, a]));

  const payload: GenerationPayload = {
    mode: input.mode,
    prompt: input.prompt,
    aspectRatio: input.aspectRatio,
    duration: input.duration,
    resolution: input.resolution,
    qualityType: input.qualityType,
    referenceMedia: references.map((a) => ({
      id: byId.get(a.id)!.remoteId,
      type: byId.get(a.id)!.kind === "video" ? 1 : 0,
    })),
    ...(first ? { startFrameId: byId.get(first.id)!.remoteId } : {}),
    ...(last ? { endFrameId: byId.get(last.id)!.remoteId } : {}),
  };

  const created = await prisma.task.create({
    data: {
      accountId: account.id,
      mode: input.mode,
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      duration: input.duration,
      resolution: input.resolution,
      qualityType: input.qualityType,
      status: "queued",
      stage: "已提交",
      assets: {
        create: assets.map((a) => ({ assetId: a.id, role: a.role, position: a.position })),
      },
    },
    include: includeAccount,
  });
  publish({ type: "task.created", task: toView(created) });

  try {
    const { remoteId } = await getProvider().create(ctx, payload);
    const running = await prisma.task.update({
      where: { id: created.id },
      data: { remoteId, status: "running", stage: "已提交到上游" },
      include: includeAccount,
    });
    const view = toView(running);
    publish({ type: "task.updated", task: view });
    return view;
  } catch (err) {
    const message = err instanceof Error ? err.message : "创建上游任务失败";
    const failed = await prisma.task.update({
      where: { id: created.id },
      data: {
        status: "failed",
        stage: "提交失败",
        errorMessage: message,
        finishedAt: new Date(),
      },
      include: includeAccount,
    });
    publish({ type: "task.updated", task: toView(failed) });
    if (err instanceof AppError) throw err;
    throw errors.upstream(message);
  }
}

export async function listTasks(options: { accountId?: string; limit?: number } = {}): Promise<TaskView[]> {
  const take = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const rows = await prisma.task.findMany({
    where: options.accountId ? { accountId: options.accountId } : {},
    include: includeAccount,
    orderBy: { createdAt: "desc" },
    take,
  });
  return rows.map(toView);
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
      account: { select: { tokenCipher: true } },
    },
  });
  if (!task) throw errors.notFound("任务不存在");

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
  if (!task.remoteId) return markFailed(task, "任务尚未获得上游 ID，请重新发起生成");

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
