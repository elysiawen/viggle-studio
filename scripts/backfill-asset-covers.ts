/**
 * 给历史素材补齐封面（缩略图），只处理永久素材里「还没有封面」的记录。
 *
 * 用法：
 *   npm run assets:covers                              # 预览：只列出待补素材，不写入
 *   $env:COVERS_APPLY='1'; npm run assets:covers       # Windows 写入
 *   COVERS_APPLY=1 npm run assets:covers               # macOS / Linux 写入
 *   npx tsx scripts/backfill-asset-covers.ts --yes --limit 20 --kind image
 *
 * 默认是预览模式：加密素材会被重新加密写回，必须显式确认才动文件。
 * 注意：PowerShell 会把 `npm run xxx -- --yes` 里的 `--` 吃掉，跨平台请用环境变量。
 * 说明：
 * - 图片用 sharp 缩放；视频需要本机可用的 ffmpeg（FFMPEG_PATH 或 PATH），
 *   服务端运行时不再依赖 ffmpeg，只有这个补全脚本会用它。
 * - 加密素材会先解密到临时目录、生成封面后重新加密写回，文件名与内容不变。
 * - 明文素材写相邻的 `<sha256>.thumb.jpg`，与上传时的行为一致。
 * - 小图（最长边 ≤512）本来就不需要封面，跳过；可以反复执行。
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalAsset } from "@prisma/client";
import { MIME_EXTENSION } from "../src/lib/constants";
import { config } from "../src/server/config";
import { decryptAll, encryptFile, openEncryptedFile, SKE_SUFFIX } from "../src/server/crypto/ske";
import { prisma } from "../src/server/db";
import { generateImageThumbnail } from "../src/server/media/thumbnail";
import { storageFilePath, storedFile } from "../src/server/services/video-store";

const execFileAsync = promisify(execFile);

const MAX_SIDE = 512;
const MAX_THUMB_BYTES = 512 * 1024;

interface Options {
  apply: boolean;
  limit: number;
  kind: "image" | "video" | "all";
}

function readOptions(argv: string[]): Options {
  const value = (name: string): string | null => {
    const withEquals = argv.find((item) => item.startsWith(`--${name}=`));
    if (withEquals) return withEquals.slice(name.length + 3);
    const index = argv.indexOf(`--${name}`);
    if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
    return null;
  };
  const limitRaw = Number(value("limit"));
  const kindRaw = value("kind");
  return {
    apply:
      argv.includes("--yes") ||
      argv.includes("-y") ||
      /^(1|true|yes)$/i.test(process.env.COVERS_APPLY ?? ""),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0,
    kind: kindRaw === "image" || kindRaw === "video" ? kindRaw : "all",
  };
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** 依次尝试自定义路径和 PATH；找不到就返回 null，由调用方决定是否跳过。 */
async function resolveBinary(name: "ffmpeg" | "ffprobe"): Promise<string | null> {
  const custom = (
    name === "ffmpeg" ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH
  )?.trim();
  const candidate = custom || name;
  try {
    await execFileAsync(candidate, ["-version"], { timeout: 5_000, windowsHide: true });
    return candidate;
  } catch {
    return null;
  }
}

async function probeDuration(file: string, ffmpeg: string, ffprobe: string | null): Promise<number | null> {
  if (ffprobe) {
    try {
      const { stdout } = await execFileAsync(
        ffprobe,
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
        { timeout: 10_000, windowsHide: true }
      );
      const value = Number(stdout.trim());
      if (Number.isFinite(value) && value > 0) return value;
    } catch {
      // 继续走 ffmpeg 解析
    }
  }
  // 没有 ffprobe 时解析 `ffmpeg -i` 的 stderr（该命令必然以非 0 退出）。
  try {
    await execFileAsync(ffmpeg, ["-hide_banner", "-i", file], {
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: string }).stderr || "");
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (match) {
      const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
      if (Number.isFinite(seconds) && seconds > 0) return seconds;
    }
  }
  return null;
}

async function extractFrame(file: string, ffmpeg: string, seek: number | null): Promise<Buffer | null> {
  const args = [
    "-v",
    "error",
    "-nostdin",
    ...(seek !== null ? ["-ss", seek.toFixed(3)] : []),
    "-i",
    file,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-vf",
    `scale=${MAX_SIDE}:${MAX_SIDE}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    "-q:v",
    "4",
    "-f",
    "mjpeg",
    "pipe:1",
  ];
  try {
    const { stdout } = await execFileAsync(ffmpeg, args, {
      timeout: 15_000,
      maxBuffer: MAX_THUMB_BYTES + 64 * 1024,
      windowsHide: true,
      encoding: "buffer",
    });
    const data = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as Uint8Array);
    if (data.length < 128 || data[0] !== 0xff || data[1] !== 0xd8) return null;
    return data;
  } catch {
    return null;
  }
}

/** 视频封面：30% 进度帧，失败退到 0.5s、第一帧。 */
async function videoThumbnail(
  file: string,
  ffmpeg: string,
  ffprobe: string | null
): Promise<Buffer | null> {
  const duration = await probeDuration(file, ffmpeg, ffprobe);
  const seeks: Array<number | null> = [];
  if (duration) seeks.push(duration < 1 ? duration / 2 : duration * 0.3);
  seeks.push(0.5, null);
  for (const seek of seeks) {
    const thumb = await extractFrame(file, ffmpeg, seek);
    if (thumb) return thumb;
  }
  return null;
}

/** 加密素材先解到临时文件，交给 sharp / ffmpeg 处理。 */
async function materialize(
  asset: LocalAsset,
  encryptedPath: string,
  workDir: string
): Promise<string | null> {
  if (!config.storagePassword) return null;
  const { handle, prefix, key } = await openEncryptedFile(encryptedPath, config.storagePassword);
  try {
    const plain = await decryptAll(handle, prefix, key);
    const ext = MIME_EXTENSION[asset.mime] || "bin";
    const target = join(workDir, `${asset.id}.${ext}`);
    await writeFile(target, plain);
    return target;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function backfillOne(
  asset: LocalAsset,
  options: { workDir: string; ffmpeg: string | null; ffprobe: string | null }
): Promise<"done" | "skipped" | "failed"> {
  const file = await storedFile("asset", asset.filename, asset.storageDir);
  if (!file) {
    console.log("文件缺失，跳过");
    return "skipped";
  }

  const encrypted = asset.filename.endsWith(SKE_SUFFIX);
  let sourcePath = file.path;
  if (encrypted) {
    if (!config.storagePassword) {
      console.log("未配置 STORAGE_PASSWORD，无法解密，跳过");
      return "skipped";
    }
    const plain = await materialize(asset, file.path, options.workDir);
    if (!plain) {
      console.log("解密失败，跳过");
      return "skipped";
    }
    sourcePath = plain;
  }

  let thumb: Buffer | null = null;
  if (asset.kind === "image") {
    thumb = await generateImageThumbnail(sourcePath);
  } else {
    if (!options.ffmpeg) {
      console.log("本机没有 ffmpeg，跳过视频");
      return "skipped";
    }
    thumb = await videoThumbnail(sourcePath, options.ffmpeg, options.ffprobe);
  }
  if (!thumb) {
    console.log("无法生成封面（小图或解码失败），跳过");
    return "skipped";
  }

  if (encrypted) {
    // 重新加密写回：先写同目录临时文件，再把原文件改名备份后替换。
    // 即使中途崩溃，原文件也在 `.bak` 里，不会丢数据。
    const password = config.storagePassword;
    if (!password) return "skipped";
    const stamp = Date.now();
    const tmpEncrypted = `${file.path}.${stamp}.tmp`;
    const backup = `${file.path}.${stamp}.bak`;
    try {
      await encryptFile(sourcePath, tmpEncrypted, password, thumb);
      await rename(file.path, backup);
      try {
        await rename(tmpEncrypted, file.path);
      } catch (err) {
        await rename(backup, file.path).catch(() => {});
        throw err;
      }
      await rm(backup, { force: true }).catch(() => {});
    } catch (err) {
      await rm(tmpEncrypted, { force: true }).catch(() => {});
      throw err;
    }
    await prisma.localAsset.update({
      where: { id: asset.id },
      data: { coverEmbedded: true, coverFilename: null },
    });
  } else {
    const coverName = `${asset.sha256}.thumb.jpg`;
    await writeFile(storageFilePath("asset", coverName, asset.storageDir), thumb);
    await prisma.localAsset.update({
      where: { id: asset.id },
      data: { coverFilename: coverName, coverEmbedded: false },
    });
  }

  console.log(`ok（${Math.round(thumb.length / 1024)}KB，${encrypted ? "内嵌加密" : "明文文件"}）`);
  return "done";
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));

  const [ffmpeg, ffprobe] = await Promise.all([resolveBinary("ffmpeg"), resolveBinary("ffprobe")]);
  console.log(
    `视频封面依赖：${ffmpeg ? "ffmpeg 可用" : "未找到 ffmpeg（脚本内只补图片）"}` +
      (ffmpeg ? ` · ffprobe ${ffprobe ? "可用" : "缺失（改用 ffmpeg 解析时长）"}` : "")
  );

  const pending = await prisma.localAsset.findMany({
    where: {
      temporary: false,
      coverFilename: null,
      coverEmbedded: false,
      ...(options.kind === "all" ? {} : { kind: options.kind }),
    },
    orderBy: { createdAt: "asc" },
    take: options.limit > 0 ? options.limit : undefined,
  });

  console.log(`待补封面 ${pending.length} 条${options.kind === "all" ? "" : `（仅 ${options.kind}）`}。`);
  if (pending.length === 0) return;

  if (!options.apply) {
    for (const asset of pending) {
      console.log(
        `  · ${shortId(asset.id)}  ${asset.kind.padEnd(5)}  ${asset.originalName}  ${Math.round(asset.size / 1024)}KB`
      );
    }
    console.log("\n预览模式，未生成任何封面。确认无误后加 --yes 执行写入。");
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "viggle-covers-"));
  let done = 0;
  let skipped = 0;
  let failed = 0;

  try {
    for (const [index, asset] of pending.entries()) {
      process.stdout.write(
        `[${index + 1}/${pending.length}] ${shortId(asset.id)} ${asset.kind} ${asset.originalName} … `
      );
      try {
        const result = await backfillOne(asset, { workDir, ffmpeg, ffprobe });
        if (result === "done") done += 1;
        else if (result === "skipped") skipped += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        console.log(`失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n完成：补齐 ${done} 条，跳过 ${skipped} 条，失败 ${failed} 条。`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error("补全中断：", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
