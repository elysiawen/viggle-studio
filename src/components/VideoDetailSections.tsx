"use client";

import { copyText } from "@/lib/clipboard";
import { MODE_META } from "@/lib/constants";
import { formatTime } from "@/lib/format";
import type { GenerationMode } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon } from "./ui";

export interface VideoDetailData {
  prompt: string;
  mode: GenerationMode;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  accountLabel: string;
  status?: string;
  createdAt: string;
  finishedAt: string | null;
  taskId: string;
  remoteId: string | null;
}

/**
 * 任务详情的主体信息（提示词 / 生成参数 / 记录信息）。
 * 在线历史与本地文件共用同一份组件，保证两处 UI 完全一致。
 */
export function VideoDetailSections({
  data,
  extraRecords = [],
}: {
  data: VideoDetailData;
  /** 额外追加到「记录信息」里的行，例如本地文件的落盘时间与大小 */
  extraRecords?: Array<[string, string]>;
}) {
  const { notify } = useStudio();

  async function copy(value: string, done: string) {
    try {
      await copyText(value);
      notify(done, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  const params: Array<[string, string]> = [
    ["生成模式", MODE_META[data.mode]?.label ?? data.mode],
    ["画面比例", data.aspectRatio],
    ["时长", `${data.duration} 秒`],
    ["分辨率", data.resolution],
    ["生成质量", data.qualityType === 0 ? "Flash · 免费" : `Type ${data.qualityType}`],
    ["使用账号", data.accountLabel],
  ];

  const records: Array<[string, string]> = [
    ["创建时间", formatTime(data.createdAt)],
    ["完成时间", formatTime(data.finishedAt)],
    ...extraRecords,
  ];

  return (
    <div className="detail-info">
      <div className="detail-section">
        <div className="detail-section__head">
          <h3 className="detail-section__title">完整提示词</h3>
          {data.prompt && (
            <button
              className="btn btn--ghost btn--sm"
              onClick={() => void copy(data.prompt, "提示词已复制")}
            >
              <Icon name="copy" size={13} /> 复制提示词
            </button>
          )}
        </div>
        <div className="detail-prompt">{data.prompt || "（无提示词）"}</div>
      </div>

      <div className="detail-section">
        <h3 className="detail-section__title">生成参数</h3>
        <div className="detail-grid">
          {params.map(([label, value]) => (
            <div className="detail-cell" key={label}>
              <span>{label}</span>
              <b title={value}>{value}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3 className="detail-section__title">记录信息</h3>
        <div className="detail-grid">
          {records.map(([label, value]) => (
            <div className="detail-cell" key={label}>
              <span>{label}</span>
              <b title={value}>{value}</b>
            </div>
          ))}
          <div className="detail-cell detail-cell--wide">
            <span>本地记录 ID</span>
            <b className="mono" title={data.taskId}>
              {data.taskId}
            </b>
          </div>
          <div className="detail-cell detail-cell--wide">
            <span>上游任务 ID</span>
            <b className="mono" title={data.remoteId ?? undefined}>
              {data.remoteId ?? "-"}
            </b>
          </div>
        </div>
      </div>
    </div>
  );
}
