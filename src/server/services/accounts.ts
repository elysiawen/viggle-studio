import type { Account, Prisma } from "@prisma/client";
import { buildAccountExport, type ExportAccount, type ExportFormat } from "@/lib/account-export";
import { FREE_TIER, isCreditsExhausted, nextFreeCreditResetAt } from "@/lib/constants";
import type {
  AccountStatus,
  AccountView,
  AutoSelectResult,
  UserProfile,
  VerifyAllResult,
} from "@/lib/types";
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

/** 从 JWT payload 里读 exp；解析失败返回 null，不影响列表展示 */
function readTokenExpiry(token: string): string | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
    return new Date(payload.exp * 1000).toISOString();
  } catch {
    return null;
  }
}

function toView(account: Account): AccountView {
  let tokenMask = "无法解密";
  let tokenExpiresAt: string | null = null;
  try {
    const token = decryptSecret(account.tokenCipher, config.credentialsKey);
    tokenMask = maskToken(token);
    tokenExpiresAt = readTokenExpiry(token);
  } catch {
    // 密钥轮换后不影响列表展示，仅标记不可读
  }
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    loginEmail: account.loginEmail,
    hasPassword: Boolean(account.passwordCipher),
    nickname: account.nickname,
    isActive: account.isActive,
    status: account.status as AccountStatus,
    lastCheckedAt: account.lastCheckedAt?.toISOString() ?? null,
    freeCredits: account.freeCredits,
    creditsResetAt: account.creditsResetAt?.toISOString() ?? null,
    note: account.note,
    tokenMask,
    tokenExpiresAt,
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

/**
 * 校验结果写库：积分不足时记下下次刷新时刻，刷新前自动选号不再浪费一次校验；
 * 积分够用则清除标记，恢复正常校验。
 */
function creditFields(freeCredits: number): { freeCredits: number; creditsResetAt: Date | null } {
  return {
    freeCredits,
    creditsResetAt:
      freeCredits < FREE_TIER.creditsPerGeneration ? nextFreeCreditResetAt() : null,
  };
}

/** 北京时间展示，用于提示刷新时刻。 */
function formatBeijing(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
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
      loginEmail: input.loginEmail || null,
      passwordCipher: input.loginPassword
        ? encryptSecret(input.loginPassword, config.credentialsKey)
        : null,
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
        ...creditFields(profile.freeCredits),
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
        loginEmail: item.loginEmail || null,
        passwordCipher: item.loginPassword
          ? encryptSecret(item.loginPassword, config.credentialsKey)
          : null,
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
    // 项目自有备份格式额外带上续期凭据，便于整体迁移后仍能一键续期
    let loginEmail: string | null = null;
    let loginPassword: string | null = null;
    if (format === "studio") {
      loginEmail = row.loginEmail;
      if (row.passwordCipher) {
        try {
          loginPassword = decryptSecret(row.passwordCipher, config.credentialsKey);
        } catch {
          loginPassword = null; // 密钥轮换后旧密文解不开，导出时留空
        }
      }
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
      loginEmail,
      loginPassword,
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
  if (input.loginEmail !== undefined) data.loginEmail = input.loginEmail || null;
  if (input.loginPassword !== undefined) {
    data.passwordCipher = input.loginPassword
      ? encryptSecret(input.loginPassword, config.credentialsKey)
      : null;
  }
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

export interface RenewCredentials {
  id: string;
  label: string;
  loginEmail: string | null;
  password: string | null;
}

/**
 * 给客户机上的「续期助手」取明文登录凭据。
 * 只有登录态才能调（middleware 统一拦截 /api/*），且密码仍是加密落库、仅在内存里解一次。
 */
export async function getRenewCredentials(id: string): Promise<RenewCredentials> {
  const account = await getAccountOrThrow(id);
  let password: string | null = null;
  if (account.passwordCipher) {
    try {
      password = decryptSecret(account.passwordCipher, config.credentialsKey);
    } catch {
      password = null;
    }
  }
  return {
    id: account.id,
    label: account.label,
    loginEmail: account.loginEmail,
    password,
  };
}

/** 删除账号后若没有激活账号，回退到最早创建的一个。 */
async function ensureActiveAccount(): Promise<void> {
  const active = await prisma.account.findFirst({ where: { isActive: true } });
  if (active) return;
  const fallback = await prisma.account.findFirst({ orderBy: { createdAt: "asc" } });
  if (fallback) {
    await prisma.account.update({ where: { id: fallback.id }, data: { isActive: true } });
  }
}

export async function deleteAccount(id: string): Promise<{ id: string }> {
  await getAccountOrThrow(id);
  await prisma.account.delete({ where: { id } });
  closeSession(id);
  await ensureActiveAccount();
  await syncAccounts();
  return { id };
}

/** 一次删除多选账号；任务与素材由数据库外键级联删除，只广播一次快照。 */
export async function deleteAccounts(ids: string[]): Promise<{ deleted: number }> {
  const uniqueIds = [...new Set(ids)];
  const { count } = await prisma.account.deleteMany({ where: { id: { in: uniqueIds } } });
  if (!count) throw errors.notFound("所选账号已不存在");
  for (const id of uniqueIds) closeSession(id);
  await ensureActiveAccount();
  await syncAccounts();
  return { deleted: count };
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
        ...creditFields(profile.freeCredits),
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

/** 每批并发数，与自动选号一致，避免账号多时突发请求触发上游风控。 */
const VERIFY_BATCH_SIZE = 3;
/** 进程内互斥，防止重复点击发起两轮并发校验。 */
let verifyAllRunning = false;

type VerifyOutcome = { kind: "ok"; profile: UserProfile } | { kind: "undecryptable" };

/**
 * 批量校验账号：逐批向上游读取用户信息（只读、不消耗额度），
 * 传入 ids 时只校验多选账号；每批结束后广播账号快照，界面上的积分与状态会逐批刷新。
 */
export async function verifyAllAccounts(ids?: string[]): Promise<VerifyAllResult> {
  if (verifyAllRunning) throw errors.badRequest("已有批量校验正在进行，请稍候");
  verifyAllRunning = true;
  try {
    const rows = await prisma.account.findMany({
      where: ids ? { id: { in: ids } } : undefined,
      orderBy: { createdAt: "asc" },
    });
    const result: VerifyAllResult = { total: rows.length, valid: 0, invalid: 0, skipped: 0 };
    if (!rows.length) return result;

    const provider = getProvider();
    for (let offset = 0; offset < rows.length; offset += VERIFY_BATCH_SIZE) {
      const batch = rows.slice(offset, offset + VERIFY_BATCH_SIZE);
      const outcomes = await Promise.allSettled(
        batch.map(async (row): Promise<VerifyOutcome> => {
          let token: string;
          try {
            token = decryptOrThrow(row);
          } catch {
            return { kind: "undecryptable" };
          }
          const profile = await provider.verify({ accountId: row.id, token });
          return { kind: "ok", profile };
        })
      );

      for (let i = 0; i < batch.length; i += 1) {
        const row = batch[i];
        const outcome = outcomes[i];
        if (outcome.status === "fulfilled" && outcome.value.kind === "ok") {
          const { profile } = outcome.value;
          await prisma.account.update({
            where: { id: row.id },
            data: {
              status: "valid",
              lastCheckedAt: new Date(),
              nickname: profile.nickname || null,
              email: profile.email || null,
              ...creditFields(profile.freeCredits),
            },
          });
          result.valid += 1;
          continue;
        }
        if (outcome.status === "fulfilled") {
          // 密钥轮换后无法解密：保留原状态，等用户更新 JWT
          result.skipped += 1;
          continue;
        }
        logger.warn("account.batch_verify_failed", {
          accountId: row.id,
          message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        await prisma.account.update({
          where: { id: row.id },
          data: { status: "invalid", lastCheckedAt: new Date() },
        });
        result.invalid += 1;
      }
      // 每批推送一次全量快照，卡片逐批刷新形成可见进度。
      await syncAccounts();
    }
    logger.info("account.batch_verify_done", { ...result });
    return result;
  } finally {
    verifyAllRunning = false;
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
  // 已确认积分不足且还没到刷新时刻：缓存值就是当前真实额度，再校验一次也是浪费。
  if (isCreditsExhausted(active.creditsResetAt)) {
    return { profile: cached, stale: false };
  }
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
        ...creditFields(profile.freeCredits),
      },
    });
    void syncAccounts();
    return { profile, stale: false };
  } catch {
    return { profile: cached, stale: true };
  }
}

/** 账号多时按批推进，每批并发数不宜过高，避免突发请求触发上游风控。 */
const AUTO_PROBE_BATCH = 3;

interface AutoCandidate {
  row: Account;
  token: string;
}

/**
 * 自动模式：遍历全部可用账号，实时校验积分并激活一个够用的账号。
 * 素材上传、素材箱与生成任务都以「当前激活账号」为准，因此必须在上传素材前定号；
 * 前端在已有草稿时会跳过本函数，避免已上传素材跨账号失效。
 *
 * 免费积分每天北京时间 08:00 刷新：一旦确认某个账号积分不足，就记下下次刷新时刻，
 * 刷新前不再对它发起任何校验请求，直接跳过。
 */
export async function autoSelectAccount(): Promise<AutoSelectResult> {
  const rows = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  if (!rows.length) throw errors.noActiveAccount();

  const activeId = rows.find((row) => row.isActive)?.id ?? null;
  const now = new Date();
  const candidates: AutoCandidate[] = [];
  let exhausted = 0;
  let earliestReset: Date | null = null;

  for (const row of rows) {
    if (row.status === "invalid") continue;
    let token: string;
    try {
      token = decryptSecret(row.tokenCipher, config.credentialsKey);
    } catch {
      continue; // 密钥轮换后无法解密的账号不参与选号
    }
    const resetAt = row.creditsResetAt;
    if (resetAt && resetAt.getTime() > now.getTime()) {
      // 刷新前积分肯定不够，校验也没有意义。
      exhausted += 1;
      if (!earliestReset || resetAt < earliestReset) earliestReset = resetAt;
      continue;
    }
    candidates.push({ row, token });
  }

  if (!candidates.length) {
    if (earliestReset) {
      throw errors.validation(
        `全部 ${exhausted} 个可用账号的免费积分已用完，北京时间 ${formatBeijing(earliestReset)} 刷新后再试（本次未发起校验）`
      );
    }
    throw errors.validation("没有可用账号：请校验账号或更新 JWT");
  }

  // 当前账号 → 缓存够用 → 未校验 → 缓存不足。
  const rank = (item: AutoCandidate): number => {
    if (item.row.id === activeId) return 0;
    if (item.row.freeCredits === null) return 2;
    return item.row.freeCredits >= FREE_TIER.creditsPerGeneration ? 1 : 3;
  };
  candidates.sort((a, b) => {
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return (b.row.freeCredits ?? 0) - (a.row.freeCredits ?? 0);
  });

  const provider = getProvider();
  let checked = 0;
  type ProbeResult = PromiseSettledResult<UserProfile>;

  const probe = (batch: AutoCandidate[]): Promise<ProbeResult[]> =>
    Promise.allSettled(
      batch.map((item) => provider.verify({ accountId: item.row.id, token: item.token }))
    );

  /** 串行写库避免 SQLite 并发写冲突；命中第一个够用的账号即返回。 */
  const consume = async (
    batch: AutoCandidate[],
    results: ProbeResult[]
  ): Promise<AutoSelectResult | null> => {
    for (let i = 0; i < batch.length; i += 1) {
      const { row } = batch[i];
      const result = results[i];
      if (result.status === "rejected") {
        checked += 1;
        if (result.reason instanceof AppError && result.reason.code === "TOKEN_INVALID") {
          await prisma.account.update({ where: { id: row.id }, data: { status: "invalid" } });
        } else {
          logger.warn("account.auto_verify_failed", { accountId: row.id });
        }
        continue;
      }
      const profile = result.value;
      checked += 1;
      await prisma.account.update({
        where: { id: row.id },
        data: {
          status: "valid",
          lastCheckedAt: new Date(),
          nickname: profile.nickname || null,
          email: profile.email || null,
          ...creditFields(profile.freeCredits),
        },
      });
      if (profile.freeCredits < FREE_TIER.creditsPerGeneration) continue;

      if (row.id !== activeId) {
        await prisma.$transaction([
          prisma.account.updateMany({ data: { isActive: false } }),
          prisma.account.update({ where: { id: row.id }, data: { isActive: true } }),
        ]);
      }
      const accounts = await syncAccounts();
      logger.info("account.auto_selected", {
        accountId: row.id,
        freeCredits: profile.freeCredits,
        checked,
      });
      return { accounts, selectedId: row.id, label: row.label, freeCredits: profile.freeCredits };
    }
    return null;
  };

  // 最可能的账号先单独校验：常见情况只需 1 次上游请求。
  const first = candidates.slice(0, 1);
  const firstPick = await consume(first, await probe(first));
  if (firstPick) return firstPick;

  // 其余账号按批并发推进，直到找到够用的账号或遍历完所有账号（不再有数量上限）。
  for (let offset = 1; offset < candidates.length; offset += AUTO_PROBE_BATCH) {
    const batch = candidates.slice(offset, offset + AUTO_PROBE_BATCH);
    const picked = await consume(batch, await probe(batch));
    if (picked) return picked;
  }

  // 即使没选中也要把最新状态推给前端。
  await syncAccounts();
  throw errors.validation(
    `没有积分充足的账号（生成需要 ${FREE_TIER.creditsPerGeneration} 积分）` +
      (checked ? `，已检查 ${checked} 个账号` : "") +
      (exhausted ? `，另有 ${exhausted} 个账号积分已用完未校验` : "")
  );
}
