# K-Vault 图床项目安全审计报告

- **审计对象**：`D:\Desktop\K-Vault`（K-Vault 图床，含 Cloudflare Pages Functions 与 Docker 自托管 Node 服务两套代码路径）
- **审计方式**：静态代码审查（人工 + 模式扫描），覆盖 `functions/`、`server/`、前端页面与存储适配器
- **审计结论**：**未发现恶意后门**（无 `eval`/`exec`/`child_process`/反弹 Shell/隐藏管理员账号/硬编码 C2 等）。代码包含参数化 SQL、HMAC 签名、随机会话令牌、`HttpOnly`/`SameSite` Cookie 等合理安全实践。但存在 **2 个高危安全缺陷**与若干中/低危加固问题，主要集中在「上传无类型限制 + 文件代理 inline 渲染」与「URL 抓取接口缺鉴权与 SSRF 防护」。

---

## 一、风险总览

| 编号 | 严重度 | 问题 | 位置 |
| :--- | :--- | :--- | :--- |
| H-1 | 🔴 高危 | 任意文件类型上传 + `/file/` 代理 inline 渲染 → 存储型 XSS | `functions/upload.js`、`functions/api/v1/upload.js`、`functions/file/[id].js`、`server/app.js`、`server/lib/services/upload-service.js` |
| H-2 | 🔴 高危 | `/api/upload-from-url` 公开可达且无限目标校验 → SSRF | `functions/api/upload-from-url.js`、`server/app.js:1909`、`server/lib/services/upload-service.js:75` |
| M-1 | ✅ 已修复 | 第三方遥测数据外发（已改为默认关闭 / opt-in，并移除 admin 页面 Sentry 脚本） | `functions/utils/middleware.js`、`admin.html`、`admin-imgtc.html` |
| M-2 | 🟠 中危 | CORS 对任意来源回显且 `credentials:true` | `server/app.js:32` |
| M-3 | 🟠 中危 | 会话 Cookie 缺少 `Secure` 标志 | `functions/utils/auth.js:119`、`server/lib/utils/auth.js:93` |
| M-4 | 🟠 中危 | 未配置账号时完全免认证（管理/上传/删除全开） | `functions/utils/auth.js:136`、`server/lib/utils/auth.js:26` |
| L-1 | 🟡 低危 | Telegram 签名默认回退硬编码密钥 | `functions/utils/telegram.js:334` |
| L-2 | 🟡 低危 | 登录无速率限制/暴力破解防护 | `functions/api/auth/login.js:41` |
| L-3 | 🟡 低危 | 访客限速信任伪造 IP 头 | `functions/utils/guest.js:9` |
| L-4 | 🟡 低危 | `findByShareSlug` 全表扫描 | `server/lib/repos/file-repo.js:194` |
| L-5 | 🟡 低危 | 前端 `innerHTML` 渲染点需统一转义审计 | 各 `*.html` |

---

## 二、高危问题详述

### H-1 存储型 XSS（任意文件上传 + inline 渲染）

**成因**

1. 上传接口**不限制文件类型/扩展名**。以 `functions/upload.js` 为例，`normalizeFileExtension()` 仅清洗扩展名字符，不校验是否属于白名单；`validateDirectUpload()` 只检查体积。Cloudflare 与 Docker 两套 `uploadFile` 均直接采用客户端传入的 `fileName` / `file.type` 作为存储元数据。
2. 文件访问代理 `/file/[id]`（Cloudflare 侧 `functions/file/[id].js` 的 `addResponseHeaders`，Docker 侧 `server/app.js` 的 `buildFileProxyHeaders`）以 `Content-Disposition: inline` 返回，且 `Content-Type` 直接取自文件名扩展名或上传时声明的 `mime_type`（用户可控）：
   - Cloudflare：`addResponseHeaders` → `getMimeType(fileName)` 按扩展名映射，且**未设置 `X-Content-Type-Options: nosniff`**。
   - Docker：`buildFileProxyHeaders` → `result.file.mime_type`（即上传时 `file.type`，客户端可伪造）。

**影响**

攻击者可上传 `evil.html` / `evil.svg` / `evil.js`（如 SVG 内嵌 `<script>`），通过 `/file/<id>` 或 `/s/<slug>` 分享链接在**图床同源域名下被浏览器内联执行任意 JavaScript**，进而：
- 窃取前端 `localStorage` 中保存的 API Token；
- 以受害者登录态发起管理操作（CSRF）；
- 读取非 `HttpOnly` 的 Cookie / 页面内容。

由于分享链接公开可达，该 XSS 对任意访问者触发，不依赖管理员登录。

**修复建议**
- 上传层增加 **MIME / 扩展名白名单**，拒绝 `html/js/svg` 等可执行类型（或将其存入不可执行存储、强制 `attachment` 下载）。
- 文件代理层：对 `html/svg/js` 等类型强制 `Content-Disposition: attachment`；统一加 `X-Content-Type-Options: nosniff`；必要时对返回的 `Content-Type` 做二次校验（不复用客户端声明值）。
- 对确需预览的 SVG 做内容净化（移除 `<script>`/事件属性）后再输出。

---

### H-2 SSRF：`/api/upload-from-url` 公开且无限目标校验

**成因**

- Cloudflare 侧 `functions/api/upload-from-url.js` 的父级 middleware（`functions/api/_middleware.js`）仅做 `errorHandling + telemetryData`，**无任何认证**；该接口自身也未调用 `checkAuthentication()`，因此**对所有访客公开**。
- Docker 侧 `server/app.js:1909` `/api/upload-from-url` 仅在「未配置认证」或「访客上传开启」时可达，同样无强制鉴权。
- 两个实现都只校验 `http:/https:` 协议（`functions/api/upload-from-url.js:37`、`upload-service.js:83`），**未拦截内网/链路本地地址**（如 `http://169.254.169.254/`、`http://localhost`、`http://10.x`、`http://[fd00::]` 等），且 `fetch` 后把整个响应读入内存（最大 100MB / 20MB）。

**影响**

- 作为 SSRF 跳板：探测内网、访问云元数据服务、攻击同网段服务。
- 拒绝服务：远程返回超大响应可耗尽内存；虽有时长上限但缺乏响应大小流式限制。
- 端口扫描 / 盲 SSRF（基于响应差异或超时）。

**修复建议**
- 要求认证（`requireAuth` / `checkAuthentication`）。
- SSRF 防护：解析目标域名并校验解析后的 IP 是否属于私有/链路本地/回环范围，拒绝；考虑 DNS rebinding 防护（先解析、再连接、校验一致性）；限制可访问端口与响应上限。

---

## 三、中危问题

### M-1 默认开启的第三方遥测（数据外发 / 隐私合规）

`functions/utils/middleware.js` 中 `errorHandling` 在 `disable_telemetry` 未设置时**默认启用**：
- 向硬编码 Sentry DSN `https://219f636ac7bde5edab2c3e16885cb535@o4507041519108096.ingest.us.sentry.io/4507541492727808` 上报；
- `telemetryData` 将**全部请求头、客户端 IP（request.cf）、URL、方法**写入 Sentry tag/context；
- `fetchSampleRate` 向 `https://frozen-sentinel.pages.dev/signal/sampleRate.json` 拉取采样率（外部可控）。

部署者可能在不知情下泄露访客数据。建议**默认关闭遥测（opt-in）**，至少在文档显著位置提示并提供默认关闭开关；若保留，需明确告知数据接收方与字段范围。

**修复记录（2026-08-19）**：
- `functions/utils/middleware.js`：遥测改为**默认关闭**，仅当环境变量 `enable_telemetry` 为真值时才启用（opt-in）；新增统一开关 `telemetryEnabled(env)`，并修复 `telemetryData` 在 `transaction` 未赋值即 `finally` 调用 `.finish()` 的潜在报错。
- `admin.html`、`admin-imgtc.html`：移除浏览器端 Sentry 脚本 `<script src="https://js.sentry-cdn.com/219f636ac7bde5edab2c3e16885cb535.min.js">`。
- `README.md`、`README-EN.md`：环境变量说明由 `disable_telemetry` 更新为 `enable_telemetry`（默认关闭）。

### M-2 CORS 过宽（Docker）

`server/app.js:32`：
```js
app.use('*', cors({ origin: (origin) => origin || '*', allowMethods: [...], credentials: true }));
```
对任意 `Origin` 回显 `Access-Control-Allow-Origin` 且允许凭证。实际 CSRF 风险被会话 Cookie 的 `SameSite=Strict`（跨站不发送 Cookie）抵消，但仍是危险配置，且对 API Token 模式及后续功能改动存在隐患。建议将 `origin` 限定为受信域名白名单，非必要时不启用 `credentials: true`。

### M-3 会话 Cookie 缺少 `Secure`

`functions/utils/auth.js:119` 与 `server/lib/utils/auth.js:93` 的会话 Cookie 仅含 `HttpOnly; SameSite=Strict`，**无 `Secure`**。若以明文 HTTP 部署（内网直连 Docker、反向代理未强制 HTTPS），Cookie 可被中间人窃取。建议在 HTTPS 部署前提下补上 `Secure`（可按请求协议动态判断）。

### M-4 未配置账号时完全免认证

`isAuthRequired()` 依赖 `BASIC_USER && BASIC_PASS` 同时设置。若未设置（或只设其一）：登录接口直接放行，`/api/manage/*`、Docker `/api/admin/*`、`/api/storage/*`、`/api/settings` 等全部免认证，任何人可读写文件、配置存储后端。这是 README 声明的设计，但极易因「忘记设密码」导致完全开放。建议：未配置认证时**拒绝**管理/写入/删除操作（仅保留只读浏览），或首次启动生成随机强密码并提示修改。

---

## 四、低危与加固项

- **L-1**：`functions/utils/telegram.js:334` 中 `getFileLinkSecrets` 在未配置 `FILE_URL_SECRET` 时回退硬编码 `"k-vault-default-secret"` / `"tgbed-default-secret"`，签名可被知晓默认密钥者伪造（仍需合法 file_id）。建议强制要求密钥，或默认禁用签名直链。
- **L-2**：登录比较为普通 `===`，无失败锁定、验证码、速率限制（代码层）。
- **L-3**：`functions/utils/guest.js:9` `getClientIP` 信任 `X-Forwarded-For` 等客户端可控头，访客每日限额可被伪造 IP 绕过。
- **L-4**：`server/lib/repos/file-repo.js:194` `findByShareSlug` 对全表 `ORDER BY created_at DESC` 后在 JS 遍历匹配，数据量大时存在性能/DoS 风险，应加索引查询。
- **L-5**：前端已抽查 `admin-waterfall.html`、`preview.html` 的 `innerHTML` 使用了 `escapeHtml` 与安全 `template` 解析（不会执行脚本），整体较克制；但建议对全部使用 `innerHTML` 渲染文件名/分享信息的位置做统一转义审计，防止遗漏。

---

## 五、修复优先级建议

1. **立即修复（高危）**：H-1 上传类型白名单 + 文件代理 `attachment`/`nosniff`；H-2 为 `upload-from-url` 增加鉴权与 SSRF 防护。
2. **尽快修复（中危）**：M-4 安全默认值（未配置认证时禁止写操作）；M-1 关闭默认遥测；M-3 补 `Secure`；M-2 CORS 白名单。
3. **择机加固（低危）**：L-1~L-5。

---

## 六、审计范围与方法说明

- 审阅文件：`functions/**`（56 个 JS）、`server/**`（31 个 JS）、`*.html` 前端页面、存储适配器（S3/WebDAV/Discord/GitHub/HuggingFace/Telegram）。
- 扫描模式：`child_process|eval|new Function|动态 require`、`硬编码凭据`、`setTimeout/setInterval(字符串)`、路径穿越、外联 `fetch`、SQL 字符串拼接、XSS 渲染点。
- 未发现：`eval`/命令执行、反弹 Shell、隐藏管理员账号、硬编码后门凭证、SQL 注入（Docker 侧 `db` 封装与 `file-repo` 均为参数化查询）。

> 说明：本报告基于静态分析，未做动态渗透测试；部分中/低危项的实际可利用性取决于具体部署方式（HTTPS、是否配置认证、网络拓扑等）。
