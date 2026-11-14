import type { Account, Prisma } from "@prisma/client";
import { buildAccountExport, type ExportAccount, type ExportFormat } from "@/lib/account-export";
import type { AccountStatus, AccountView, UserProfile } from "@/lib/types";
import { config } from "../config";
import { decryptSecret, encryptSecret, maskToken, normalizeToken } from "../crypto";
import { prisma } from "../db";
import { AppError, errors } from "../errors";
import { publish } from "../events";
import { logger } from "../logger";
import { getProvider } from "../provider";
import type { ProviderContext } from "../provider/types";
import { closeSession } from "../provider/viggle/session";
import { createAccountSchema, importAccountsSchema, parse, updateAccountSchema } from "../validation";

export interface ActiveCredentials {
  account: Account;
  token: string;
  ctx: ProviderContext;
}

function toView(account: Account): AccountView {
  let tokenMask = "无法解密";
  try {
    tokenMask = maskToken(decryptSecret(account.tokenCipher, config.credentialsKey));
  } catch {
    // 密钥轮换后不影响列表展示，仅标记不可读
  }
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    nickname: account.nickname,
    isActive: account.isActive,
    status: account.status as AccountStatus,
    lastCheckedAt: account.lastCheckedAt?.toISOString() ?? null,
    freeCredits: account.freeCredits,
    note: account.note,
    tokenMask,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

function decryptOrThrow(account: Account): string {
  try {
    return decryptSecret(account.tokenCipher, config.credentialsKey);
  } catch {
    throw errors.internal("账号凭据无法解密，请确认 CREDENTIALS_KEY 未被更换");
  }
}

export async function listAccounts(): Promise<AccountView[]> {
  const rows = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(toView);
}

/** 账号任何变更后广播全量快照，避免前端出现多个 active 状态。 */
export async function syncAccounts(): Promise<AccountView[]> {
  const accounts = await listAccounts();
  publish({ type: "accounts.synced", accounts });
  return accounts;
}

async function getAccountOrThrow(id: string): Promise<Account> {
  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) throw errors.notFound("账号不存在");
  return account;
}

function safeToken(raw: string): string {
  try {
    return normalizeToken(raw);
  } catch (err) {
    throw errors.validation(err instanceof Error ? err.message : "JWT 格式不正确");
  }
}

export async function createAccount(raw: unknown): Promise<AccountView> {
  const input = parse(createAccountSchema, raw);
  const token = safeToken(input.token);
  const tokenCipher = encryptSecret(token, config.credentialsKey);
  const isFirst = (await prisma.account.count()) === 0;

  const account = await prisma.account.create({
    data: {
      label: input.label,
      tokenCipher,
      note: input.note || null,
      isActive: isFirst,
    },
  });

  // 校验失败不阻止保存：账号仍可保留，等待用户更新 JWT 后重试。
  try {
    const profile = await getProvider().verify({ accountId: account.id, token });
    await prisma.account.update({
      where: { id: account.id },
      data: {
        status: "valid",
        lastCheckedAt: new Date(),
        nickname: profile.nickname || null,
        email: profile.email || null,
        freeCredits: profile.freeCredits,
      },
    });
  } catch (err) {
    await prisma.account.update({
      where: { id: account.id },
      data: { status: "invalid", lastCheckedAt: new Date() },
    });
    logger.warn("account.verify_failed", {
      accountId: account.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const accounts = await syncAccounts();
  return accounts.find((a) => a.id === account.id) ?? toView(account);
}

export interface ImportAccountsResult {
  created: string[];
  skipped: Array<{ label: string; reason: string }>;
}

/**
 * 批量导入 Cookie 导出文件里的 Viggle 账号。
 * 不做即时上游校验：一次导入几十个账号时逐个请求上游既慢又容易触发风控，
 * 保存后由用户按需点击「校验」即可。
 */
export async function importAccounts(raw: unknown): Promise<ImportAccountsResult> {
  const { accounts } = parse(importAccountsSchema, raw);
  const existing = await prisma.account.findMany({
    select: { label: true, tokenCipher: true },
  });
  const tokens = new Set<string>();
  const labels = new Set<string>();
  for (const row of existing) {
    labels.add(row.label);
    try {
      tokens.add(normalizeToken(decryptSecret(row.tokenCipher, config.credentialsKey)));
    } catch {
      // 密钥轮换后无法解密的旧账号不参与 JWT 去重
    }
  }

  let activateFirst = existing.length === 0;
  const created: string[] = [];
  const skipped: Array<{ label: string; reason: string }> = [];

  for (const item of accounts) {
    let token: string;
    try {
      token = safeToken(item.token);
    } catch {
      skipped.push({ label: item.label, reason: "JWT 格式无效" });
      continue;
    }
    if (tokens.has(token)) {
      skipped.push({ label: item.label, reason: "JWT 已存在" });
      continue;
    }
    let label = item.label;
    for (let suffix = 2; labels.has(label); suffix += 1) {
      label = `${item.label.slice(0, 36)} (${suffix})`;
    }
    await prisma.account.create({
      data: {
        label,
        tokenCipher: encryptSecret(token, config.credentialsKey),
        isActive: activateFirst,
      },
    });
    activateFirst = false;
    tokens.add(token);
    labels.add(label);
    created.push(label);
  }

  await syncAccounts();
  return { created, skipped };
}

export interface ExportResult {
  filename: string;
  count: number;
  /** 凭据无法解密（例如 CREDENTIALS_KEY 被更换）而跳过的账号数 */
  skipped: number;
  data: unknown;
}

/** 导出全部已保存账号；明文 JWT 仅在本次响应里出现，不写日志、不落盘。 */
export async function exportAccounts(format: string): Promise<ExportResult> {
  if (format !== "cookie-profile" && format !== "studio") {
    throw errors.validation("不支持的导出格式");
  }
  const rows = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  const accounts: ExportAccount[] = [];
  let skipped = 0;

  for (const row of rows) {
    let token: string;
    try {
      token = normalizeToken(decryptSecret(row.tokenCipher, config.credentialsKey));
    } catch {
      skipped += 1;
      continue;
    }
    accounts.push({
      label: row.label,
      token,
      note: row.note,
      status: row.status,
      email: row.email,
      nickname: row.nickname,
      freeCredits: row.freeCredits,
      createdAt: row.createdAt.toISOString(),
    });
  }

  const bundle = buildAccountExport(format as ExportFormat, accounts);
  return { ...bundle, skipped };
}

export async function updateAccount(id: string, raw: unknown): Promise<AccountView> {
  await getAccountOrThrow(id);
  const input = parse(updateAccountSchema, raw);
  const data: Prisma.AccountUpdateInput = {};

  if (input.label !== undefined) data.label = input.label;
  if (input.note !== undefined) data.note = input.note || null;
  if (input.token !== undefined) {
    data.tokenCipher = encryptSecret(safeToken(input.token), config.credentialsKey);
    data.status = "unknown";
    data.lastCheckedAt = null;
    closeSession(id);
  }

  const account = await prisma.account.update({ where: { id }, data });
  const accounts = await syncAccounts();
  return accounts.find((a) => a.id === id) ?? toView(account);
}

export async function deleteAccount(id: string): Promise<{ id: string }> {
  await getAccountOrThrow(id);
  await prisma.account.delete({ where: { id } });
  closeSession(id);

  const active = await prisma.account.findFirst({ where: { isActive: true } });
  if (!active) {
    const fallback = await prisma.account.findFirst({ orderBy: { createdAt: "asc" } });
    if (fallback) {
      await prisma.account.update({ where: { id: fallback.id }, data: { isActive: true } });
    }
  }
  await syncAccounts();
  return { id };
}

export async function activateAccount(id: string): Promise<AccountView[]> {
  await getAccountOrThrow(id);
  await prisma.$transaction([
    prisma.account.updateMany({ data: { isActive: false } }),
    prisma.account.update({ where: { id }, data: { isActive: true } }),
  ]);
  return syncAccounts();
}

export async function getActiveCredentials(): Promise<ActiveCredentials> {
  const account = await prisma.account.findFirst({ where: { isActive: true } });
  if (!account) throw errors.noActiveAccount();
  const token = decryptOrThrow(account);
  return { account, token, ctx: { accountId: account.id, token } };
}

export async function getAccountCredentials(id: string): Promise<ActiveCredentials> {
  const account = await getAccountOrThrow(id);
  return { account, token: decryptOrThrow(account), ctx: { accountId: id, token: decryptOrThrow(account) } };
}

export async function verifyAccount(id: string): Promise<UserProfile> {
  const { account, ctx } = await getAccountCredentials(id);
  try {
    const profile = await getProvider().verify(ctx);
    await prisma.account.update({
      where: { id },
      data: {
        status: "valid",
        lastCheckedAt: new Date(),
        nickname: profile.nickname || null,
        email: profile.email || null,
        freeCredits: profile.freeCredits,
      },
    });
    await syncAccounts();
    return profile;
  } catch (err) {
    await prisma.account.update({
      where: { id },
      data: { status: "invalid", lastCheckedAt: new Date() },
    });
    await syncAccounts();
    if (err instanceof AppError) throw err;
    throw errors.upstream("账号校验失败：" + (err instanceof Error ? err.message : "未知错误"));
  }
}

/** /api/me：优先用上游实时数据，失败时回退到上次成功校验的缓存值。 */
export async function getActiveProfile(): Promise<{ profile: UserProfile | null; stale: boolean }> {
  const active = await prisma.account.findFirst({ where: { isActive: true } });
  if (!active) return { profile: null, stale: false };
  const cached: UserProfile = {
    nickname: active.nickname || active.label,
    email: active.email || "",
    freeCredits: active.freeCredits ?? 0,
    subscribeCredits: 0,
    planCredits: 0,
    purchasedCredits: 0,
    remainingFreeMiniMaxVideoGenCount: 0,
  };
  try {
    const ctx: ProviderContext = {
      accountId: active.id,
      token: decryptOrThrow(active),
    };
    const profile = await getProvider().verify(ctx);
    await prisma.account.update({
      where: { id: active.id },
      data: {
        status: "valid",
        lastCheckedAt: new Date(),
        nickname: profile.nickname || null,
        email: profile.email || null,
        freeCredits: profile.freeCredits,
      },
    });
    void syncAccounts();
    return { profile, stale: false };
  } catch {
    return { profile: cached, stale: true };
  }
}
