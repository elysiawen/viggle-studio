/**
 * 解析账号导入文件，支持两种来源：
 * - cookie-profile-switcher 一类插件导出的 cookie / localStorage JSON
 * - 本项目自己的备份格式（app = viggle-studio，accounts 数组）
 * 插件格式只提取 viggle.ai 站点 profile 里的 localStorage.viggleToken，其它站点一律忽略。
 * 纯函数，前后端共享；不包含任何凭据回显逻辑。
 */

export interface ImportedAccount {
  label: string;
  token: string;
  /** 续期登录邮箱（仅项目自有备份格式会带） */
  loginEmail?: string;
  /** 续期登录密码（仅项目自有备份格式会带，明文） */
  loginPassword?: string;
}

export interface CookieProfileImport {
  accounts: ImportedAccount[];
  /** 文件里的记录总数（profile 或 account） */
  totalProfiles: number;
  /** 被忽略的非 viggle 站点数量（插件格式才有） */
  otherSites: number;
  /** 没有有效 JWT 或 JWT 重复的记录数 */
  skipped: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 与服务端 normalizeToken 保持一致的宽松三段检查，不解析签名内容。 */
function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && value.length >= 32 && parts.every((part) => part.length > 0);
}

/** 兼容裸 JWT、Bearer 前缀，以及 localStorage 里被 JSON.stringify 过一次的值。 */
function normalizeImportedToken(raw: unknown): string {
  let value = text(raw);
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") value = parsed.trim();
    } catch {
      // 保持原值，交给后续格式校验
    }
  }
  value = value.replace(/^bearer\s+/i, "").trim();
  return looksLikeJwt(value) ? value : "";
}

function isViggleProfile(profile: Record<string, unknown>): boolean {
  const site = text(profile.site).toLowerCase();
  const origin = text(asRecord(profile.storage).origin).toLowerCase();
  const hints = [site, origin].filter(Boolean);
  // 有明确站点信息时以它为准，避免用 cookie domain 误把别的站点算进来。
  if (hints.length) return hints.some((hint) => hint.includes("viggle.ai"));
  return (
    Array.isArray(profile.cookies) &&
    profile.cookies.some((cookie) =>
      text(asRecord(cookie).domain).toLowerCase().includes("viggle.ai")
    )
  );
}

function extractToken(profile: Record<string, unknown>): string {
  const localStorage = asRecord(asRecord(profile.storage).localStorage);
  return normalizeImportedToken(localStorage.viggleToken);
}

/** 项目自有备份格式：accounts 数组里直接带裸 JWT。 */
function parseAccountList(entries: unknown[]): CookieProfileImport {
  const accounts: ImportedAccount[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  entries.forEach((entry, index) => {
    const item = asRecord(entry);
    const token = normalizeImportedToken(item.token);
    if (!token || seen.has(token)) {
      skipped += 1;
      return;
    }
    seen.add(token);
    // 项目自有备份里可能带续期凭据；密码不做过 trim，保持原值
    const loginEmail = text(item.loginEmail);
    const loginPassword = typeof item.loginPassword === "string" ? item.loginPassword : "";
    accounts.push({
      label: (text(item.label) || `Viggle 账号 ${index + 1}`).slice(0, 40),
      token,
      ...(loginEmail ? { loginEmail } : {}),
      ...(loginPassword ? { loginPassword } : {}),
    });
  });

  return { accounts, totalProfiles: entries.length, otherSites: 0, skipped };
}

export function parseCookieProfiles(raw: unknown): CookieProfileImport {
  const root = asRecord(raw);
  if (Array.isArray(root.accounts)) return parseAccountList(root.accounts);
  if (!Array.isArray(root.profiles)) {
    throw new Error("不是有效的账号导出文件（缺少 profiles 或 accounts 数组）");
  }

  const profiles: unknown[] = root.profiles;
  const accounts: ImportedAccount[] = [];
  const seen = new Set<string>();
  let otherSites = 0;
  let skipped = 0;

  profiles.forEach((entry, index) => {
    const profile = asRecord(entry);
    if (!isViggleProfile(profile)) {
      otherSites += 1;
      return;
    }
    const token = extractToken(profile);
    if (!token || seen.has(token)) {
      skipped += 1;
      return;
    }
    seen.add(token);
    accounts.push({
      label: (text(profile.name) || `Viggle 账号 ${index + 1}`).slice(0, 40),
      token,
    });
  });

  return { accounts, totalProfiles: profiles.length, otherSites, skipped };
}
