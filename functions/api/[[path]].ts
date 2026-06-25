import { handleApiRequest } from '../../server/api';
import { createD1Store, type D1DatabaseLike } from '../../server/d1Store';

type Env = {
  DB: D1DatabaseLike;
  APP_PASSWORD?: string;
};

type PagesContext = {
  request: Request;
  env: Env;
};

export const onRequest = async (context: PagesContext): Promise<Response> => {
  let body: unknown;
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    const text = await context.request.text();
    body = text ? JSON.parse(text) : undefined;
  }

  const url = new URL(context.request.url);
  const result = await handleApiRequest(createD1Store(context.env.DB), {
    method: context.request.method,
    pathname: url.pathname,
    body,
    authorization: context.request.headers.get('authorization'),
    auth: {
      password: context.env.APP_PASSWORD,
      requireConfigured: true,
    },
  });

  return Response.json(result.body, { status: result.status });
};
