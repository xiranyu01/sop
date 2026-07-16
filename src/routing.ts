export type AppPage = 'requirements' | 'scenes' | 'globalFields' | 'customers' | 'materials' | 'robots';

export type AppRoute = {
  page: AppPage;
  detail?: {
    kind: 'requirement' | 'taskSop';
    versionId: string;
  };
};

const pagePaths: Record<AppPage, string> = {
  requirements: '/requirements',
  scenes: '/scenes',
  customers: '/customers',
  materials: '/materials',
  robots: '/robot-models',
  globalFields: '/global-fields',
};

function segment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function pageRoutePath(page: AppPage): string {
  return pagePaths[page];
}

export function requirementRoutePath(versionId: string): string {
  return `/requirements/${encodeURIComponent(versionId)}`;
}

export function taskSopRoutePath(versionId: string): string {
  return `/task-sops/${encodeURIComponent(versionId)}`;
}

export function parseAppRoute(pathname: string): AppRoute | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (path === '/') return undefined;
  const requirement = /^\/requirements\/([^/]+)$/.exec(path);
  if (requirement) {
    const versionId = segment(requirement[1]);
    return versionId ? { page: 'requirements', detail: { kind: 'requirement', versionId } } : undefined;
  }
  const taskSop = /^\/task-sops\/([^/]+)$/.exec(path);
  if (taskSop) {
    const versionId = segment(taskSop[1]);
    return versionId ? { page: 'scenes', detail: { kind: 'taskSop', versionId } } : undefined;
  }
  const page = (Object.entries(pagePaths) as Array<[AppPage, string]>)
    .find(([, candidate]) => candidate === path)?.[0];
  return page ? { page } : undefined;
}
