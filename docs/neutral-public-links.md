# 分享链接不再暴露存储来源（Neutral Public Links）

## 背景问题

改造前，K-Vault 会把"存储后端标识"写进分享链接（即 KV key / 文件 ID），导致来源泄露：

- HuggingFace：`https://域名/file/hf:hf_1787070238817_8wvnxv.webp`（`hf:hf` 暴露来源）
- Discord：`https://域名/file/discord:discord_1787070028324_zamr8l.webp`（`discord:discord` 暴露来源）
- 同理 r2 / s3 / webdav / github 也存在 `r2:` / `s3:` / `webdav:` / `github:` 前缀泄露

## 目标

所有存储方式（telegram / r2 / s3 / discord / huggingface / webdav / github）的分享链接统一为：

```
https://域名/file/<原文件名>.<后缀>
```

存储后端信息只保存在 KV metadata（`storageType`）或数据库 `storage_type` 字段中，由服务端内部路由，外部不可见。

## 改动内容

### Cloudflare Pages（functions/）

1. **新增 `functions/utils/public-id.js`** —— 统一公开 ID 生成模块：
   - `buildPublicFileId()`：按原文件名生成中性 ID，自动处理重名（同名追加 `-1 -2 …`，超过 6 次改用随机短码）。
   - `sanitizePublicBaseName()` / `splitFileName()` / `sanitizePublicExtension()`：净化文件名（保留中日韩文字，剔除 URL / Markdown / KV key 不友好字符）。
   - `isPublicIdTaken()`：上传前查 KV 防止与已有 key 冲突。
   - `buildPublicFileSrc()`：组装 `/file/<encoded id>` 直链。
   - `resolvePublicLinkMode()`：读取可选环境变量 `PUBLIC_LINK_MODE`。

2. **所有上传入口去掉存储前缀**（KV key = 公开 ID = 原文件名.后缀，存储实际 key 只写入 metadata），**包括 Telegram 分支**：
   - `functions/upload.js`（普通上传，7 种存储）
   - `functions/api/upload-from-url.js`（URL 上传，7 种存储）
   - `functions/api/chunked-upload/complete.js`（分片上传完成）
   - `functions/api/r2/upload.js`（独立 R2 上传 API）
   - `functions/api/telegram/webhook.js`（Telegram Webhook 回链，Cloudflare 侧）
   - `server/app.js` 的 Telegram Webhook 回链（Docker 侧）

   > Telegram 分支此前直接以 file_id 作为公开 ID（链接形如 `/file/BQACAgU…png`，`BQAC` 前缀是 Telegram file_id 指纹）。现统一为原文件名，file_id 只存 `metadata.telegramFileId`；签名直链模式（`tgs_` 前缀）保持不变。

3. **读取/管理链路保持兼容**（无需改数据即可继续访问旧链接）：
   - `functions/file/[id].js`：候选 key 探测（精确 key 优先，兼容 `img:` / `vid:` / `hf:` 等旧前缀）；Telegram 改为从 `metadata.telegramFileId` 读取，不再靠拆分 key 猜。
   - `api/v1/upload.js`、`api/file-info/[id].js`、`api/manage/delete/[id].js`、`api/manage/editName/[id].js`、`api/manage/folders.js`、`api/manage/files/move-folder.js` 均为"精确 key + 候选前缀探测"，天然兼容中性 key。

### Docker / Node 后端（server/）

- `server/lib/storage/common.js`：`buildPublicFileId()` 重写为"原文件名"方案，不再生成 `huggingface_xxx.png` 这类 ID；新增 `buildInternalStorageKey()`（存储对象 key 与公开 ID 解耦）。
- `server/lib/services/upload-service.js`：公开 ID = 原文件名（SQLite 唯一性校验，同名自动 `-1 -2`）；存储 key 改为内部随机 key，并发同名冲突时仅换公开 ID 重试，无需重传字节。

## 新链接示例

| 存储方式 | 改造前 | 改造后 |
| --- | --- | --- |
| HuggingFace | `/file/hf:hf_1787070238817_8wvnxv.webp` | `/file/照片.webp` |
| Discord | `/file/discord:discord_1787070028324_zamr8l.webp` | `/file/照片.webp` |
| R2 / S3 / WebDAV / GitHub | `/file/r2:...` 等带前缀 | `/file/照片.webp` |
| Telegram | `/file/BQACAgUAAyEG…png`（file_id，带指纹） | `/file/照片.webp`（file_id 只在 metadata） |

## 重名策略

- 默认（`original`）：`照片.webp` → `照片-1.webp` → `照片-2.webp` …
- `PUBLIC_LINK_MODE=short`：`照片-8f2a.webp`（原文件名 + 4 位短码，天然唯一）
- `PUBLIC_LINK_MODE=random`：`k7m2x9qd4h1b.webp`（完全中性，不暴露原文件名）

## 旧链接兼容性

旧链接（带前缀，如 `/file/hf:...`、`/file/discord:...`、`/file/r2:...`）仍可访问：
读取/管理路由通过"精确 key 优先 + 候选前缀探测"回退解析，无需迁移既有数据。

## 部署说明

- Cloudflare Pages：重新部署即生效，无需迁移 KV 数据。
- Docker：重启容器即生效；旧记录仍在 SQLite 中，按原 ID 可继续访问。
- 可选：如需隐藏原文件名，设置环境变量 `PUBLIC_LINK_MODE=random`（或 `short`）。
