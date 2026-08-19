const path = require('node:path');
const crypto = require('node:crypto');

const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'text/plain': 'txt',
  'application/json': 'json',
};

function sanitizeExtension(ext, fallback = 'bin') {
  const normalized = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, 10);
}

function getExtension(fileName, mimeType, fallback = 'bin') {
  const parsed = path.extname(fileName || '').replace('.', '');
  if (parsed) return sanitizeExtension(parsed, fallback);

  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return sanitizeExtension(MIME_EXTENSION_MAP[normalizedMime] || fallback, fallback);
}

const RESERVED_ID_PREFIXES = ['tgs_'];
const MAX_BASE_LENGTH = 72;
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

function randomToken(length = 6) {
  const size = Math.max(1, Number(length) || 6);
  const bytes = crypto.randomBytes(size);
  let output = '';
  for (let i = 0; i < size; i += 1) {
    output += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  }
  return output;
}

function splitFileName(fileName) {
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

function sanitizePublicBaseName(rawName) {
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
    // URL / Markdown 不友好的半角字符
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

  return base;
}

/**
 * 生成不暴露存储来源的中性公开文件 ID（= 原文件名.后缀，同名追加 -1 -2 …）。
 * 存储类型不再出现在 ID 中，只存在于数据库 storage_type 字段。
 */
async function buildPublicFileId({ fileName, mimeType, isTaken } = {}) {
  const parsed = splitFileName(fileName);
  const extension = getExtension(fileName, mimeType);
  const base = sanitizePublicBaseName(parsed.base);
  const suffix = extension ? `.${extension}` : '';

  const taken = typeof isTaken === 'function' ? isTaken : async () => false;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    let candidate;
    if (attempt === 0) {
      candidate = `${base}${suffix}`;
    } else if (attempt <= 6) {
      candidate = `${base}-${attempt}${suffix}`;
    } else {
      candidate = `${base}-${randomToken(5)}${suffix}`;
    }
    // eslint-disable-next-line no-await-in-loop
    if (!(await taken(candidate))) return candidate;
  }

  return `${base}-${Date.now().toString(36)}-${randomToken(4)}.${extension}`;
}

/**
 * 生成存储后端的内部对象 key（随机、与公开 ID 解耦）。
 * 这样即使并发上传同名文件触发公开 ID 冲突，也无需重传字节。
 */
function buildInternalStorageKey({ fileName, mimeType } = {}) {
  const extension = getExtension(fileName, mimeType);
  return `${randomToken(16)}.${extension}`;
}

function normalizeStorageType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  const supported = [
    'telegram',
    'r2',
    's3',
    'discord',
    'huggingface',
    'webdav',
    'github',
  ];
  if (supported.includes(normalized)) return normalized;
  return 'telegram';
}

module.exports = {
  getExtension,
  buildPublicFileId,
  buildInternalStorageKey,
  sanitizePublicBaseName,
  splitFileName,
  randomToken,
  normalizeStorageType,
};
