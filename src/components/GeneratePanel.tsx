"use client";

import { useRef, useState } from "react";
import { errorMessage } from "@/lib/api-client";
import {
  DURATIONS,
  FREE_TIER,
  MAX_REFERENCE_MEDIA,
  MODE_META,
  QUALITY_TYPES,
  RESOLUTIONS,
} from "@/lib/constants";
import type { GenerationMode } from "@/lib/types";
import { LibraryPicker } from "./LibraryPicker";
import { useStudio } from "./studio-context";
import { AspectRatioPicker, Icon, Modal, SelectMenu, type IconName } from "./ui";

const MODE_ICONS: Record<GenerationMode, IconName> = {
  references: "image",
  frames: "layers",
  text: "text",
};

/** 素材上传状态角标：本地素材箱选的素材在点击生成后才上传。 */
function UploadStatus({ busy }: { busy: boolean }) {
  if (!busy) return <span className="thumb__status">待上传</span>;
  return (
    <span className="thumb__status is-busy">
      <span className="spinner" /> 上传中
    </span>
  );
}

export function GeneratePanel() {
  const {
    mode,
    setMode,
    drafts,
    addFiles,
    removeDraft,
    generate,
    submitting,
    me,
    notify,
    setView,
    accountMode,
    generateForm,
    setGenerateForm,
  } = useStudio();

  const { prompt, aspectRatio, duration, resolution, qualityType } = generateForm;
  const [dragging, setDragging] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);

  const refInput = useRef<HTMLInputElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);

  const references = drafts.filter((d) => d.role === "reference");
  const first = drafts.find((d) => d.role === "first");
  const last = drafts.find((d) => d.role === "last");
  const uploading = drafts.some((d) => d.uploading);
  const noAccount = !me?.activeAccount;
  /** 来自本地素材箱的素材没有上游 ID，点生成时才由后端上传。 */
  const isPendingUpload = (draft: { id: string | null; localAssetId?: string | null }) =>
    !draft.id && !!draft.localAssetId;

  async function onGenerate() {
    if (!prompt.trim()) return notify("请先输入提示词", "error");
    try {
      await generate({ prompt: prompt.trim(), aspectRatio, duration, resolution, qualityType });
      setGenerateForm({ prompt: "" });
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  function openLibrary() {
    setLibraryOpen(true);
  }

  return (
    <section className="panel">
      <div className="panel__body">
        <div className="generate-scroll">
        <div className="section-label">
          生成模式 <span>{MODE_META[mode].short}</span>
        </div>
        <div className="segmented" role="tablist" aria-label="生成模式">
          {(Object.keys(MODE_META) as GenerationMode[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              className={`segment ${mode === key ? "is-active" : ""}`}
              onClick={() => setMode(key)}
            >
              <Icon name={MODE_ICONS[key]} size={14} />
              {MODE_META[key].label}
            </button>
          ))}
        </div>
        <p className="mode-hint">{MODE_META[mode].description}</p>

        {noAccount && (
          <div className="alert alert--info" style={{ marginBottom: 16 }}>
            <Icon name="info" size={15} />
            <span className="grow">还没有激活的账号，添加后即可开始生成。</span>
            <button className="btn btn--sm" onClick={() => setView("accounts")}>去添加</button>
          </div>
        )}

        {mode === "references" && (
          <>
            <input
              ref={refInput}
              type="file"
              multiple
              hidden
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="reference-bar">
              <span className="reference-bar__label">
                参考素材 <span>{references.length}/{MAX_REFERENCE_MEDIA}</span>
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void openLibrary()}
                disabled={references.length >= MAX_REFERENCE_MEDIA}
                title="从素材箱选择已上传的图片 / 视频"
              >
                <Icon name="grid" size={14} /> 从素材箱选择
              </button>
            </div>
            <div
              className={`dropzone ${dragging ? "is-drag" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => refInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  refInput.current?.click();
                }
              }}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
              }}
            >
              {references.map((draft) => (
                <div
                  key={draft.key}
                  className={`thumb ${draft.uploading ? "is-uploading" : ""} ${
                    isPendingUpload(draft) ? "is-pending" : ""
                  }`}
                  style={{ backgroundImage: `url("${draft.previewUrl}")` }}
                  onClick={(event) => event.stopPropagation()}
                >
                  {draft.uploading && <div className="thumb__veil"><span className="spinner" /></div>}
                  {isPendingUpload(draft) && <UploadStatus busy={submitting} />}
                  {draft.isVideo && <span className="thumb__badge">VIDEO</span>}
                  {!draft.uploading && (
                    <button
                      className="thumb__remove"
                      onClick={(event) => { event.stopPropagation(); removeDraft(draft.key); }}
                      aria-label="移除素材"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
              {references.length < MAX_REFERENCE_MEDIA && (
                <button
                  type="button"
                  className="dropzone__add"
                  onClick={(event) => { event.stopPropagation(); refInput.current?.click(); }}
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label="添加参考素材"
                >
                  <Icon name="plus" size={18} />
                </button>
              )}
              {references.length === 0 && (
                <div className="dropzone__empty">
                  <span className="dropzone__title">上传参考图片 / 视频</span>
                  <span className="dropzone__sub">点击选择或拖拽文件到这里</span>
                </div>
              )}
            </div>
            <p className="upload-hint">最多 {MAX_REFERENCE_MEDIA} 个 · JPG / PNG / WebP / MP4 / MOV · 图片 ≤10MB，视频 ≤20MB</p>
          </>
        )}

        {mode === "frames" && (
          <>
            <input
              ref={startInput}
              type="file"
              hidden
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                if (event.target.files?.[0]) void addFiles([event.target.files[0]], "start");
                event.target.value = "";
              }}
            />
            <input
              ref={endInput}
              type="file"
              hidden
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                if (event.target.files?.[0]) void addFiles([event.target.files[0]], "end");
                event.target.value = "";
              }}
            />
            <div className="frame-grid">
              {([
                { key: "first" as const, label: "首帧", hint: "必填", item: first, input: startInput },
                { key: "last" as const, label: "尾帧", hint: "可选", item: last, input: endInput },
              ]).map((slot) => (
                <div
                  key={slot.key}
                  className={`frame-slot ${slot.item ? "has-image" : ""} ${
                    slot.item?.uploading ? "is-uploading" : ""
                  } ${slot.item && isPendingUpload(slot.item) ? "is-pending" : ""}`}
                  style={slot.item ? { backgroundImage: `url("${slot.item.previewUrl}")` } : undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => slot.input.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      slot.input.current?.click();
                    }
                  }}
                >
                  {!slot.item && (
                    <>
                      <span className="frame-slot__label"><Icon name="plus" size={14} /> {slot.label}</span>
                      <span className="frame-slot__hint">{slot.hint}</span>
                    </>
                  )}
                  {slot.item?.uploading && <div className="thumb__veil"><span className="spinner" /></div>}
                  {slot.item && isPendingUpload(slot.item) && <UploadStatus busy={submitting} />}
                  {slot.item && !slot.item.uploading && (
                    <button
                      className="frame-slot__remove"
                      onClick={(event) => { event.stopPropagation(); removeDraft(slot.item!.key); }}
                      aria-label={`移除${slot.label}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="upload-hint">首帧为起始画面，尾帧用于约束结束画面 · 仅支持图片</p>
          </>
        )}

        {mode === "text" && (
          <div className="text-mode">
            <Icon name="sparkles" size={18} />
            <span>纯文本模式无需上传素材，直接用提示词描述你想生成的画面。</span>
          </div>
        )}

        <div className="field">
          <div className="field__label-row">
            <label className="field__label" htmlFor="prompt">提示词</label>
            <button
              type="button"
              className="prompt-expand-trigger"
              onClick={() => setPromptEditorOpen(true)}
            >
              <Icon name="external" size={12} /> 全屏输入
            </button>
          </div>
          <textarea
            id="prompt"
            className="textarea"
            rows={4}
            placeholder="描述你想生成的视频，例如：A cute orange cat walking on a sunny beach, cinematic lighting"
            value={prompt}
            onChange={(event) => setGenerateForm({ prompt: event.target.value })}
          />
          <div className="textarea__meta">
            {prompt.length} 字
          </div>
        </div>
        </div>

        <div className="generate-dock">
        <div className="param-grid">
          <div className="param">
            <label className="param__label" htmlFor="aspect">画面比例</label>
            <AspectRatioPicker
              id="aspect"
              value={aspectRatio}
              onChange={(value) => setGenerateForm({ aspectRatio: value })}
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="duration">时长</label>
            <SelectMenu
              id="duration"
              value={String(duration)}
              options={DURATIONS.map((value) => ({ value: String(value), label: `${value} 秒` }))}
              onChange={(value) => setGenerateForm({ duration: Number(value) })}
              menuTitle="时长"
              ariaLabel="时长"
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="resolution">分辨率</label>
            <SelectMenu
              id="resolution"
              value={resolution}
              options={RESOLUTIONS.map((value) => ({ value, label: value }))}
              onChange={(value) => setGenerateForm({ resolution: value })}
              menuTitle="分辨率"
              ariaLabel="分辨率"
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="quality">生成质量</label>
            <SelectMenu
              id="quality"
              value={String(qualityType)}
              options={QUALITY_TYPES.map((item) => ({ value: String(item.value), label: item.label }))}
              onChange={(value) => setGenerateForm({ qualityType: Number(value) })}
              menuTitle="生成质量"
              ariaLabel="生成质量"
            />
          </div>
        </div>

        <div className="cost-row">
          <span>
            {accountMode === "auto"
              ? `自动选号 · 「${me?.activeAccount?.label ?? "--"}」剩余 ${me?.profile?.freeCredits ?? "--"} 积分`
              : `预计消耗 · 当前账号剩余 ${me?.profile?.freeCredits ?? "--"} 积分`}
          </span>
          <b>{FREE_TIER.creditsPerGeneration} 积分</b>
        </div>

        <button
          className="generate-btn"
          onClick={() => void onGenerate()}
          disabled={submitting || uploading || noAccount}
        >
          {submitting ? <><span className="spinner" /> 提交中…</> : <><Icon name="sparkles" size={17} /> GENERATE</>}
        </button>
        <p className="generate-note">
          {accountMode === "auto"
            ? `自动模式：生成前实时校验，自动使用积分 ≥ ${FREE_TIER.creditsPerGeneration} 的账号`
            : "免费额度：5 秒 · 768p · Flash · 约 2 次/天"}
        </p>
        </div>
      </div>
      {promptEditorOpen && (
        <Modal
          title="全屏输入提示词"
          wide
          headerExtra={<span className="prompt-fullscreen__count">{prompt.length} 字</span>}
          onClose={() => setPromptEditorOpen(false)}
          footer={
            <button className="btn btn--primary" onClick={() => setPromptEditorOpen(false)}>完成</button>
          }
        >
          <div className="prompt-fullscreen">
            <textarea
              className="textarea prompt-fullscreen__textarea"
              aria-label="全屏输入提示词"
              placeholder="描述你想生成的视频，支持输入较长的分镜、动作和画面细节。"
              value={prompt}
              onChange={(event) => setGenerateForm({ prompt: event.target.value })}
              autoFocus
            />
          </div>
        </Modal>
      )}
      {libraryOpen && <LibraryPicker onClose={() => setLibraryOpen(false)} />}
    </section>
  );
}
