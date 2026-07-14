import { apiError, type ApiErrorBody } from '../../shared/transport/errors';

export type AuthResult =
  | { ok: true; publicRoute: boolean }
  | { ok: false; status: 401 | 503; body: ApiErrorBody };

export function isPublicApiRoute(method: string, pathname: string): boolean {
  return (method.toUpperCase() === 'GET' || method.toUpperCase() === 'HEAD') && pathname.replace(/\/$/, '') === '/api/health';
}

/** Must be called before reading request bodies or touching D1/R2 bindings. */
export function authorizeApiRequest(request: Pick<Request, 'method' | 'url' | 'headers'>, appPassword?: string): AuthResult {
  const pathname = new URL(request.url).pathname;
  if (isPublicApiRoute(request.method, pathname)) return { ok: true, publicRoute: true };
  if (!appPassword) {
    return { ok: false, status: 503, body: apiError('STORAGE_UNAVAILABLE', '服务端访问凭据未配置') };
  }
  if (request.headers.get('authorization') !== `Bearer ${appPassword}`) {
    return { ok: false, status: 401, body: apiError('UNAUTHORIZED', '访问密码无效或已过期') };
  }
  return { ok: true, publicRoute: false };
}

