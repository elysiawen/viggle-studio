import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config";
import { prisma } from "../db";
import { errors } from "../errors";

/** 分类型加密开关的键；旧键 storage.encrypt 作为未设置时的默认值。 */
const ENCRYPT_KEYS = {
  video: "storage.encryptVideo",
  cover: "storage.encryptCover",
  asset: "storage.encryptAsset",
} as const;
const LEGACY_ENCRYPT_KEY = "storage.encrypt";
/**
 * 分类型自动存盘开关：任务产物（视频与封面必须一起落盘）与上传素材。
 * 素材沿用旧键 storage.keepAssets。
 */
const AUTO_SAVE_KEYS = {
  video: "storage.autoSaveVideo",
  asset: "storage.keepAssets",
} as const;
const LEGACY_AUTO_SAVE_KEY = "storage.autoSave";
/** 落盘根目录；首次读取时写入数据库，默认项目根目录下的 storage/。 */
const DIR_KEY = "storage.dir";

export type EncryptTarget = keyof typeof ENCRYPT_KEYS;
export type AutoSaveTarget = keyof typeof AUTO_SAVE_KEYS;

export interface StorageAutoSaveState {
  /** 任务成功后是否把视频与封面一起下载到本地 */
  video: boolean;
  /** 上传的参考素材是否自动存入本地素材箱 */
  asset: boolean;
}

export interface StorageEncryptionState {
  /** 视频是否加密落盘 */
  video: boolean;
  /** 封面是否加密落盘 */
  cover: boolean;
  /** 上传素材是否加密落盘 */
  asset: boolean;
  /** 是否配置了 STORAGE_PASSWORD；未配置时无法开启 */
  available: boolean;
}

export interface StorageSettings {
  /** 新任务成功后自动保存哪些产物 */
  autoSave: StorageAutoSaveState;
  encryption: StorageEncryptionState;
  /** 生效中的落盘根目录（绝对路径） */
  storageDir: string;
}

/** 主密码只从环境变量读取，绝不入库、不回传前端。 */
export function encryptionAvailable(): boolean {
  return config.storagePassword.trim().length > 0;
}

export async function getStorageEncryption(): Promise<StorageEncryptionState> {
  const available = encryptionAvailable();
  const [legacy, rows] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LEGACY_ENCRYPT_KEY } }),
    prisma.setting.findMany({ where: { key: { in: Object.values(ENCRYPT_KEYS) } } }),
  ]);
  const stored = new Map(rows.map((row) => [row.key, row.value === "1"]));
  const fallback = legacy?.value === "1";
  const pick = (target: EncryptTarget): boolean => {
    const key = ENCRYPT_KEYS[target];
    return stored.has(key) ? Boolean(stored.get(key)) : fallback;
  };
  // 没配主密码时即使曾经打开过也视为关闭，避免产出无法解开的文件。
  return {
    video: available && pick("video"),
    cover: available && pick("cover"),
    asset: available && pick("asset"),
    available,
  };
}

export async function setStorageEncryption(
  target: EncryptTarget,
  enabled: boolean
): Promise<StorageEncryptionState> {
  if (enabled && !encryptionAvailable()) {
    throw errors.validation("未配置 STORAGE_PASSWORD，请先在 .env 中设置主密码再开启加密落盘");
  }
  const key = ENCRYPT_KEYS[target];
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: enabled ? "1" : "0" },
    update: { value: enabled ? "1" : "0" },
  });
  return getStorageEncryption();
}

/** 落盘时调用：只有对应开关打开且配置了主密码才加密。 */
export async function shouldEncryptStorage(target: EncryptTarget): Promise<boolean> {
  if (!encryptionAvailable()) return false;
  const row = await prisma.setting.findUnique({ where: { key: ENCRYPT_KEYS[target] } });
  if (row) return row.value === "1";
  const legacy = await prisma.setting.findUnique({ where: { key: LEGACY_ENCRYPT_KEY } });
  return legacy?.value === "1";
}

export async function getStorageAutoSave(): Promise<StorageAutoSaveState> {
  const [legacy, rows] = await Promise.all([
    prisma.setting.findUnique({ where: { key: LEGACY_AUTO_SAVE_KEY } }),
    prisma.setting.findMany({ where: { key: { in: Object.values(AUTO_SAVE_KEYS) } } }),
  ]);
  const stored = new Map(rows.map((row) => [row.key, row.value === "1"]));
  // 从未配置过时默认开启；旧键只在未单独设置时生效。
  const fallback = legacy ? legacy.value === "1" : true;
  const pick = (target: AutoSaveTarget): boolean => {
    const key = AUTO_SAVE_KEYS[target];
    return stored.has(key) ? Boolean(stored.get(key)) : fallback;
  };
  return { video: pick("video"), asset: pick("asset") };
}

export async function setStorageAutoSave(target: AutoSaveTarget, enabled: boolean): Promise<void> {
  const key = AUTO_SAVE_KEYS[target];
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: enabled ? "1" : "0" },
    update: { value: enabled ? "1" : "0" },
  });
}

/** 上传素材是否自动存入素材箱；没有记录时默认开启。 */
export async function getKeepAssets(): Promise<boolean> {
  return (await getStorageAutoSave()).asset;
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
    await mkdir(join(target, "assets"), { recursive: true });
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
    getStorageAutoSave(),
    getStorageEncryption(),
    getStorageDir(),
  ]);
  return { autoSave, encryption, storageDir };
}
