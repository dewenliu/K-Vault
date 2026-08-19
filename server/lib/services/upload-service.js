const { buildPublicFileId, buildInternalStorageKey, normalizeStorageType } = require('../storage/common');
const { normalizeFolderPath } = require('../repos/file-repo');

class UploadService {
  constructor({ storageRepo, fileRepo, storageFactory }) {
    this.storageRepo = storageRepo;
    this.fileRepo = fileRepo;
    this.storageFactory = storageFactory;
  }

  resolveStorage({ storageId, storageMode }) {
    const storageConfig = this.storageRepo.resolveStorageSelection({ storageId, storageMode });
    if (!storageConfig) {
      throw new Error('没有可用的存储配置。');
    }
    return storageConfig;
  }

  async uploadFile({
    fileName,
    mimeType,
    fileSize,
    buffer,
    storageId,
    storageMode,
    folderPath,
  }) {
    const storageConfig = this.resolveStorage({ storageId, storageMode });
    const adapter = this.storageFactory.createAdapter(storageConfig);
    const storageType = normalizeStorageType(storageConfig.type);
    const normalizedFolderPath = normalizeFolderPath(folderPath);

    const isIdTaken = (candidate) => Boolean(this.fileRepo.getById(candidate));
    const publicId = await buildPublicFileId({ fileName, mimeType, isTaken: isIdTaken });
    const internalStorageKey = buildInternalStorageKey({ fileName, mimeType });

    let adapterStorageKey = normalizedFolderPath
      ? `${normalizedFolderPath}/${internalStorageKey}`
      : internalStorageKey;
    if (storageType === 'huggingface') {
      adapterStorageKey = normalizedFolderPath
        ? `uploads/${normalizedFolderPath}/${internalStorageKey}`
        : `uploads/${internalStorageKey}`;
    }

    const uploadResult = await adapter.upload({
      storageKey: adapterStorageKey,
      fileName,
      mimeType,
      fileSize,
      buffer,
    });

    const storageKey = uploadResult.storageKey || adapterStorageKey;

    let fileRecord;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        fileRecord = this.fileRepo.create({
          id: publicId,
          storageConfigId: storageConfig.id,
          storageType,
          storageKey,
          fileName,
          fileSize,
          mimeType,
          folderPath: normalizedFolderPath,
          extra: uploadResult.metadata || {},
        });
        break;
      } catch (error) {
        // 极小概率并发同名冲突：公开 ID 已占用则换名重试（存储 key 与公开 ID 解耦，无需重传字节）
        if (attempt >= 2 || !isUniqueConstraintError(error)) throw error;
        publicId = await buildPublicFileId({ fileName, mimeType, isTaken: isIdTaken });
      }
    }

    return {
      file: fileRecord,
      src: `/file/${encodeURIComponent(publicId)}`,
      storage: {
        id: storageConfig.id,
        name: storageConfig.name,
        type: storageType,
      },
    };
  }

  async uploadFromUrl({
    url,
    storageId,
    storageMode,
    folderPath,
    maxBytes = 20 * 1024 * 1024,
  }) {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('仅支持 HTTP/HTTPS URL。');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;

    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'K-Vault/2.0 (+https://github.com/katelya77/K-Vault)',
          Accept: '*/*',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`目标 URL 响应异常：${response.status}。`);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error('目标 URL 返回了空文件。');
    }

    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`远程文件超过大小限制（${Math.floor(maxBytes / 1024 / 1024)}MB）。`);
    }

    let fileName = decodeURIComponent(parsedUrl.pathname.split('/').pop() || '').trim();
    if (!fileName) {
      fileName = `url_${Date.now()}`;
    }

    if (!fileName.includes('.')) {
      const ext = String(contentType).split('/')[1]?.split(';')[0] || 'bin';
      fileName = `${fileName}.${ext}`;
    }

    return this.uploadFile({
      fileName,
      mimeType: contentType,
      fileSize: arrayBuffer.byteLength,
      buffer: arrayBuffer,
      storageId,
      storageMode,
      folderPath,
    });
  }

  async getFileResponse(fileId, rangeHeader) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return null;

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (!storageConfig) {
      throw new Error('文件引用的存储配置不存在。');
    }

    const adapter = this.storageFactory.createAdapter(storageConfig);
    const response = await adapter.download({
      storageKey: file.storage_key,
      metadata: file.metadata,
      range: rangeHeader,
    });

    if (!response) return null;

    return {
      file,
      response,
    };
  }

  async deleteFile(fileId) {
    const file = this.fileRepo.getById(fileId);
    if (!file) return { deleted: false, reason: 'not-found' };

    const storageConfig = this.storageRepo.getById(file.storage_config_id, true);
    if (storageConfig) {
      const adapter = this.storageFactory.createAdapter(storageConfig);
      try {
        await adapter.delete({ storageKey: file.storage_key, metadata: file.metadata });
      } catch (error) {
        // best-effort cleanup on remote storage
      }
    }

    this.fileRepo.delete(fileId);
    return { deleted: true };
  }
}

function isUniqueConstraintError(error) {
  const text = String((error && (error.message || error.code)) || '').toLowerCase();
  return text.includes('unique constraint') || text.includes('sqlite_constraint') || text.includes('primary key');
}

module.exports = {
  UploadService,
};
