"use client";

import { GeneratePanel } from "./GeneratePanel";
import { PreviewPanel, TaskQueue } from "./PreviewPanel";
import { Icon } from "./ui";

/** 生成工作台（/） */
export function WorkspaceView() {
  return (
    <div className="view view--workspace">
      <div className="view__head">
        <div>
          <h1 className="view__title">创建你的下一个视频</h1>
          <p className="view__subtitle">上传参考素材或写一句提示词，让角色按你的想法动起来</p>
        </div>
        <div className="model-card model-card--workspace">
          <div className="model-card__icon">H3</div>
          <div className="model-card__info">
            <div className="model-card__title">
              MiniMax H3 <span className="badge badge--lime">FREE</span>
            </div>
            <p className="model-card__desc">One model for every modality.</p>
          </div>
          <span className="model-card__check"><Icon name="check" size={18} /></span>
        </div>
      </div>
      <div className="workspace-grid">
        <div className="workspace-left"><GeneratePanel /></div>
        <div className="workspace-right"><PreviewPanel /><TaskQueue /></div>
      </div>
    </div>
  );
}
