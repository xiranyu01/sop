import cors from 'cors';
import express from 'express';
import { handleApiRequest } from './api';
import { fileStore } from './store';

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: '4mb' }));

app.all('/api/*', async (req, res) => {
  const result = await handleApiRequest(fileStore, {
    method: req.method,
    pathname: req.path,
    body: req.body,
    authorization: req.header('authorization'),
    auth: {
      password: process.env.APP_PASSWORD,
      requireConfigured: false,
    },
  });
  res.status(result.status).json(result.body);
});

app.listen(port, '127.0.0.1', () => {
  console.log(`SOP requirement manager API listening on http://127.0.0.1:${port}`);
});
