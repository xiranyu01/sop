#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const manifestPath = resolve(process.argv[2] ?? 'server/http/mutation-contract.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const failures = [];
const allowedMutationScopes = new Set(['resource', 'lifecycle', 'attachment']);
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const seenRoutes = new Set();
const routeOperations = new Set();

if (manifest.version !== 1 || !Array.isArray(manifest.routes) || !Array.isArray(manifest.repositoryMutations)) {
  failures.push('manifest must use mutation-contract version 1 with routes and repositoryMutations arrays');
} else {
  for (const route of manifest.routes) {
    const id = `${route.method} ${route.path}`;
    if (seenRoutes.has(id)) failures.push(`duplicate route: ${id}`);
    seenRoutes.add(id);
    if (!mutatingMethods.has(route.method)) continue;
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
  }
  for (const operation of routeOperations) {
    if (!seenOperations.has(operation)) failures.push(`${operation}: route mutation has no repository classification`);
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Mutation contract classifies ${seenRoutes.size} routes and ${manifest.repositoryMutations.length} repository mutations.`);

