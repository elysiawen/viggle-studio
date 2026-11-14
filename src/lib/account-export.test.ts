import { describe, expect, it } from "vitest";
import { buildAccountExport } from "./account-export";
import { parseCookieProfiles } from "./cookie-profile";

const TOKEN_A = "eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOjF9.c2lnbmF0dXJlQQ";
const TOKEN_B = "eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOjJ9.c2lnbmF0dXJlQg";
const FIXED = new Date(2026, 10, 14, 11, 1, 35);

const accounts = [
  { label: "主账号", token: TOKEN_A, note: "备注", status: "valid", freeCredits: 60 },
  { label: "备用", token: TOKEN_B },
];

describe("buildAccountExport", () => {
  it("插件格式与 cookie-profile-switcher 同构，且可被导入功能读回", () => {
    const bundle = buildAccountExport("cookie-profile", accounts, FIXED);
    expect(bundle.filename).toBe("cookie-profiles-2026-11-14-11-01-35.json");
    expect(bundle.count).toBe(2);

    const data = bundle.data as {
      app: string;
      version: number;
      profiles: Array<{ site: string; storage: { localStorage: { viggleToken: string } } }>;
    };
    expect(data.app).toBe("cookie-profile-switcher");
    expect(data.profiles).toHaveLength(2);
    expect(data.profiles[0].site).toBe("viggle.ai");
    expect(data.profiles[0].storage.localStorage.viggleToken).toBe(JSON.stringify(TOKEN_A));

    expect(parseCookieProfiles(bundle.data).accounts).toEqual([
      { label: "主账号", token: TOKEN_A },
      { label: "备用", token: TOKEN_B },
    ]);
  });

  it("项目格式保留元数据，且可被导入功能读回", () => {
    const bundle = buildAccountExport("studio", accounts, FIXED);
    expect(bundle.filename).toBe("viggle-studio-accounts-2026-11-14-11-01-35.json");

    const data = bundle.data as {
      app: string;
      accounts: Array<{ note: string | null; freeCredits: number | null; token: string }>;
    };
    expect(data.app).toBe("viggle-studio");
    expect(data.accounts[0].note).toBe("备注");
    expect(data.accounts[0].freeCredits).toBe(60);
    expect(data.accounts[1].note).toBeNull();

    const parsed = parseCookieProfiles(bundle.data);
    expect(parsed.accounts.map((item) => item.token)).toEqual([TOKEN_A, TOKEN_B]);
    expect(parsed.otherSites).toBe(0);
  });

  it("空账号列表也生成合法结构", () => {
    const bundle = buildAccountExport("studio", [], FIXED);
    expect(bundle.count).toBe(0);
    expect(parseCookieProfiles(bundle.data).accounts).toEqual([]);
  });
});
