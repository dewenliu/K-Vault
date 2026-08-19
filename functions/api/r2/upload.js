/**
 * R2 文件上传 API
 * 将文件直接存储到 Cloudflare R2
 */

import { getFileType } from '../../utils/storage.js';
import { buildPublicFileId, buildPublicFileSrc } from '../../utils/public-id.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  
  // 检查 R2 是否可用
  if (!env.R2_BUCKET) {
    return new Response(JSON.stringify({
      error: 'R2 storage not configured'
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    
    if (!file) {
      return new Response(JSON.stringify({
        error: 'No file provided'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // 生成内部 R2 对象 key（随机，避免与原文件名同名覆盖；不会出现在分享链接中）
    const timestamp = Date.now();
    const randomStr = Math.random().toString(36).substring(2, 10);
    const ext = file.name.split('.').pop() || '';
    const fileExtension = ext.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
    const objectKey = `r2_${timestamp}_${randomStr}${ext ? '.' + fileExtension : ''}`;

    // 获取文件内容
    const content = await file.arrayBuffer();

    // 存储到 R2
    await env.R2_BUCKET.put(objectKey, content, {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream'
      },
      customMetadata: {
        fileName: file.name,
        fileSize: String(file.size),
        uploadTime: String(timestamp),
        fileType: getFileType(file.name)
      }
    });

    // 中性公开 ID（= 原文件名.后缀），不暴露任何存储后端信息
    const publicId = await buildPublicFileId({ env, fileName: file.name, fileExtension });

    // 同时在 KV 中存储元数据（用于管理和列表）
    if (env.img_url) {
      await env.img_url.put(publicId, '', {
        metadata: {
          fileName: file.name,
          fileSize: file.size,
          TimeStamp: timestamp,
          storageType: 'r2',
          r2Key: objectKey,
          contentType: file.type || 'application/octet-stream'
        }
      });
    }

    // 返回成功响应
    return new Response(JSON.stringify([{
      src: buildPublicFileSrc(publicId),
      storage: 'r2'
    }]), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('R2 upload error:', error);
    return new Response(JSON.stringify({
      error: error.message || 'Upload failed'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * 获取 R2 文件
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  
  if (!env.R2_BUCKET) {
    return new Response('R2 storage not configured', { status: 503 });
  }
  
  const url = new URL(request.url);
  const fileId = url.searchParams.get('id');
  
  if (!fileId) {
    return new Response('File ID required', { status: 400 });
  }
  
  try {
    // 优先通过 KV 元数据解析 R2 对象 key（新 schema），兼容直接传内部 key（旧 schema）
    let r2Key = fileId;
    if (env.img_url) {
      const prefixes = ['r2:', 'img:', 'vid:', 'aud:', 'doc:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', ''];
      const hasKnownPrefix = prefixes.some((prefix) => prefix && fileId.startsWith(prefix));
      const candidateKeys = hasKnownPrefix ? [fileId] : prefixes.map((prefix) => `${prefix}${fileId}`);
      for (const key of candidateKeys) {
        const record = await env.img_url.getWithMetadata(key);
        if (record?.metadata) {
          if (record.metadata.r2Key) {
            r2Key = record.metadata.r2Key;
          } else if (String(record.metadata.storageType || record.metadata.storage || '').toLowerCase() === 'r2') {
            r2Key = fileId;
          }
          break;
        }
      }
    }

    const object = await env.R2_BUCKET.get(r2Key);
    
    if (!object) {
      return new Response('File not found', { status: 404 });
    }
    
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
    headers.set('Content-Length', object.size);
    
    if (object.customMetadata?.fileName) {
      headers.set('Content-Disposition', `inline; filename="${object.customMetadata.fileName}"`);
    }
    
    // 缓存控制
    headers.set('Cache-Control', 'public, max-age=31536000');
    
    return new Response(object.body, { headers });
    
  } catch (error) {
    console.error('R2 get error:', error);
    return new Response('Error retrieving file', { status: 500 });
  }
}
