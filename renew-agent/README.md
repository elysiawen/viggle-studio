# 续期助手（tool/）

客户机上的小工具：在网页点「续期」后，替你自动填好 viggle 的账号密码，
你只需要点一次「登录」并勾一次 `Verify you are human`，剩下的（抓 token、写回服务端、
自动校验）都由它完成。

> 为什么必须在客户机上跑：viggle.ai 的 Cloudflare 挑战在无图形界面的服务器上过不去，
> 而服务器（内网 Linux）只负责接收 token，不需要也不应该开浏览器。

## 文件

| 文件 | 作用 |
|---|---|
| `renew-agent.bat` | 双击启动（Windows） |
| `renew-agent.mjs` | 本地服务，监听 `127.0.0.1:3021`，接网页的「续期」请求 |
| `chrome-cdp.mjs` | 浏览器自动化：CDP 连接、启动 Chrome、填表、抓 `localStorage.viggleToken` |
| `renew-agent.json` | 本地配置（服务地址 + 访问密码），**已 gitignore，别外传** |
| `chrome-profile/` | 专用 Chrome 资料目录，保留登录态可减少验证码次数，已 gitignore |

依赖：Node.js 20+ 和本机已安装的 Chrome，**不需要 `npm install`**。

## 使用

1. 服务端部署新版后执行一次 `npm run db:push`（`Account` 表新增 `loginEmail` / `passwordCipher`），再重启服务。
2. 网页「账号管理 → 编辑账号」，填「续期登录邮箱」「续期登录密码」并保存。
3. 客户机双击 `tool/renew-agent.bat`，首次会让你填：
   - 服务地址，如 `http://192.168.50.100:3020`
   - 访问密码，即项目的 `ACCESS_PASSWORD`
4. 在网页上点账号卡片或编辑弹窗里的【续期】，然后：
   - Chrome 自动打开登录页并填好账号密码；
   - **你点「登录」+ 勾 Verify you are human**；
   - 助手抓到 token 后写回服务端，并自动校验一次，页面会自己刷新。

助手日志会显示当前处理的邮箱，例如：

```
账号：主账号 <xxx@artegin.com>
· [running] 正在填写 xxx@artegin.com 的账号密码…
· [done] xxx@artegin.com 续期成功，剩余 30 天，已校验（昵称）
```

## 改配置

- 直接改 `renew-agent.json`，或删掉它下次启动重新填。
- 也可以用参数：`node renew-agent.mjs --server http://ip:port --access-password ******`
- 换监听端口：`--port 3022`（注意网页端固定请求 `3021`）。

## 独立使用（不走网页）

只抓 token 并打印/落盘：

```bash
node chrome-cdp.mjs --account 邮箱 --password 密码
```

改完也可以用 `node chrome-cdp.mjs --self-test` 自检 CDP 链路。

## 注意

- `renew-agent.json` 和 `chrome-profile/` 都在 `.gitignore` 里，不要提交。
- token 等价于账号密码（30 天有效），`out/` 里的文件别外传。
- 每次续期都会清掉 viggle.ai 的 cookie，所以 Cloudflare 挑战会比“保持登录态”时多一点，属正常。
