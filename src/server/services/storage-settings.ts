import { config } from "../config";
import { prisma } from "../db";
import { errors } from "../errors";

/** Setting 表里保存「落盘是否加密」的键。 */
const ENCRYPT_KEY = "storage.encrypt";

export interface StorageEncryptionState {
  /** 当前是否加密落盘 */
  enabled: boolean;
  /** 是否配置了 STORAGE_PASSWORD；未配置时无法开启 */
  available: boolean;
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
