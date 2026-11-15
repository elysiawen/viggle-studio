import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptFile, encryptName } from "./ske";

const PASSWORD = "cli-pass";
const REFERENCE = "D:\\CodeSpace\\SakuraEncryptor";
const TASK = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const SIZE = 300_000;

describe("与官方 ske CLI 的互操作", () => {
  let dir: string;
  let payload: Buffer;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ske-cli-"));
    payload = randomBytes(SIZE);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("token 命名 + 加密内容能被 `ske decrypt` 还原", async () => {
    const plainName = `${TASK}.mp4`;
    const plainPath = join(dir, plainName);
    await writeFile(plainPath, payload);

    const token = await encryptName(plainName, PASSWORD);
    const skePath = join(dir, `${token}.ske`);
    await encryptFile(plainPath, skePath, PASSWORD);
    await rm(plainPath);

    const out = join(dir, "out");
    execFileSync(
      "python",
      ["-m", "ske_cli", "decrypt", "-i", skePath, "-o", out, "-p", PASSWORD],
      { cwd: REFERENCE, encoding: "utf8" }
    );

    const produced = await readdir(out);
    expect(produced).toEqual([plainName]);
    expect((await readFile(join(out, plainName))).equals(payload)).toBe(true);
  }, 120_000);
});
