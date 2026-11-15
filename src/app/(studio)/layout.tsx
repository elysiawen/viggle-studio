import type { ReactNode } from "react";
import { StudioShell } from "@/components/StudioShell";

/**
 * 工作台外壳（侧边栏 + 顶栏 + StudioProvider）。
 * 放在路由组里，切换视图时只替换 children，SSE 连接与全局状态不会重建。
 */
export default function StudioLayout({ children }: { children: ReactNode }) {
  return <StudioShell>{children}</StudioShell>;
}
