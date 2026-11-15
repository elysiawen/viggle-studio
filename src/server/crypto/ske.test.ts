import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decryptAll,
  decryptRange,
  encryptFile,
  openEncryptedFile,
  plaintextSize,
  readPrefix,
  unlockPrefix,
} from "./ske";

const PASSWORD = "ske-test-pass";
const REFERENCE = "D:\\CodeSpace\\SakuraEncryptor";
const REFERENCE_CRYPTO = join(REFERENCE, "ske_cli", "crypto.py");

/** 参考实现是否可用（缺 Python 或仓库时自动跳过交叉验证）。 */
function referenceAvailable(): boolean {
  try {
    execFileSync(
      "python",
      [
        "-c",
        [
          "import importlib.util,sys",
          `s=importlib.util.spec_from_file_location('ske_crypto', r'${REFERENCE_CRYPTO}')`,
          "m=importlib.util.module_from_spec(s)",
          "sys.modules['ske_crypto']=m",
          "s.loader.exec_module(m)",
          "print('ok')",
        ].join(";"),
      ],
      { encoding: "utf8" }
    );
    return true;
  } catch {
    return false;
  }
}

/** 用参考实现执行一段脚本，脚本里可直接使用 m.*（ske_crypto 模块）。 */
async function runReference(dir: string, body: string): Promise<void> {
  const script = [
    "import importlib.util,sys",
    `s=importlib.util.spec_from_file_location('ske_crypto', r'${REFERENCE_CRYPTO}')`,
    "m=importlib.util.module_from_spec(s)",
    "sys.modules['ske_crypto']=m",
    "s.loader.exec_module(m)",
    body,
  ].join("\n");
  const file = join(dir, "run_ref.py");
  await writeFile(file, script, "utf8");
  execFileSync("python", [file], { encoding: "utf8" });
}

/** 2.5 MiB：跨越 3 个 1 MiB 分块，能覆盖整块与尾块的差异。 */
const SIZE = 2_500_000;

describe("SKE v001 容器", () => {
  let dir: string;
  let plain: Buffer;
  let src: string;
  let encrypted: string;
  const hasReference = referenceAvailable();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ske-"));
    plain = randomBytes(SIZE);
    src = join(dir, "sample.bin");
    encrypted = join(dir, "sample.bin.ske");
    await writeFile(src, plain);
    await encryptFile(src, encrypted, PASSWORD);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("头部结构与明文长度符合规范", async () => {
    const info = await openEncryptedFile(encrypted, PASSWORD);
    try {
      const { size } = await info.handle.stat();
      const head = await readFile(encrypted);
      expect(head.subarray(0, 8).toString("ascii")).toBe("SakuraEK");
      expect(head.subarray(8, 11).toString("ascii")).toBe("001");
      expect(info.prefix.iterations).toBe(100_000);
      expect(info.prefix.thumbCt.length).toBe(0);
      expect(plaintextSize(size, info.prefix.bodyOffset)).toBe(SIZE);
    } finally {
      await info.handle.close();
    }
  });

  it("整份解密与原文一致", async () => {
    const info = await openEncryptedFile(encrypted, PASSWORD);
    try {
      expect((await decryptAll(info.handle, info.prefix, info.key)).equals(plain)).toBe(true);
    } finally {
      await info.handle.close();
    }
  });

  it("按区间解密（跨块）与原文切片一致", async () => {
    const info = await openEncryptedFile(encrypted, PASSWORD);
    try {
      const start = 1_000_000 - 234;
      const end = 2_000_000 + 500;
      const slice = await decryptRange(info.handle, info.prefix, info.key, start, end);
      expect(slice.equals(plain.subarray(start, end + 1))).toBe(true);
    } finally {
      await info.handle.close();
    }
  });

  it("错误密码在解出任何数据前被拒绝", async () => {
    const info = await openEncryptedFile(encrypted, PASSWORD);
    try {
      await expect(unlockPrefix(info.prefix, "wrong-pass")).rejects.toThrow(/主密码/);
    } finally {
      await info.handle.close();
    }
    await expect(openEncryptedFile(encrypted, "wrong-pass")).rejects.toThrow();
  });

  it.skipIf(!hasReference)("参考实现能解开我们加密的文件", async () => {
    const out = join(dir, "decrypted-by-python.bin");
    await runReference(
      dir,
      `m.decrypt_file(r"${encrypted}", r"${out}", r"${PASSWORD}")`
    );
    expect((await readFile(out)).equals(plain)).toBe(true);
  });

  it.skipIf(!hasReference)("我们能解开参考实现加密的文件", async () => {
    const refEncrypted = join(dir, "reference.bin.ske");
    await runReference(
      dir,
      `m.encrypt_file(r"${src}", r"${refEncrypted}", r"${PASSWORD}", b"")`
    );
    const info = await openEncryptedFile(refEncrypted, PASSWORD);
    try {
      expect((await decryptAll(info.handle, info.prefix, info.key)).equals(plain)).toBe(true);
    } finally {
      await info.handle.close();
    }
  });
});
