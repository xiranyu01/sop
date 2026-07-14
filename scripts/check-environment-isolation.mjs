#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const source = `${await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8')}\n[__end__]\n`;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function table(header, binding) {
  const pattern = new RegExp(`^\\[\\[${escapeRegExp(header)}\\]\\]\\s*\\n([\\s\\S]*?)(?=^\\[)`, 'gmu');
  for (const match of source.matchAll(pattern)) {
    const body = match[1];
    if (stringValue(body, 'binding') === binding) return body;
  }
  throw new Error(`wrangler.toml is missing [[${header}]] binding ${binding}`);
}

function stringValue(body, key) {
  return new RegExp(`^${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*$`, 'mu').exec(body)?.[1];
}

const productionD1 = table('d1_databases', 'DB');
const previewD1 = table('env.preview.d1_databases', 'DB');
const productionR2 = table('r2_buckets', 'ATTACHMENTS');
const previewR2 = table('env.preview.r2_buckets', 'ATTACHMENTS');

const productionDatabaseName = stringValue(productionD1, 'database_name');
const previewDatabaseName = stringValue(previewD1, 'database_name');
const productionDatabaseId = stringValue(productionD1, 'database_id');
const previewDatabaseId = stringValue(previewD1, 'database_id');
const productionBucket = stringValue(productionR2, 'bucket_name');
const previewBucket = stringValue(previewR2, 'bucket_name');

const failures = [];
if (!productionDatabaseName || !previewDatabaseName || productionDatabaseName === previewDatabaseName) {
  failures.push('preview and production D1 database_name must both exist and differ');
}
if (productionDatabaseId && previewDatabaseId && productionDatabaseId === previewDatabaseId) {
  failures.push('preview and production D1 database_id must differ');
}
if (!productionBucket || !previewBucket || productionBucket === previewBucket) {
  failures.push('preview and production R2 bucket_name must both exist and differ');
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Environment isolation passed (${productionDatabaseName}/${previewDatabaseName}, ${productionBucket}/${previewBucket}).`);
}
