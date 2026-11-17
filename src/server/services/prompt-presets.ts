import type { PromptPresetView } from "@/lib/types";
import { prisma } from "../db";
import { errors } from "../errors";

/** 单条预设内容的最大长度，与提示词输入上限保持一致。 */
const MAX_LENGTH = 2000;
/** 标题长度上限。 */
const MAX_TITLE = 40;

function toView(row: {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
}): PromptPresetView {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeContent(content: unknown): string {
  const text = String(content ?? "").trim();
  if (!text) throw errors.validation("提示词内容不能为空");
  if (text.length > MAX_LENGTH) {
    throw errors.validation(`提示词最多 ${MAX_LENGTH} 字，当前 ${text.length} 字`);
  }
  return text;
}

/** 标题留空时取内容首行的前 24 字，避免列表里出现无名条目。 */
function normalizeTitle(title: unknown, content: string): string {
  const text = String(title ?? "").trim();
  if (text) {
    if (text.length > MAX_TITLE) {
      throw errors.validation(`预设标题最多 ${MAX_TITLE} 字，当前 ${text.length} 字`);
    }
    return text;
  }
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return firstLine.trim().slice(0, 24) || "未命名预设";
}

/** 按手动排序的位置展示，未排过序（全为 0）时回落到最近的在前。 */
export async function listPromptPresets(): Promise<PromptPresetView[]> {
  const rows = await prisma.promptPreset.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
  });
  return rows.map(toView);
}

/** 按前端拖动后的顺序整体重排；id 不在库里的条目会被忽略。 */
export async function reorderPromptPresets(ids: unknown): Promise<void> {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id)) {
    throw errors.validation("排序参数不正确");
  }
  if (ids.length > 500) throw errors.validation("预设数量过多，无法一次排序");
  await prisma.$transaction(
    (ids as string[]).map((id, index) =>
      prisma.promptPreset.updateMany({ where: { id }, data: { sortOrder: index } })
    )
  );
}

/** 新建或保存预设；标题与内容都相同时复用已有记录，避免重复。 */
export async function createPromptPreset(input: {
  title?: unknown;
  content?: unknown;
}): Promise<PromptPresetView> {
  const content = normalizeContent(input.content);
  const title = normalizeTitle(input.title, content);
  // 只按内容去重会把用户新填的标题丢掉；标题 + 内容一致才算同一条。
  const existing = await prisma.promptPreset.findFirst({ where: { title, content } });
  if (existing) return toView(existing);
  const created = await prisma.promptPreset.create({ data: { title, content } });
  return toView(created);
}

/** 编辑已保存的预设；校验规则与新建一致，并避免改成与另一条完全相同。 */
export async function updatePromptPreset(
  id: string,
  input: { title?: unknown; content?: unknown }
): Promise<PromptPresetView> {
  const content = normalizeContent(input.content);
  const title = normalizeTitle(input.title, content);
  const clash = await prisma.promptPreset.findFirst({
    where: { title, content, NOT: { id } },
  });
  if (clash) throw errors.validation("已存在相同标题和内容的预设");
  const { count } = await prisma.promptPreset.updateMany({
    where: { id },
    data: { title, content },
  });
  if (!count) throw errors.notFound("预设不存在，可能已被删除");
  const row = await prisma.promptPreset.findUnique({ where: { id } });
  if (!row) throw errors.notFound("预设不存在，可能已被删除");
  return toView(row);
}

export async function deletePromptPreset(id: string): Promise<void> {
  // 用 deleteMany 避免并发删除时抛 P2025，也省一次查询。
  const { count } = await prisma.promptPreset.deleteMany({ where: { id } });
  if (!count) throw errors.notFound("预设不存在，可能已被删除");
}
