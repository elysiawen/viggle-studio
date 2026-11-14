# Viggle Studio 1.0

一个彻底重写的、本地运行的 **多账号 AI 视频生成工作台**。

原项目是一个约 1400 行、前后端混在一起的单文件课程演示（已完整归档到 `legacy/web/`）。本次重写把它拆成了分层清晰的 Next.js 全栈 TypeScript 应用：

| 维度 | 旧项目 | 1.0 |
| --- | --- | --- |
| 架构 | `server.js` 单文件 + 3 个静态文件 | Next.js App Router + Route Handlers + 分层 services / provider |
| 语言 | 原生 JS | 全栈 TypeScript（strict） |
| 账号 | 单个明文 `token.txt` | 多个上游账号，JWT 经 AES-256-GCM 加密存入 SQLite，UI 任意切换 |
| 数据 | 无 | Prisma + SQLite：账号 / 素材 / 任务 / 关系表 |
| 任务 | 浏览器里无边界 `while(true)` 每 4 秒轮询 | 服务端统一轮询守护 + 任务落库 + SSE 推送 + 超时保护 |
| 上游 | 签名逻辑散落在路由里 | `VideoProvider` 契约收敛签名、会话、multipart 等细节，对接 Viggle 真实接口 |
| UI | 单页命令式 DOM | 深色工作台：侧边导航、参数面板、实时预览、任务队列、历史画廊、素材箱 |
| 校验 | 前端/后端各写一份，`mode` 无白名单 | zod 统一校验 + 免费档硬约束 + 跨账号素材隔离 |
| 工程 | 无 `.gitignore` / 测试 / 配置 | `.env` 配置、单元测试、健康检查、结构化日志 |

---

## 快速开始

要求 **Node.js >= 20.9**（已在 22.12 验证）。

```bash
npm install          # postinstall 会自动执行 prisma generate
npm run db:push      # 创建 SQLite 数据库与全部表
npm run dev          # http://localhost:3000
```

首次使用：打开「账号管理」→ 添加从已登录 `viggle.ai` 页面导出的有效 JWT（`localStorage.viggleToken`）→ 点击「校验」确认状态为「可用」→ 回到「生成工作台」开始生成。

也可以点「导入 Cookie 文件」批量添加：选择 `cookie-profile-switcher` 一类插件导出的 JSON，只导入其中 `site=viggle.ai` 的 profile（从 `localStorage.viggleToken` 取 JWT），其它站点自动忽略；导入前会显示预览，已存在的 JWT 自动跳过。批量导入不自动校验，可在卡片上逐个点「校验」。

「导出账号」支持两种格式：与插件同构的 Cookie 软件格式（`cookie-profiles-*.json`），以及带备注、状态、邮箱、积分等元数据的项目备份格式（`viggle-studio-accounts-*.json`）。两者都能通过「导入 Cookie 文件」恢复。导出文件包含明文 JWT，请妥善保管。

生产构建：

```bash
npm run build
npm start
```

## 环境变量

见 `.env.example`。关键项：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:./viggle-studio.db` | 路径相对 `prisma/schema.prisma` |
| `CREDENTIALS_KEY` | 必填（生产） | 64 位 hex（32 字节）。**更换后已加密的 JWT 将无法解密，请备份** |
| `ACCESS_PASSWORD` | 空（不启用） | 设置后打开页面需要先输入该密码；修改后需重新 `npm run build` |
| `VIGGLE_BASE_URL` / `VIGGLE_USER_AGENT` / `VIGGLE_SIGN_SALT` | 见模板 | 上游基址、UA 与签名盐 |
| `VIGGLE_REQUEST_TIMEOUT_MS` / `VIGGLE_UPLOAD_TIMEOUT_MS` | 60000 / 120000 | 上游超时（内部换算为 httpcloak 的秒） |
| `TASK_POLL_INTERVAL_MS` / `TASK_POLL_MAX_AGE_MS` | 4000 / 900000 | 守护轮询间隔与任务最长存活时间 |

## 目录结构

```
prisma/schema.prisma            账号 / 素材 / 任务 / TaskAsset / Setting
src/lib/                        共享类型、参数常量、API 客户端、格式化
src/server/
  config.ts  crypto.ts  db.ts  errors.ts  logger.ts  events.ts  validation.ts  task-manager.ts
  provider/
    types.ts                    VideoProvider 契约
    index.ts                    单一 Viggle 实例（支持测试注入）
    viggle/                     signature / session / client / index
  services/                     accounts.ts  assets.ts  tasks.ts
src/app/api/                    Route Handler（全部强制 nodejs runtime）
src/components/                 工作台 UI 与全局状态（SSE）
src/app/globals.css             深色设计系统
legacy/web/                     旧项目完整归档（含 node_modules，已被忽略）
Viggle视频生成接口文档.md        上游接口规格来源
```

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 + 数据库连通性 |
| GET | `/api/me` | 当前激活账号、积分、Provider 信息 |
| GET / POST | `/api/accounts` | 账号列表 / 新增（自动校验 JWT） |
| PATCH / DELETE | `/api/accounts/:id` | 编辑（含更换 JWT）/ 删除 |
| POST | `/api/accounts/:id/activate` | 切换激活账号（事务保证唯一） |
| POST | `/api/accounts/:id/verify` | 重新校验 JWT 与积分 |
| POST | `/api/assets` | multipart 上传素材 |
| GET | `/api/assets/library` | 拉取账号的 Viggle 素材库（分页、只读） |
| POST | `/api/assets/library` | 把素材箱选中的素材登记到本地 |
| GET / POST | `/api/tasks` | 任务列表（可按账号过滤）/ 创建任务 |
| GET | `/api/tasks/:id` | 单任务 |
| DELETE | `/api/tasks/:id` | 删除本地记录，可选一并删除上游视频 |
| POST | `/api/tasks/:id/refresh` | 手动刷新状态 |
| POST | `/api/tasks/:id/resume` | 恢复被误判失败、但上游仍在生成的任务（不重复调用创建接口，不消耗额度） |
| GET | `/api/tasks/:id/download` | 流式下载（下载前重新解析最新地址，透传 Range） |
| GET | `/api/events` | SSE：快照 / 任务进度 / 账号同步 / 心跳 |

统一响应信封：`{ ok: true, data }` 或 `{ ok: false, error: { code, message, details } }`。

## 上游 Provider

`VideoProvider` 契约包含 `verify / upload / create / poll / deleteRemoteTask / listLibraryAssets / getVideoStream`。业务层只依赖契约，不感知 `t/u/s` 签名、multipart 或 httpcloak。实现只对接 Viggle 真实接口，细节全部收敛在 `src/server/provider/viggle/`：MD5 签名、每账号独立的 `httpcloak` 指纹会话、素材上传、三种生成模式（参考素材 / 首尾帧 / 纯文本）、状态轮询、上游删除与回查、流式下载。

Provider 实例跨 Next.js chunk 共享（`globalThis`），配置读取使用动态环境键，不会被构建期内联。

> 本地登录接口因 Turnstile sitekey 绑定域名而无法在 `127.0.0.1` 使用（原项目同样如此），因此采用「粘贴 JWT」方式。JWT 约 30 天有效且无刷新接口，失效后重新添加即可。

## 测试与验证

```bash
npm run typecheck    # tsc --noEmit
npm test             # 单元测试
npm run build        # 生产构建
```

单元测试覆盖：AES-GCM 加解密与篡改检测、JWT 规整、**用接口文档中的真实抓包样例回归签名算法**、GET/POST 签名载荷规则、参数白名单与免费档约束、multipart 构造、Provider 实例共享。

## 安全与合规

- JWT 只以 AES-256-GCM 密文落库，界面只显示脱敏串；生产环境强制校验 `CREDENTIALS_KEY`。
- `.gitignore` 覆盖 `.env`、`*.db`、`legacy/web/token.txt` 等；旧项目中的明文凭据与文档内的测试账号信息请勿外传。
- 服务默认监听本机；如需暴露到公网，建议设置 `ACCESS_PASSWORD` 并配置 HTTPS。
- 上游为第三方站点私有 Web API，依赖你自己的账号登录态。使用前请确认符合其服务条款，并自行承担接口变更、额度消耗与账号风险。
- 产物是有效期约 13 小时的预签名地址；本版本只持久化任务元数据，**不落盘视频**，过期后无法回放。

## 已知约束

- 后台轮询守护是**长驻 Node 进程内**的定时器，不适用于无状态 serverless 部署；本机 / 常驻服务部署没有问题。
- `httpcloak` 依赖 `koffi` 原生 FFI 二进制，因此所有相关 Route Handler 都强制 `runtime = "nodejs"`，并配置 `serverExternalPackages`；平台二进制仅覆盖官方支持的 5 个平台。
- 素材 URL 约 2 小时有效，仅用于短期预览；切换账号会清空当前未提交的草稿素材，避免跨账号混用。
