/**
 * 复制文本到剪贴板。
 *
 * navigator.clipboard 只在安全上下文（HTTPS 或 localhost）里可用，
 * 内网部署通常是 http://IP:端口，所以必须保留 execCommand 这条老路，
 * 否则「复制 ID / 复制提示词」点了只会报错。
 */
export async function copyText(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 权限被拒或浏览器不给用，往下走兜底方案
    }
  }
  if (legacyCopy(value)) return;
  throw new Error("浏览器不允许自动复制，请手动选中文本复制");
}

/** 临时 textarea + execCommand：非安全上下文里唯一还能用的同步复制方式。 */
function legacyCopy(value: string): boolean {
  const previousFocus = document.activeElement as HTMLElement | null;

  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none;";

  // iOS 上只读 textarea 无法 select，先临时去掉 readonly
  area.readOnly = false;
  document.body.appendChild(area);

  let copied = false;
  try {
    area.select();
    area.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  document.body.removeChild(area);
  previousFocus?.focus?.();
  return copied;
}
