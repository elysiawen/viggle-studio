import { describe, expect, it } from "vitest";
import { parseCookieProfiles } from "./cookie-profile";

const TOKEN_A = "eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOjF9.c2lnbmF0dXJlQQ";
const TOKEN_B = "eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOjJ9.c2lnbmF0dXJlQg";

function makeProfile(name: string, site: string, tokenValue?: unknown) {
  return {
    name,
    site,
    storage: {
      origin: `https://${site}`,
      localStorage: tokenValue === undefined ? {} : { viggleToken: tokenValue },
    },
    cookies: [{ domain: `.${site}` }],
  };
}

describe("parseCookieProfiles", () => {
  it("只导入 viggle.ai 的 profile，忽略其它站点", () => {
    const result = parseCookieProfiles({
      app: "cookie-profile-switcher",
      profiles: [
        makeProfile("viggle-1", "viggle.ai", TOKEN_A),
        makeProfile("chatgpt-1", "chatgpt.com", TOKEN_B),
        makeProfile("viggle-2", "viggle.ai", TOKEN_B),
      ],
    });
    expect(result.totalProfiles).toBe(3);
    expect(result.otherSites).toBe(1);
    expect(result.accounts.map((a) => a.label)).toEqual(["viggle-1", "viggle-2"]);
  });

  it("解析 localStorage 里被 JSON 字符串化过的 viggleToken", () => {
    const result = parseCookieProfiles({
      profiles: [makeProfile("main", "viggle.ai", JSON.stringify(TOKEN_A))],
    });
    expect(result.accounts[0].token).toBe(TOKEN_A);
  });

  it("兼容裸 JWT 与 Bearer 前缀", () => {
    const result = parseCookieProfiles({
      profiles: [
        makeProfile("raw", "viggle.ai", TOKEN_A),
        makeProfile("bearer", "viggle.ai", `Bearer ${TOKEN_B}`),
      ],
    });
    expect(result.accounts.map((a) => a.token)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it("跳过无 token、无效 token 与重复 JWT，并用缺省名称兜底", () => {
    const result = parseCookieProfiles({
      profiles: [
        makeProfile("empty", "viggle.ai"),
        makeProfile("bad", "viggle.ai", "not-a-jwt"),
        makeProfile("", "viggle.ai", TOKEN_A),
        makeProfile("duplicate", "viggle.ai", TOKEN_A),
      ],
    });
    expect(result.skipped).toBe(3);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].label).toBe("Viggle 账号 3");
  });

  it("站点信息缺失时用 cookie domain 兜底", () => {
    const result = parseCookieProfiles({
      profiles: [
        {
          name: "legacy",
          cookies: [{ domain: ".viggle.ai" }],
          storage: { localStorage: { viggleToken: TOKEN_A } },
        },
      ],
    });
    expect(result.accounts).toHaveLength(1);
  });

  it("缺少 profiles 数组时给出明确错误", () => {
    expect(() => parseCookieProfiles({ app: "other" })).toThrow(/profiles/);
  });
});
