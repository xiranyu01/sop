import cors from 'cors';
import express from 'express';
import { handleApiRequest } from './api';
import { createFileStore } from './store';

const app = express();
const port = Number(process.env.PORT ?? 8787);
const fileStore = createFileStore({
  dataDir: process.env.SOP_DATA_DIR,
  uploadsDir: process.env.SOP_UPLOADS_DIR,
  exportsDir: process.env.SOP_EXPORTS_DIR,
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
  res.download(fileStore.localAttachmentPath(decodeURIComponent(req.params[0])));
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
