#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const manifestPath = resolve(process.argv[2] ?? 'server/http/mutation-contract.json');
const handlerPath = resolve(process.argv[3] ?? 'server/http/resourceApi.ts');
const repositoryPath = resolve(process.argv[4] ?? 'server/domain/repository.ts');
const [manifestSource, handlerSource, repositorySource] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  readFile(handlerPath, 'utf8'),
  readFile(repositoryPath, 'utf8'),
]);
const manifest = JSON.parse(manifestSource);
const failures = [];
const allowedMutationScopes = new Set(['resource', 'lifecycle', 'attachment']);
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const seenRoutes = new Set();
const manifestMutationRoutes = new Set();
const routeOperations = new Set();
const manifestRepositoryMethods = new Set();

function matchingDelimiter(source, openIndex, open, close) {
  let depth = 1;
  let quote;
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index === -1) return -1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index === -1) return -1;
      index += 1;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function ifConditions(source) {
  const conditions = [];
  const pattern = /\bif\s*\(/g;
  let match;
  while ((match = pattern.exec(source))) {
    const open = source.indexOf('(', match.index);
    const close = matchingDelimiter(source, open, '(', ')');
    if (close === -1) {
      failures.push(`cannot parse handler if condition at offset ${match.index}`);
      break;
    }
    conditions.push({ source: source.slice(open + 1, close), start: open + 1, end: close });
    pattern.lastIndex = close + 1;
  }
  return conditions;
}

function negates(condition, name) {
  return new RegExp(`!\\s*${name}\\b`).test(condition);
}

function handlerRoutePath(condition) {
  const literalPath = /\bpathname\s*===\s*(['"])(\/[^'"]+)\1/.exec(condition)?.[2];
  if (literalPath) return literalPath;

  const action = /\baction\s*===\s*(['"])([^'"]+)\1/.exec(condition)?.[2];
  const attachmentCondition = /\b(?:uid|part)\b/.test(condition);
  if (attachmentCondition) {
    if (negates(condition, 'uid') && negates(condition, 'part') && negates(condition, 'action')) {
      return '/api/resources/:kind/:name/attachments';
    }
    if (!negates(condition, 'part') && negates(condition, 'action')) {
      return '/api/resources/:kind/:name/attachments/:uid/parts/:part';
    }
    if (action) return `/api/resources/:kind/:name/attachments/:uid/${action}`;
    if (negates(condition, 'part') && negates(condition, 'action')) {
      return '/api/resources/:kind/:name/attachments/:uid';
    }
    return undefined;
  }

  if (negates(condition, 'encodedName') && negates(condition, 'action')) return '/api/resources/:kind';
  if (action) return `/api/resources/:kind/:name/${action}`;
  if (negates(condition, 'action')) return '/api/resources/:kind/:name';
  return undefined;
}

function sourceMutationRoutes(source) {
  const routes = new Set();
  const conditions = ifConditions(source);
  for (const condition of conditions) {
    const methods = [...condition.source.matchAll(/\bmethod\s*===\s*(['"])(POST|PUT|PATCH|DELETE)\1/g)]
      .map((match) => match[2]);
    if (methods.length === 0) continue;
    const path = handlerRoutePath(condition.source);
    for (const method of methods) {
      if (path) routes.add(`${method} ${path}`);
      else failures.push(`unclassified handler mutation: ${method} ${condition.source.replace(/\s+/g, ' ').trim()}`);
    }
  }

  for (const match of source.matchAll(/\bmethod\s*===\s*(['"])(POST|PUT|PATCH|DELETE)\1/g)) {
    if (!conditions.some((condition) => match.index >= condition.start && match.index < condition.end)) {
      failures.push(`unclassified handler mutation expression: ${match[2]} at offset ${match.index}`);
    }
  }
  return routes;
}

function repositoryMethods(source) {
  const declaration = /\bexport\s+interface\s+ResourceRepository\s*\{/.exec(source);
  if (!declaration) {
    failures.push('cannot find ResourceRepository interface');
    return new Set();
  }
  const open = source.indexOf('{', declaration.index);
  const close = matchingDelimiter(source, open, '{', '}');
  if (close === -1) {
    failures.push('cannot parse ResourceRepository interface');
    return new Set();
  }
  const body = source.slice(open + 1, close);
  return new Set([...body.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\(/gm)].map((match) => match[1]));
}

if (manifest.version !== 1 || !Array.isArray(manifest.routes) || !Array.isArray(manifest.repositoryMutations)) {
  failures.push('manifest must use mutation-contract version 1 with routes and repositoryMutations arrays');
} else {
  for (const route of manifest.routes) {
    const id = `${route.method} ${route.path}`;
    if (seenRoutes.has(id)) failures.push(`duplicate route: ${id}`);
    seenRoutes.add(id);
    if (!mutatingMethods.has(route.method)) continue;
    manifestMutationRoutes.add(id);
    // POST may be explicitly classified as a protected query proposal.
    if (route.scope === 'protected-read') continue;
    if (!allowedMutationScopes.has(route.scope)) failures.push(`${id}: mutation scope must be resource, lifecycle, or attachment`);
    if (!route.resourceParam && route.createsOneResource !== true) {
      failures.push(`${id}: mutation must name one resource or create exactly one resource`);
    }
    if (!route.operation) failures.push(`${id}: mutation operation is required`);
    else routeOperations.add(route.operation);
  }

  const seenOperations = new Set();
  for (const mutation of manifest.repositoryMutations) {
    if (!mutation.operation) failures.push('repository mutation is missing operation');
    else if (seenOperations.has(mutation.operation)) failures.push(`duplicate repository mutation: ${mutation.operation}`);
    else seenOperations.add(mutation.operation);
    if (!allowedMutationScopes.has(mutation.scope)) failures.push(`${mutation.operation ?? '<unknown>'}: repository mutation is not resource-scoped`);
    if (!Array.isArray(mutation.repositoryMethods)) {
      failures.push(`${mutation.operation ?? '<unknown>'}: repositoryMethods must be an array`);
      continue;
    }
    for (const method of mutation.repositoryMethods) {
      if (typeof method !== 'string' || method.length === 0) {
        failures.push(`${mutation.operation ?? '<unknown>'}: repositoryMethods must contain method names`);
      } else {
        manifestRepositoryMethods.add(method);
      }
    }
  }
  for (const operation of routeOperations) {
    if (!seenOperations.has(operation)) failures.push(`${operation}: route mutation has no repository classification`);
  }
}

const actualMutationRoutes = sourceMutationRoutes(handlerSource);
for (const route of actualMutationRoutes) {
  if (!manifestMutationRoutes.has(route)) failures.push(`source mutation missing from manifest: ${route}`);
}
for (const route of manifestMutationRoutes) {
  if (!actualMutationRoutes.has(route)) failures.push(`manifest mutation missing from source: ${route}`);
}

// Reads and the operator-only bootstrap marker CAS are outside the business
// mutation manifest. Every other ResourceRepository method must be named by a
// repository mutation entry, so adding a method forces an explicit decision.
const repositoryMethodExceptions = new Set([
  'getCatalog',
  'getCatalogs',
  'listCatalog',
  'getCurrent',
  'listCurrent',
  'getRevision',
  'getRevisions',
  'listRevisions',
  'getExportBundle',
  'loadReviewedDependencies',
  'getMeta',
  'assertMeta',
  'auditProjectionParity',
  'compareAndSetMeta',
]);
const actualRepositoryMethods = repositoryMethods(repositorySource);
const actualRepositoryMutations = new Set(
  [...actualRepositoryMethods].filter((method) => !repositoryMethodExceptions.has(method)),
);
for (const method of actualRepositoryMutations) {
  if (!manifestRepositoryMethods.has(method)) failures.push(`unclassified repository method: ${method}`);
}
for (const method of manifestRepositoryMethods) {
  if (!actualRepositoryMutations.has(method)) failures.push(`manifest repository method missing from source: ${method}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(
  `Mutation contract classifies ${seenRoutes.size} routes, ${actualMutationRoutes.size} handler mutations, ` +
  `${manifestRepositoryMethods.size} repository methods, and ${manifest.repositoryMutations.length} repository mutations.`,
);
