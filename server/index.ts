import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { handleApiRequest } from './api';
import { createCanonicalApiStore } from './domain/services/runtime';
import { bootstrapValidatedFileGeneration } from './migrations/fileRuntimeBootstrap';
import { createCanonicalFileAppStore, createFileStore } from './store';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(process.env.SOP_DATA_DIR ?? path.join(process.cwd(), 'data'));
const uploadsDir = path.resolve(process.env.SOP_UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'));
const canonicalRoot = path.resolve(process.env.SOP_CANONICAL_DIR ?? path.join(dataDir, 'canonical'));
const legacyFileStore = createFileStore({
  dataDir,
  uploadsDir,
  exportsDir: process.env.SOP_EXPORTS_DIR,
});
const runtimeGeneration = await bootstrapValidatedFileGeneration({ canonicalRoot, legacyDir: dataDir, attachmentRoot: uploadsDir });
const canonicalStore = createCanonicalFileAppStore({
  rootDir: canonicalRoot,
  bootstrap: { namespace: runtimeGeneration.generationId, snapshot: runtimeGeneration.snapshot },
});
const fileStore = createCanonicalApiStore(canonicalStore, {
  namespace: runtimeGeneration.generationId,
  attachments: legacyFileStore,
  writeExport: legacyFileStore.writeExport.bind(legacyFileStore),
});

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

app.use(cors());
app.use('/api/materials/:materialId/images/:uploadId/parts/:partNumber', express.raw({ limit: '24mb', type: '*/*' }));
app.use('/api/requirements/:requirementId/versions/:version/attachments/:uploadId/parts/:partNumber', express.raw({ limit: '24mb', type: '*/*' }));
app.use(
  '/api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version/attachments/:uploadId/parts/:partNumber',
  express.raw({ limit: '24mb', type: '*/*' }),
);
app.use(express.json({ limit: '4mb' }));

app.get('/api/storage-status', (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (password && req.header('authorization') !== `Bearer ${password}`) {
    res.status(401).json({ message: '访问密码无效或已过期' });
    return;
  }
  res.json({ attachments: { enabled: true, message: '', publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '' } });
});

app.get(/^\/api\/attachments\/(.+)$/, (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (password && req.header('authorization') !== `Bearer ${password}`) {
    res.status(401).json({ message: '访问密码无效或已过期' });
    return;
  }
  res.download(legacyFileStore.localAttachmentPath(decodeURIComponent(req.params[0])));
});

app.all('/api/*', async (req, res) => {
  const result = await handleApiRequest(fileStore, {
    method: req.method,
    pathname: req.path,
    search: req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '',
    body: Buffer.isBuffer(req.body) ? undefined : req.body,
    rawBody: Buffer.isBuffer(req.body) ? bufferToArrayBuffer(req.body) : undefined,
    authorization: req.header('authorization'),
    attachmentPublicBaseUrl: process.env.R2_PUBLIC_BASE_URL,
    auth: {
      password: process.env.APP_PASSWORD,
      requireConfigured: false,
    },
  });
  if (result.status === 302 && result.headers?.Location) {
    res.redirect(result.headers.Location);
    return;
  }
  res.status(result.status).json(result.body);
});

app.listen(port, '127.0.0.1', () => {
  console.log(`SOP requirement manager API listening on http://127.0.0.1:${port}`);
});
