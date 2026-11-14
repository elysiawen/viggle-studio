import type { VideoProvider } from "./types";
import { ViggleProvider } from "./viggle";

// Next.js 生产构建会把模块复制进不同 chunk；模块级变量不是全局单例。
// 用 globalThis 共享实例，保证所有 Route Handler 拿到同一个 Provider。
const globalForProvider = globalThis as unknown as {
  __viggleProvider?: VideoProvider;
};

/** 应用只对接 Viggle 真实上游。 */
export function getProvider(): VideoProvider {
  globalForProvider.__viggleProvider ??= new ViggleProvider();
  return globalForProvider.__viggleProvider;
}

/** 测试注入点。 */
export function setProvider(provider: VideoProvider | null): void {
  globalForProvider.__viggleProvider = provider ?? undefined;
}

export type {
  VideoProvider,
  ProviderContext,
  GenerationPayload,
  RemoteTaskState,
  VideoStream,
} from "./types";
