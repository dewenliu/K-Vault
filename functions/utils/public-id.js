/**
 * 统一公开文件 ID（分享链接 /file/ 后面的那一段）生成逻辑。
 *
 * 设计目标：
 * 1. 链接中绝对不出现任何存储后端信息（不再有 hf:/discord:/r2:/s3:/webdav:/github: 这类前缀，
 *    也不再有 hf_/discord_/wd_/github_ 这类随机 ID 前缀）。
 * 2. 所有存储方式共用同一种链接形态：/file/<原文件名>.<后缀>
 * 3. 存储类型只写进 KV metadata.storageType，由服务端内部路由，外部不可见。
 *
 * 链接命名模式（环境变量 PUBLIC_LINK_MODE，可选）：
 * - original（默认）  ：/file/照片.webp          同名时自动追加 -1 -2 …
 * - short / hashed    ：/file/照片-a3f9.webp     天然唯一，仍可读，推荐高并发场景
 * - random / opaque   ：/file/k7m2x9qd4h1b.webp  完全中性，不暴露原文件名
 */

// KV 中被系统占用的 key 前缀，公开 ID 不允许与之冲突。
const RESERVED_KEY_PREFIXES = [
  'session:',
  'upload:',
  'chunk:',
  'temp:',
  'folder:',
  'share_slug:',
  'token:',
  'img:',
  'vid:',
  'aud:',
  'doc:',
  'r2:',
  's3:',
  'discord:',
  'hf:',
  'webdav:',
  'github:',
];

// 会被路由特殊解析的 ID 前缀（签名版 Telegram 直链标记）。
const RESERVED_ID_PREFIXES = ['tgs_'];

const MAX_BASE_LENGTH = 72;
const MAX_SEQUENTIAL_ATTEMPTS = 6;
const MAX_TOTAL_ATTEMPTS = 24;

const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function randomToken(length = 6) {
  const size = Math.max(1, Number(length) || 6);
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let output = '';
  for (let i = 0; i < size; i += 1) {
    output += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return output;
}

export function sanitizePublicExtension(ext, fallback = 'bin') {
  const normalized = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, 10);
}

/**
 * 拆分文件名为 { base, ext }，会先剥掉任何目录成分。
 */
export function splitFileName(fileName) {
  const flat = String(fileName || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  const dotIndex = flat.lastIndexOf('.');
  if (dotIndex <= 0) {
    return { base: flat, ext: '' };
  }
  return {
    base: flat.slice(0, dotIndex),
    ext: flat.slice(dotIndex + 1),
  };
}

/**
 * 把原始文件名净化成可安全放进 URL 路径与 KV key 的基础名。
 * 保留中日韩等 Unicode 文字，仅剔除会破坏 URL / Markdown / KV key 的字符。
 */
export function sanitizePublicBaseName(rawName) {
  let base = String(rawName || '');

  try {
    base = base.normalize('NFC');
  } catch {
    // 忽略不支持 normalize 的运行时
  }

  base = base
    // 路径分隔符
    .replace(/[\\/]+/g, ' ')
    // 控制字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    // URL / Markdown / KV key 不友好的半角字符
    .replace(/[:*?"'`<>|#%&+=;,@$^~{}[\]()!]/g, '')
    // 对应的全角与中文标点
    .replace(/[！＂＃＄％＆＇（）＊＋，／：；＜＝＞？＠［＼］＾｀｛｜｝～、。「」『』【】〈〉《》〔〕〖〗]/g, '')
    // 空白（含全角空格）折叠为连字符
    .replace(/[\s\u3000]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+/, '')
    .replace(/[-._]+$/, '');

  const codePoints = Array.from(base);
  if (codePoints.length > MAX_BASE_LENGTH) {
    base = codePoints.slice(0, MAX_BASE_LENGTH).join('').replace(/[-._]+$/, '');
  }

  if (!base) {
    base = `file-${randomToken(6)}`;
  }

  const lower = base.toLowerCase();
  if (RESERVED_ID_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    base = `f-${base}`;
  }
  if (RESERVED_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix.replace(':', '')))) {
    // 仅当整体就是保留词时才需要规避，普通同名前缀（如 imgxxx.png）不受影响
    if (RESERVED_KEY_PREFIXES.some((prefix) => `${lower}:` === prefix)) {
      base = `f-${base}`;
    }
  }

  return base;
}

export function resolvePublicLinkMode(env) {
  const raw = String(env?.PUBLIC_LINK_MODE || env?.FILE_LINK_MODE || '')
    .trim()
    .toLowerCase();
  if (['random', 'opaque', 'uuid', 'anonymous'].includes(raw)) return 'random';
  if (['short', 'hashed', 'hash', 'original-short', 'unique'].includes(raw)) return 'short';
  return 'original';
}

function buildPublicIdVariant(base, ext, attempt, mode) {
  const suffix = ext ? `.${ext}` : '';
  if (mode === 'short') {
    return `${base}-${randomToken(4)}${suffix}`;
  }
  if (attempt === 0) return `${base}${suffix}`;
  if (attempt <= MAX_SEQUENTIAL_ATTEMPTS) return `${base}-${attempt}${suffix}`;
  return `${base}-${randomToken(5)}${suffix}`;
}

/**
 * 判断某个公开 ID 是否已被 KV 占用。
 */
export async function isPublicIdTaken(env, candidate) {
  if (!env?.img_url || !candidate) return false;
  try {
    const record = await env.img_url.getWithMetadata(candidate);
    if (!record) return false;
    return record.metadata != null || record.value != null;
  } catch {
    return false;
  }
}

/**
 * 生成不暴露存储来源的公开文件 ID。
 *
 * @param {object} options
 * @param {object} options.env            Pages 运行时环境（用于 KV 查重与读取命名模式）
 * @param {string} options.fileName       原始文件名（含后缀）
 * @param {string} [options.fileExtension] 已解析出的后缀，缺省时从 fileName 推断
 * @param {(candidate: string) => Promise<boolean>|boolean} [options.isTaken] 自定义查重
 * @returns {Promise<string>} 形如 `照片.webp`
 */
export async function buildPublicFileId({ env, fileName, fileExtension, isTaken } = {}) {
  const parsed = splitFileName(fileName);
  const ext = sanitizePublicExtension(fileExtension || parsed.ext, 'bin');
  const mode = resolvePublicLinkMode(env);

  const base = mode === 'random'
    ? randomToken(12)
    : sanitizePublicBaseName(parsed.base);

  const taken = typeof isTaken === 'function'
    ? isTaken
    : (candidate) => isPublicIdTaken(env, candidate);

  for (let attempt = 0; attempt < MAX_TOTAL_ATTEMPTS; attempt += 1) {
    const candidate = buildPublicIdVariant(base, ext, attempt, mode);
    // eslint-disable-next-line no-await-in-loop
    const conflict = await taken(candidate);
    if (!conflict) return candidate;
  }

  return `${base}-${Date.now().toString(36)}-${randomToken(4)}.${ext}`;
}

/**
 * 组装返回给前端的相对直链，统一做百分号编码，保证中文名等场景可直接复制使用。
 */
export function buildPublicFileSrc(publicId) {
  return `/file/${encodeURIComponent(String(publicId || ''))}`;
}
