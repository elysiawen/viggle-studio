import { PrismaClient } from "@prisma/client";
import { config } from "./config";

// Next.js dev 模式会反复热重载模块，必须把实例挂在 globalThis 上避免连接泄漏。
const globalForPrisma = globalThis as unknown as { __vigglePrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__vigglePrisma ??
  new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    log: config.isProduction ? ["error"] : ["error", "warn"],
  });

// 同理，生产构建也可能按 chunk 复制模块，始终共享连接池实例。
globalForPrisma.__vigglePrisma = prisma;
