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

/** 最近的预设排在前面。 */
export async function listPromptPresets(): Promise<PromptPresetView[]> {
  const rows = await prisma.promptPreset.findMany({
    orderBy: { createdAt: "desc" },
  });
  return rows.map(toView);
}

/** 新建或保存预设；内容完全相同时复用已有记录，避免重复。 */
export async function createPromptPreset(input: {
  title?: unknown;
  content?: unknown;
}): Promise<PromptPresetView> {
  const content = normalizeContent(input.content);
  const title = normalizeTitle(input.title, content);
  const existing = await prisma.promptPreset.findFirst({ where: { content } });
  if (existing) return toView(existing);
  const created = await prisma.promptPreset.create({ data: { title, content } });
  return toView(created);
}

export async function deletePromptPreset(id: string): Promise<void> {
  const record = await prisma.promptPreset.findUnique({ where: { id } });
  if (!record) throw errors.notFound("预设不存在，可能已被删除");
  await prisma.promptPreset.delete({ where: { id } });
}
