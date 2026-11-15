/** 账号数据的两种导出格式构造。纯函数，便于单测。 */

export type ExportFormat = "cookie-profile" | "studio";

export interface ExportAccount {
  label: string;
  token: string;
  note?: string | null;
  status?: string | null;
  email?: string | null;
  nickname?: string | null;
  freeCredits?: number | null;
  createdAt?: string | null;
  /** 续期用的登录邮箱；只在项目自有备份格式里出现 */
  loginEmail?: string | null;
  /** 续期用的登录密码（明文，仅项目自有备份格式） */
  loginPassword?: string | null;
}

export interface ExportBundle {
  filename: string;
  count: number;
  data: unknown;
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `${date}-${time}`;
}

function profileId(index: number): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

/** 与 cookie-profile-switcher 导出文件同构，可被该类插件或本项目导入功能读回。 */
function cookieProfileData(accounts: ExportAccount[], now: Date): unknown {
  const epoch = now.getTime();
  return {
    app: "cookie-profile-switcher",
    version: 1,
    exportedAt: epoch,
    profiles: accounts.map((account, index) => ({
      id: profileId(index),
      name: account.label,
      site: "viggle.ai",
      scope: "subdomains",
      cookies: [],
      storage: {
        origin: "https://viggle.ai",
        // 与浏览器 localStorage 一致：值是被 JSON.stringify 过一次的字符串
        localStorage: { viggleToken: JSON.stringify(account.token) },
      },
      createdAt: epoch,
      updatedAt: epoch,
    })),
  };
}

/**
 * 项目自有备份格式：保留更多元数据，token 为裸 JWT。
 * 为了能原样恢复「一键续期」，这里会带上续期登录邮箱与密码（明文）。
 * cookie-profile 插件格式不包含这两项。
 */
function studioData(accounts: ExportAccount[], now: Date): unknown {
  return {
    app: "viggle-studio",
    version: 1,
    exportedAt: now.toISOString(),
    accounts: accounts.map((account) => ({
      label: account.label,
      token: account.token,
      note: account.note ?? null,
      status: account.status ?? null,
      email: account.email ?? null,
      nickname: account.nickname ?? null,
      freeCredits: account.freeCredits ?? null,
      createdAt: account.createdAt ?? null,
      loginEmail: account.loginEmail ?? null,
      loginPassword: account.loginPassword ?? null,
    })),
  };
}

export function buildAccountExport(
  format: ExportFormat,
  accounts: ExportAccount[],
  now = new Date()
): ExportBundle {
  const prefix = format === "studio" ? "viggle-studio-accounts" : "cookie-profiles";
  return {
    filename: `${prefix}-${stamp(now)}.json`,
    count: accounts.length,
    data: format === "studio" ? studioData(accounts, now) : cookieProfileData(accounts, now),
  };
}
