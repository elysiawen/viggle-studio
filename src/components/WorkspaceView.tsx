"use client";

import { GeneratePanel } from "./GeneratePanel";
import { useStudio } from "./studio-context";
import { PreviewPanel, TaskQueue } from "./PreviewPanel";
import { Icon } from "./ui";

/** 生成工作台（/） */
export function WorkspaceView() {
  const { accounts } = useStudio();

  return (
    <div className="view view--workspace">
      <div className="view__head">
        <div>
          <h1 className="view__title">创建你的下一个视频</h1>
          <p className="view__subtitle">上传参考素材或写一句提示词，让角色按你的想法动起来</p>
        </div>
        <span className="badge badge--lime">
          <Icon name="layers" size={12} />
          {accounts.length} 个账号可用
        </span>
      </div>
      <div className="workspace-grid">
        <div className="workspace-left"><GeneratePanel /></div>
        <div className="workspace-right"><PreviewPanel /><TaskQueue /></div>
      </div>
    </div>
  );
}
