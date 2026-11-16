import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { prisma } from "../db";
import { errors } from "../errors";

/** Setting 表里保存「落盘是否加密」的键。 */
const ENCRYPT_KEY = "storage.encrypt";
/** 新任务成功后是否自动下载视频与封面。 */
const AUTO_SAVE_KEY = "storage.autoSave";
/** 落盘根目录；首次读取时写入数据库，默认项目根目录下的 storage/。 */
const DIR_KEY = "storage.dir";

export interface StorageEncryptionState {
  /** 当前是否加密落盘 */
  enabled: boolean;
  /** 是否配置了 STORAGE_PASSWORD；未配置时无法开启 */
  available: boolean;
}

export interface StorageSettings {
  /** 新任务成功后是否自动下载视频与封面 */
  autoSave: boolean;
  encryption: StorageEncryptionState;
  /** 生效中的落盘根目录（绝对路径） */
  storageDir: string;
}

/** 主密码只从环境变量读取，绝不入库、不回传前端。 */
export function encryptionAvailable(): boolean {
  return config.storagePassword.trim().length > 0;
}

export async function getStorageEncryption(): Promise<StorageEncryptionState> {
  const row = await prisma.setting.findUnique({ where: { key: ENCRYPT_KEY } });
  // 没配主密码时即使曾经打开过也视为关闭，避免产出无法解开的文件。
  return { enabled: row?.value === "1" && encryptionAvailable(), available: encryptionAvailable() };
}

export async function setStorageEncryption(enabled: boolean): Promise<StorageEncryptionState> {
  if (enabled && !encryptionAvailable()) {
    throw errors.validation("未配置 STORAGE_PASSWORD，请先在 .env 中设置主密码再开启加密落盘");
  }
  await prisma.setting.upsert({
    where: { key: ENCRYPT_KEY },
    create: { key: ENCRYPT_KEY, value: enabled ? "1" : "0" },
    update: { value: enabled ? "1" : "0" },
  });
  return getStorageEncryption();
}

/** 落盘时调用：只有开关打开且配置了主密码才加密。 */
export async function shouldEncryptStorage(): Promise<boolean> {
  if (!encryptionAvailable()) return false;
  const row = await prisma.setting.findUnique({ where: { key: ENCRYPT_KEY } });
  return row?.value === "1";
}

/** 自动落盘开关；没有记录时默认开启。 */
export async function getAutoSaveVideo(): Promise<boolean> {
  const row = await prisma.setting.findUnique({ where: { key: AUTO_SAVE_KEY } });
  return row?.value !== "0";
}

export async function setAutoSaveVideo(enabled: boolean): Promise<boolean> {
  await prisma.setting.upsert({
    where: { key: AUTO_SAVE_KEY },
    create: { key: AUTO_SAVE_KEY, value: enabled ? "1" : "0" },
    update: { value: enabled ? "1" : "0" },
  });
  return enabled;
}

/** 默认落盘目录：项目根目录下的 storage/。 */
function defaultStorageDir(): string {
  return resolve(process.cwd(), "storage");
}

/**
 * 当前生效的落盘根目录。首次调用把默认值写入 Setting，之后以数据库为准。
 */
export async function getStorageDir(): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key: DIR_KEY } });
  if (row?.value) return row.value;

  const fallback = defaultStorageDir();
  await prisma.setting.upsert({
    where: { key: DIR_KEY },
    create: { key: DIR_KEY, value: fallback },
    update: {},
  });

  const saved = await prisma.setting.findUnique({ where: { key: DIR_KEY } });
  return saved?.value || fallback;
}

/** 改目录时只校验可写并创建子目录；已有文件留在原目录，不做迁移。 */
export async function setStorageDir(raw: string): Promise<string> {
  const input = raw.trim();
  if (!input) throw errors.validation("存储目录不能为空");

  const target = resolve(process.cwd(), input);
  const probe = join(target, `.write-test-${process.pid}`);
  try {
    await mkdir(join(target, "videos"), { recursive: true });
    await mkdir(join(target, "covers"), { recursive: true });
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("目标不是目录");
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
  } catch (err) {
    throw errors.validation(
      `存储目录不可用：${err instanceof Error ? err.message : String(err)}`
    );
  }

  await prisma.setting.upsert({
    where: { key: DIR_KEY },
    create: { key: DIR_KEY, value: target },
    update: { value: target },
  });
  return target;
}

/** 设置页一次性读取全部存储设置。 */
export async function getStorageSettings(): Promise<StorageSettings> {
  const [autoSave, encryption, storageDir] = await Promise.all([
    getAutoSaveVideo(),
    getStorageEncryption(),
    getStorageDir(),
  ]);
  return { autoSave, encryption, storageDir };
}
