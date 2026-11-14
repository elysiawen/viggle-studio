# Viggle.ai 视频生成（MiniMax H3）接口分析与复现报告

> 测试目标：`https://viggle.ai/meme/app/video-gen`
> 测试时间：2026-11-15
> 测试范围：仅使用免费额度（MiniMax H3 / 5 秒 / 768p / Flash）
> 账号：`losil77999@bwingmedia.com`（凭据已脱敏）

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-11-15 | 初稿：签名算法还原、生成接口（first-last-frame）、任务轮询、积分查询接口、完整复现并下载视频 |
| 2026-11-15 | 补充：素材上传接口（图片 `/api/asset/image`、视频 `/api/asset/video`）、参考图/参考视频生成模式（`reference-media`） |
| 2026-11-15 | 补充：登录流程复刻分析（`/api/user/login2` + Cloudflare Turnstile，域名绑定导致本地无法通过） |
| 2026-11-15 | 补充：删除接口（`/api/video-task`、`/api/asset/video`、`/api/asset/image`），实测确认删除生成视频需用 `/api/asset/video`，删除为幂等操作 |
| 2026-11-15 | 补充：素材库列表接口（`/api/asset/image`、`/api/asset/video`、`/api/video-task`），可复用已有素材无需重复上传 |
| 2026-11-15 | 补充：实时同步 SSE 接口（`GET /api/events`）实测验证，确认无需签名头、5 种事件类型及数据结构 |

---

## 1. 结论摘要

Viggle 的 Web 端视频生成功能并不走公开的 `docs.viggle.ai` API，而是通过同源接口 `https://viggle.ai/api/...` 完成。核心机制：

1. 登录态 JWT 保存在 `localStorage.viggleToken`，请求时放入 `Authorization: Bearer <JWT>`。
2. 所有 `/api/*` 请求额外携带三个自定义请求头：`t`（毫秒时间戳）、`u`（UUID v4）、`s`（MD5 签名）。
3. 签名算法已从打包后的前端代码中还原，并通过历史抓包与真实请求双重验证：

```
s = MD5( t + u + UA最后一段 + payloadStr + "qdsnfXVFGS1dVCYTju" )
```

4. 文生视频（无参考图）实际调用：
   `POST /api/asset/video/gen/mini-max/first-last-frame`
5. 任务创建后通过 `GET /api/asset/video/{id}` 轮询，`status=2` 处理中，`status=0` 成功并返回带签名的 MP4 地址（有效期 13 小时）。

本次已按上述接口成功生成并下载视频：

- 任务 ID：`9ec17e88-ad52-46d4-a44b-a6705fa822d4`
- 视频文件：`output/viggle_minimax_h3_5s_768p_flash.mp4`（实测产物，未随仓库保留）
- 媒体信息：H.264 / 1344×768 / 24fps / 5.17s / 2.46 MB

---

## 2. 鉴权与会话

| 项目 | 值 |
| --- | --- |
| 登录凭据存储 | `localStorage["viggleToken"]`（值为 JSON 字符串，需先 `JSON.parse`） |
| 传递方式 | 请求头 `Authorization: Bearer <JWT>` |
| JWT 载荷 | `sub` / `id` / `uid` / `iss=viggle` / `iat` / `exp` |
| 有效期 | 本次 Token `iat=2026-11-15 10:53:54Z`，`exp=2026-12-14 10:53:54Z`（30 天） |
| Cookie | API 鉴权不依赖 Cookie，但站点有 Cloudflare 防护，浏览器上下文会附带 `_ga`、`cf_*` 等 Cookie |

> 注意：Token 为账号级凭据，文档中不保留明文。

---

## 3. 请求签名算法（核心）

前端 axios 请求拦截器为每个请求生成三个头：

| 请求头 | 含义 | 示例 |
| --- | --- | --- |
| `t` | 当前时间戳（毫秒） | `1794654203375` |
| `u` | 随机 UUID v4 | `f37a084c-89fb-453a-b3dd-e0c07b83753e` |
| `s` | MD5 签名（32 位小写 hex） | `42bcdec03d9597dcaabc49082eb980c5` |

### 3.1 签名公式

```text
uaLast    = navigator.userAgent.split("/").pop()      // Chrome 下为 "537.36"
payloadStr = POST 请求的原始 JSON 字符串（与请求体完全一致，键顺序敏感）
           = GET  请求时参数串（见 3.2）
s = MD5(t + u + uaLast + payloadStr + "qdsnfXVFGS1dVCYTju")
```

末尾的 `qdsnfXVFGS1dVCYTju` 是前端硬编码的盐值。

### 3.2 GET 与 POST 的 payloadStr 规则

- **POST**：`payloadStr = JSON.stringify(body)`，即实际发送的原始 body 字符串。
  body 中值为 `undefined` 的字段不会出现在 JSON 里，签名也必须按去掉后的字符串计算。
- **GET（带查询参数）**：参数键名升序排序后，拼接为 `key=[value]`，**无分隔符**。
  例如 `{page:1, pageSize:10}` → `page=[1]pageSize=[10]`。
- **GET（无查询参数）**：`payloadStr = ""`。

### 3.3 签名验证样例

以一次真实抓包为例：

```text
t = 1794654203375
u = f37a084c-89fb-453a-b3dd-e0c07b83753e
uaLast = 537.36
body = {"duration":5,"modelType":7,"qualityType":0,"resolution":"768p"}
MD5("1794654203375" + "f37a084c-89fb-453a-b3dd-e0c07b83753e" + "537.36" + body + "qdsnfXVFGS1dVCYTju")
    = 42bcdec03d9597dcaabc49082eb980c5
```

与抓包得到的 `s` 完全一致。

> 缺失或错误签名时，服务端返回 HTTP 400：
> `{"code":100019,"message":"input err","reason":"Network error, please try again later","data":null}`

---

## 4. 接口清单

| 方法 | 路径 | 作用 | 是否消耗额度 |
| --- | --- | --- | --- |
| GET | `/api/user` | 用户信息、积分余额与免费次数 | 否 |
| GET | `/api/user/credit-record` | 积分流水明细（含每次变动后余额） | 否 |
| GET | `/api/asset/video/gen/availability` | 模型可用状态、免费加速次数 | 否 |
| POST | `/api/asset/video/gen/credits/calculate` | 预估本次生成消耗积分 | 否 |
| POST | `/api/asset/video/gen/mini-max/first-last-frame` | 创建 MiniMax 视频任务（文生视频/首尾帧） | **是** |
| POST | `/api/asset/video/gen/mini-max/reference-media` | 创建 MiniMax 视频任务（参考图/视频） | **是** |
| POST | `/api/asset/image` | 上传图片素材（参考图、首帧、尾帧） | 否 |
| POST | `/api/asset/video` | 上传视频素材（参考视频） | 否 |
| GET | `/api/asset/video/gen?page=1&pageSize=10` | 生成历史列表 | 否 |
| GET | `/api/video-task?page=1&pageSize=20` | 生成任务列表（素材库"视频任务"分类） | 否 |
| GET | `/api/asset/video?page=1&pageSize=20` | 视频素材库列表（已上传的参考视频） | 否 |
| GET | `/api/asset/image?page=1&pageSize=20` | 图片素材库列表（已上传的参考图/首尾帧） | 否 |
| GET | `/api/asset/video/{id}` | 查询任务状态与产物地址 | 否 |
| GET | `/api/asset/video/gen/by-task/{taskId}` | 按异步任务 ID 查询 | 否 |
| POST | `/api/asset/video/gen/{id}/priority-boost` | 免费排队加速（每天 1 次） | 否 |
| POST | `/api/asset/video/gen/mini-max/{id}/super-resolution` | 超分辨率（收费能力） | 是 |
| DELETE | `/api/video-task` | 删除任务索引（不删视频文件，实测无效清理） | 否 |
| DELETE | `/api/asset/video` | 删除视频（生成的视频 + 上传的参考视频，联动清除历史） | 否 |
| DELETE | `/api/asset/image` | 删除图片素材（上传的参考图/首尾帧） | 否 |

其他模型族接口（仅列出，未测试）：`/asset/video/gen/wan/text`、`/asset/video/gen/seedance/first-last-frame`、`/asset/video/gen/veo/first-last-frame`、`/asset/video/gen/happy-horse/text` 等。

---

## 5. 生成流程

```text
1. GET  /api/asset/video/gen/availability         # 检查模型/免费次数
2. POST /api/asset/video/gen/credits/calculate    # 预估积分（可选）
3. POST /api/asset/video/gen/mini-max/first-last-frame   # 创建任务，返回 data.id
4. GET  /api/asset/video/{id}                     # 轮询，直到 status=0
5. 下载 data.url（S3/R2 预签名地址，13 小时有效）
```

### 5.1 积分预估

请求：

```http
POST /api/asset/video/gen/credits/calculate
Content-Type: application/json
Authorization: Bearer <JWT>
t: <ms>
u: <uuid v4>
s: <md5>

{"duration":5,"modelType":7,"qualityType":0,"resolution":"768p"}
```

响应：

```json
{"code":0,"message":"ok","ts":"","reason":"","data":{"credits":2}}
```

### 5.2 创建生成任务（文生视频）

请求：

```http
POST /api/asset/video/gen/mini-max/first-last-frame
Content-Type: application/json
Authorization: Bearer <JWT>
t: <ms>
u: <uuid v4>
s: <md5>

{
  "aspectRatio": "16:9",
  "duration": 5,
  "resolution": "768p",
  "prompt": "A cute orange cat walking on a sunny beach, cinematic lighting",
  "qualityType": 0,
  "enhanceType": 1
}
```

响应：

```json
{"code":0,"message":"ok","ts":"","reason":"","data":{"id":"9ec17e88-ad52-46d4-a44b-a6705fa822d4"}}
```

说明：

- 即使页面默认 Tab 是 `references`，在没有参考素材时前端同样调用 `first-last-frame` 接口，并省略 `firstFrameImageAssetID` / `lastFrameImageAssetID` 字段。
- `reuseID` 在普通生成时为 `undefined`，不会出现在请求体中。
- `enhanceType: 1` 表示开启提示词增强（前端值为 `+!promptEnhance`）。
- 带参考素材时改用 `/mini-max/reference-media`，body 增加 `referenceMedia` 数组、去掉首尾帧字段。

### 5.2.1 上传素材（图片 / 视频 / 首尾帧）

图片走 `/api/asset/image`，视频走 `/api/asset/video`，两者都是 multipart，字段名固定为 `file`：

```http
POST /api/asset/image        # 图片：JPG / PNG / WebP
POST /api/asset/video        # 视频：MP4 / MOV
Content-Type: multipart/form-data; boundary=<boundary>
Authorization: Bearer <JWT>
t: <ms>
u: <uuid v4>
s: <md5>

file=<二进制文件>
```

响应（视频多返回一个 `coverURL` 封面图）：

```json
{"code":0,"message":"ok","ts":"","reason":"","data":{"id":"87429b18-0e4e-4491-91a5-82cc06aa5db7","url":"https://...r2.cloudflarestorage.com/....mp4","coverURL":"https://.../cover/....jpg","name":"video_179465...","sourceType":1}}
```

说明：

- 表单字段名固定为 `file`；文件名带扩展名即可（前端默认传原文件名）。
- 前端使用 `FormData` 时，签名 `s` 的 `payloadStr` 取空串（不做 JSON 序列化）。
- 返回的 `data.id` 即后续生成所需的素材 ID，`url` / `coverURL` 为临时访问地址（约 2 小时）。
- 图片限制约 10MB，视频建议 ≤20MB、时长 ≤15s。
- 上传不消耗积分，可以放心多次调用。

### 5.2.2 参考图模式与首尾帧模式

参考图模式（最多 5 个素材，`type` 取值：`0` 图片、`1` 视频、`2` 音频）：

```http
POST /api/asset/video/gen/mini-max/reference-media
Content-Type: application/json

{
  "aspectRatio": "16:9",
  "duration": 5,
  "resolution": "768p",
  "prompt": "A cute orange cat walking on a sunny beach",
  "qualityType": 0,
  "enhanceType": 1,
  "referenceMedia": [{"id": "7270dc70-77f1-4c3d-98af-814c48d07483", "type": 0}]
}
```

首尾帧模式（尾帧仅在首帧存在时才会提交）：

```http
POST /api/asset/video/gen/mini-max/first-last-frame
Content-Type: application/json

{
  "aspectRatio": "16:9",
  "duration": 5,
  "resolution": "768p",
  "prompt": "...",
  "qualityType": 0,
  "enhanceType": 1,
  "firstFrameImageAssetID": "<首帧素材ID>",
  "lastFrameImageAssetID": "<尾帧素材ID>"
}
```

### 5.3 轮询任务

```http
GET /api/asset/video/9ec17e88-ad52-46d4-a44b-a6705fa822d4
Authorization: Bearer <JWT>
t/u/s: 按无参数 GET 规则签名
```

处理中的响应（关键字段）：

```json
{
  "code": 0,
  "data": {
    "id": "9ec17e88-ad52-46d4-a44b-a6705fa822d4",
    "status": 2,
    "url": "",
    "coverURL": "",
    "videoDuration": 5,
    "gen": {
      "modelType": 7,
      "qualityType": 0,
      "aspectRatio": "16:9",
      "resolution": "768p",
      "prompt": "A cute orange cat walking on a sunny beach, cinematic lighting",
      "errorMessage": ""
    }
  }
}
```

完成后的响应（关键字段）：

```json
{
  "code": 0,
  "data": {
    "id": "9ec17e88-ad52-46d4-a44b-a6705fa822d4",
    "status": 0,
    "url": "https://<r2-host>/viggle-assets-v2/video-asset/gen/minimax/9ec17e88-ad52-46d4-a44b-a6705fa822d4.mp4?X-Amz-...",
    "coverURL": "https://<r2-host>/viggle-assets-v2/video-asset/cover/...jpg?X-Amz-...",
    "videoDuration": 5
  }
}
```

实测状态含义：`2` = 生成中，`0` = 成功。本次从创建到 `url` 就绪约 35 秒。

---

## 6. 参数映射

### 6.1 modelType（积分预估接口使用）

| 值 | 模型 |
| --- | --- |
| 1 | kling |
| 2 | wan |
| 3 | wan2.7 |
| 4 | seedance2.0 |
| 5 | seedance2.0fast |
| 6 | happyhorse |
| **7** | **minimaxh3（MiniMax H3）** |
| 8 | viggleanimate |
| 9 | seedance2.5 |

### 6.2 qualityType

| 值 | 含义 | 免费可用 |
| --- | --- | --- |
| **0** | lite / **Flash** | 是 |
| 1 | standard | 否（需订阅） |
| 2 | ultrafast | 否（需订阅） |

### 6.3 免费档限制（MiniMax H3）

| 参数 | 免费档取值 |
| --- | --- |
| duration | 固定 **5**（>5 秒需订阅） |
| resolution | 默认 **768p**；480p 可用；1080p / 2k 需订阅 |
| aspectRatio | 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 |
| 参考素材 | 最多 5 个（视频/图片），参考数量影响价格 |
| 积分 | 5s + 768p + Flash：**2 credits/次** |

---

## 7. 免费额度实测

| 指标 | 生成前 | 生成后 |
| --- | --- | --- |
| `freeCredits` | 5 | 3 |
| `remainingFreeMiniMaxVideoGenCount` | 未采集 | 4 |
| `remainingFreePriorityBoostCount` | 1 | 1 |
| `remainingVideoTasksCount` | 未采集 | 5 |

按 `2 credits/次` 计算，5 个免费积分约可生成 2 次 5s/768p 视频，与“每天约 2 次”的使用限制一致。

### 7.1 积分查询接口

**余额查询：`GET /api/user`**

积分相关字段：

```json
{
  "freeCredits": 3,
  "subscribeCredits": 0,
  "planCredits": 0,
  "purchasedCredits": 0,
  "remainingFreeMiniMaxVideoGenCount": 4,
  "remainingFreePriorityBoostCount": 1,
  "remainingVideoTasksCount": 5
}
```

**积分流水：`GET /api/user/credit-record?page=1&pageSize=10`**

签名参数串：`page=[1]pageSize=[10]`（键名升序，`key=[value]` 直接拼接）。

```json
{
  "code": 0,
  "data": [
    {
      "createdAt": "2026-11-15T11:07:09.509Z",
      "type": 16,
      "typeName": "Gen video",
      "freeCredits": -2,
      "planCredits": 0,
      "purchasedCredits": 0,
      "balance": 3
    }
  ],
  "total": 2
}
```

`balance` 为本次变动后的余额；`freeCredits: -2` 即一次 MiniMax H3（5s/768p/Flash）的消耗。

---

## 8. 复现代码

### 8.1 浏览器控制台（推荐，天然通过 Cloudflare）

在已登录的 `https://viggle.ai/meme/app/video-gen` 页面执行：

```js
function md5(str) {
  // 完整 MD5 实现略，见附录或使用任意 md5 库
}
const token = JSON.parse(localStorage.getItem("viggleToken"));
const uaLast = navigator.userAgent.split("/").pop();

async function signedFetch(path, method = "GET", body) {
  const t = String(Date.now());
  const u = crypto.randomUUID();
  const payloadStr = body ?? "";
  const s = md5(t + u + uaLast + payloadStr + "qdsnfXVFGS1dVCYTju");
  const headers = { authorization: `Bearer ${token}`, t, u, s };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(path, { method, headers, body });
  return res.json();
}

// 1) 预估积分
await signedFetch("/api/asset/video/gen/credits/calculate", "POST",
  JSON.stringify({ duration: 5, modelType: 7, qualityType: 0, resolution: "768p" }));

// 2) 创建任务
const payload = JSON.stringify({
  aspectRatio: "16:9",
  duration: 5,
  resolution: "768p",
  prompt: "A cute orange cat walking on a sunny beach, cinematic lighting",
  qualityType: 0,
  enhanceType: 1,
});
const created = await signedFetch("/api/asset/video/gen/mini-max/first-last-frame", "POST", payload);

// 3) 轮询
const id = created.data.id;
let detail;
do {
  await new Promise((r) => setTimeout(r, 5000));
  detail = await signedFetch(`/api/asset/video/${id}`);
} while (detail.data.status === 2);

// 4) 下载
if (detail.data.url) window.open(detail.data.url, "_blank");
```

### 8.2 Node.js（需自行处理 Cloudflare）

```js
import { createHash, randomUUID } from "node:crypto";

const TOKEN = "<从 localStorage.viggleToken 解析出的 JWT>";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";

function sign(t, u, payloadStr) {
  const uaLast = UA.split("/").pop(); // "537.36"
  return createHash("md5")
    .update(t + u + uaLast + payloadStr + "qdsnfXVFGS1dVCYTju", "utf8")
    .digest("hex");
}

async function api(path, method = "GET", body) {
  const t = String(Date.now());
  const u = randomUUID();
  const headers = {
    authorization: `Bearer ${TOKEN}`,
    t, u,
    s: sign(t, u, body ?? ""),
    origin: "https://viggle.ai",
    referer: "https://viggle.ai/meme/app/video-gen",
  };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch("https://viggle.ai" + path, { method, headers, body });
  return { status: res.status, json: await res.json() };
}
```

> 直接使用 Node / curl 访问可能被 Cloudflare 拦截并返回 403（`Just a moment...`）。实测同一 IP 下浏览器上下文稳定可用；如需脱离浏览器，需要额外携带有效的 Cloudflare 会话 Cookie（如 `cf_clearance`）并匹配 TLS 指纹。

---

## 9. 安全观察与加固建议（防守视角）

1. **签名密钥硬编码在前端**：`qdsnfXVFGS1dVCYTju` 与算法均在 JS bundle 中，可被完整还原，无法阻止有意的接口复用。签名只能提高脚本调用门槛，不能作为安全边界。
2. **签名内容不包含 URL**：`s` 只覆盖时间戳、UUID、UA 与 body，不含 path/method，理论上可将同一签名跨接口复用（在时间窗口内）。
3. **时间戳与 UUID 未见强绑定**：`u` 仅要求 UUID 格式，服务端若只校验 `t` 的新鲜度，重放窗口取决于时间容差。
4. **JWT 存放在 localStorage**：任意 XSS 均可直接窃取 30 天有效期的登录态；建议改用 HttpOnly Cookie + CSRF 防护。
5. **对象存储直传 URL**：产物为预签名 R2 地址（13 小时），拿到 URL 即可匿名下载，需注意分享泄露。
6. **建议服务端**：将 path、method、关键业务参数纳入签名；增加 nonce 去重与短时间窗；对同一账号的生成接口做频率与设备指纹校验。

---

## 10. 附录：本次实测的完整链路

```text
GET  /api/asset/video/gen/availability                    200  {"data":{"seedanceStatus":0,"remainingFreePriorityBoostCount":1}}
GET  /api/user                                            200  freeCredits=5
POST /api/asset/video/gen/credits/calculate               200  {"data":{"credits":2}}
POST /api/asset/video/gen/mini-max/first-last-frame       200  {"data":{"id":"9ec17e88-ad52-46d4-a44b-a6705fa822d4"}}
GET  /api/asset/video/9ec17e88-...                        200  status=2 ×6
GET  /api/asset/video/9ec17e88-...                        200  status=0，返回 url / coverURL
GET  <R2 预签名 MP4>                                      200  2,575,302 bytes
```

创建请求体（原文）：

```json
{"aspectRatio":"16:9","duration":5,"resolution":"768p","prompt":"A cute orange cat walking on a sunny beach, cinematic lighting","qualityType":0,"enhanceType":1}
```

对应签名参数：

```text
t = 1794654429588
u = ed230505-36c3-40a7-ba69-89b1803df5f3
s = 36a559e8a457ee15ea076e95ada52da8
```

---

## 11. 登录流程复刻

### 11.1 接口

```http
POST /api/user/login2
Content-Type: application/json
t: <ms>
u: <uuid v4>
s: <md5>

{
  "account": "losil77999@bwingmedia.com",
  "passwd": "MTIzNDU2d2Vu",
  "cf-turnstile-response": "<Turnstile token>"
}
```

说明：

- `passwd` 不是 MD5，而是 **UTF-8 密码的 Base64**（前端函数只做了 `btoa`）。
- 登录请求不带 `Authorization`，但签名 `s` 仍按 JSON body 计算。
- 响应 `data.token` 就是 `localStorage.viggleToken`，另外还带 `id`、`nickname`、`email`、`freeCredits` 等字段。

### 11.2 Turnstile

- 前端显式渲染：`https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
- sitekey：`0x4AAAAAABDVkhJeewVYhlo0`
- 服务端会强制校验，伪造 token 返回：

```json
{"code":3,"message":"input err","reason":"human verify failed: [invalid-input-response]"}
```

- 该 sitekey 绑定了 viggle.ai 域名，在 `127.0.0.1` 渲染会报 **110200（invalid domain）**，因此本地复刻页面无法完成这一步。

### 11.3 Token 生命周期

- JWT 固定 30 天有效期，**没有刷新接口**（已扫描全部 99 个 JS chunk 及完整 endpoint 表）。
- 接口返回 401 时前端直接清空 `viggleToken` 并提示重新登录。
- 登录接口需要密码 + Turnstile，无法静默续期；复用旧 token 只能重新登录后导出。

### 11.4 本地兜底

本地复刻项目提供 `POST /api/token`：先用 `GET /api/user` 校验 JWT，通过后写入 `token.txt`，下次请求立即生效。这样即使 Turnstile 无法在本地通过，也能用已有会话继续测试。

---

## 12. 删除接口

Viggle 提供三个 DELETE 接口，分别对应生成任务、视频素材、图片素材。**实测发现删除生成的视频必须用 `/api/asset/video`，`/api/video-task` 只会移除任务索引而不会真正删除视频文件。**

### 12.1 三个删除接口

| 接口 | 方法 | Body | 实际作用 |
| --- | --- | --- | --- |
| `/api/asset/video` | `DELETE` | `{"id": "<id>"}` | **真正删除视频文件**，同时从生成历史 `/api/asset/video/gen` 和素材库 `/api/asset/video` 中移除 |
| `/api/video-task` | `DELETE` | `{"id": "<id>"}` | 仅删除任务索引，视频文件仍保留在素材库中（实测无效清理） |
| `/api/asset/image` | `DELETE` | `{"id": "<id>"}` | 删除图片素材（参考图、首尾帧） |

### 12.2 删除生成视频的正确流程

```text
1. GET /api/asset/video/gen?page=1&pageSize=20   # 拉取生成历史，拿到 id
2. DELETE /api/asset/video  body: {"id": "<id>"}  # 删除视频（会联动清除历史记录）
```

> ⚠️ 不要用 `/api/video-task` 来删除生成的视频——它返回成功但视频仍在素材库和历史列表里。

### 12.3 对象区分

| 对象 | 对应数据 | 删除后影响 |
| --- | --- | --- |
| **asset/video** | 生成的视频 + 上传的参考视频 | 视频文件被删除，生成历史同步清空 |
| **asset/image** | 上传的参考图、首帧、尾帧 | 素材库中该图片被移除 |
| **video-task** | 任务索引 | 仅移除索引，视频文件残留（不推荐） |

### 12.4 请求示例

删除一条生成的视频：

```http
DELETE https://viggle.ai/api/asset/video
Content-Type: application/json
Authorization: Bearer <JWT>
u: <uuid>
s: <签名>
t: <毫秒时间戳>

{"id":"99db4f7f-887d-41e9-9d50-986db63fb00a"}
```

签名计算与其他接口一致：`payloadStr = '{"id":"..."}'`，`s = MD5(t + u + UA末段 + payloadStr + "qdsnfXVFGS1dVCYTju")`。

### 12.5 响应与幂等性

实测响应（成功）：

```json
{"code":0,"message":"ok","ts":"","reason":"","data":null}
```

**删除操作是幂等的**：即使传入不存在的 ID，也返回 `code:0` 成功，不会返回 `NOT_FOUND` 错误。前端代码中定义的 `VIDEO_TASK_NOT_FOUND(100001)`、`IMAGE_ASSET_NOT_FOUND(100003)` 等错误码在实际删除场景中不会触发，可能仅用于其他内部流程。

### 12.6 说明

- 删除操作**不消耗积分**。
- 三个接口都是破坏性操作，会真实删除账号下的内容，不可逆。
- 来源：前端 `useLibraryAssets` hook 中定义的 `useMutation('delete', path)`，HTTP 方法为 `DELETE`。
- 实测验证：对账号下 2 条生成记录先调 `/api/video-task`（无效），再调 `/api/asset/video`（成功清除，两个列表 `total: 0`）。

---

## 13. 素材库列表接口（图片 / 视频 / 生成任务）

账号下上传过的素材和生成过的任务都可以通过列表接口拉取，**无需重复上传**，直接拿到 `id` 即可用于后续生成或删除。

### 13.1 三个列表接口

| 接口 | 方法 | Query 参数 | 作用 |
| --- | --- | --- | --- |
| `/api/asset/image` | `GET` | `page`、`pageSize`、`sourceType` | 图片素材库（参考图、首尾帧） |
| `/api/asset/video` | `GET` | `page`、`pageSize`、`type` | 视频素材库（参考视频） |
| `/api/video-task` | `GET` | `page`、`pageSize`、`type` | 生成任务列表（历史作品） |

均为分页查询，前端默认 `pageSize=20`。

### 13.2 分类筛选参数

**图片素材 `/api/asset/image` 的 `sourceType`：**

| 值 | 含义 |
| --- | --- |
| 不传 / `undefined` | 全部 |
| `1` | 上传的素材（import） |
| `4` | Character Refine 生成的图片 |
| `3` | Cook 工具生成的图片 |

**视频素材 `/api/asset/video` 的 `type`：**

| 值 | 含义 |
| --- | --- |
| 不传 / `undefined` | 全部 |
| `1` | 上传的参考视频（import） |
| `4` | Character Refine |
| `3` | Cook |

**生成任务 `/api/video-task` 的 `type`：**

| 值 | 含义 |
| --- | --- |
| 不传 / `undefined` | 全部 |
| `0` | 导入（import） |
| `3` | Cook |

### 13.3 请求示例

拉取已上传的图片素材：

```http
GET https://viggle.ai/api/asset/image?page=1&pageSize=20&sourceType=1
Authorization: Bearer <JWT>
u: <uuid>
s: <签名>
t: <毫秒时间戳>
```

签名的 `payloadStr` 按 GET 规则：按键名排序后拼接为 `page=[1]pageSize=[20]sourceType=[1]`。

### 13.4 响应结构

```json
{
  "code": 0,
  "data": [
    {
      "id": "img-xxx",
      "url": "https://.../origin.png",
      "middleURL": "https://.../middle.png",
      "coverURL": "https://.../cover.png",
      "aspectRatio": 1.7778,
      "createdAt": "2026-11-15T10:00:00Z"
    }
  ],
  "total": 12
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 素材 ID，可直接用于生成接口的 `referenceMedia[].id` 或删除接口 |
| `url` | 原图/原视频地址 |
| `middleURL` | 中等尺寸缩略图，适合在素材库里展示 |
| `coverURL` | 封面图（视频素材） |
| `aspectRatio` | 宽高比 |
| `createdAt` | 创建时间 |

视频素材还会带 `status` 字段（`0` 表示处理完成可用）。

### 13.5 使用流程

```text
1. GET /api/asset/image?sourceType=1   # 拉取图片库
2. 用户选择若干图片，拿到它们的 id
3. POST /api/asset/video/gen/mini-max/reference-media
   body.referenceMedia = [{id, type:0}]   # type:0 图片, 1 视频
```

这样就能直接复用账号里已有的素材，不必每次重新上传。

### 13.6 说明

- 列表接口**不消耗积分**。
- 来源：前端 `libraryLists` 模块，通过 `useInfiniteQuery('get', path)` 无限滚动加载。
- 前端在进入素材库时会预取（prefetch）`/video-task`、`/asset/video?type=1`、`/asset/image?sourceType=1` 等几个常用分类。

---

## 14. 实时同步 SSE 接口（已验证）

前端通过 Server-Sent Events 接收任务进度、积分变动等实时推送，替代高频轮询。

### 14.1 连接信息

| 项 | 值 |
| --- | --- |
| 方法 | `GET` |
| 路径 | `/api/events` |
| 完整 URL | `https://viggle.ai/api/events` |
| Content-Type | `text/event-stream` |
| 鉴权 | `Authorization: Bearer <JWT>` |
| 签名头（t/u/s） | **不需要** |

> **关键点**：SSE 端点与普通 REST 接口不同，**不需要签名头（t、u、s）**，只需携带 `Authorization`。前端源码使用 `fetch` + `ReadableStream` 自行实现 SSE 解析（非原生 `EventSource`），因为需要自定义请求头。

### 14.2 最小请求示例

```http
GET /api/events HTTP/1.1
Host: viggle.ai
Authorization: Bearer <JWT>
Accept: text/event-stream
User-Agent: Mozilla/5.0 ... Chrome/157.0.0.0 Safari/537.36
```

实测响应（连接建立后立即收到）：

```
event: ready
data: {}

```

### 14.3 事件类型

前端注册了以下 5 种业务事件（连接建立时的 `ready` 不算业务事件）：

| 事件名 | 触发场景 | data 关键字段 | 后续动作 |
| --- | --- | --- | --- |
| `video.task_updated` | 视频生成任务状态变化 | `task_id` | 调 `GET /api/video-task/{id}` 拉取最新详情 |
| `video.gen_updated` | 视频素材生成完成 | `asset_id` | 调 `GET /api/asset/video/gen/by-task/{taskId}` 取结果 |
| `image.generation_updated` | 图片生成任务状态变化 | — | 刷新图片生成列表 |
| `billing.credit_updated` | 积分余额变动 | `plan_credits`, `purchased_credits` | 更新用户积分显示 |
| `billing.subscription_updated` | 订阅状态变化 | — | 刷新订阅信息 |

### 14.4 重连与退避

- 连接建立后先收到 `event: ready`，前端递增 `readySeq` 触发各订阅者的 `onResync` 回调（全量重拉一次，防丢消息）。
- 出错时指数退避重试，最多 **8 次**（`wh = 8`）。
- 收到 **4xx** 状态码时直接放弃重试（token 失效等不可恢复错误）。
- 页面隐藏时**保持连接**（`openWhenHidden: true`），不主动断开。

### 14.5 与轮询的关系

SSE 是轮询的**补充而非替代**：
- 收到 `video.task_updated` 事件后，前端仍需主动调 `GET /api/video-task/{id}` 取完整任务详情（事件只推送 ID，不推完整数据）。
- 未建立 SSE 连接时，前端退化为定时轮询。
- 因此**只需实现轮询即可完成生成流程**，SSE 是体验优化项。

### 14.6 验证记录

- 测试时间：2026-11-15
- 测试方式：httpcloak（chrome-latest 指纹）+ 流式读取
- 结果：HTTP 200，`content-type: text/event-stream`，收到 `event: ready\ndata: {}`，连接正常。
- 确认 `/events`（无 `/api` 前缀）返回 404（SPA fallback），正确路径为 `/api/events`。
