import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { inject } from 'vitest'
import type { PlatformDatabaseConnection } from '../../src/domain/platform-database.js'
import type { PostgresFixtureInfo } from './postgres-runtime.js'

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: PostgresFixtureInfo
  }
}

const created: string[] = []
const CONTROL_TIMEOUT_MS = 60_000
const RESPONSE_BUFFER_BYTES = 16 * 1024

const controlWorkerScript = `
const { createRequire } = require('node:module');
const { parentPort, workerData } = require('node:worker_threads');

const RETRYABLE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', '08000', '08003', '08006', '57P01']);

let Client;
let loadError;
try {
  Client = createRequire(workerData.packageJsonPath)('pg').Client;
} catch (error) {
  loadError = error;
}

let client;
let activeKey;
let queue = Promise.resolve();

function dropClient(target) {
  if (target && client !== target) return;
  const current = client;
  client = undefined;
  activeKey = undefined;
  if (current) current.end().catch(() => {});
}

async function ensureClient(connection) {
  const key = JSON.stringify(connection);
  if (client && activeKey === key) return client;
  dropClient();
  const next = new Client({ ...connection, ssl: false, connectionTimeoutMillis: 10000, query_timeout: 30000 });
  next.on('error', () => dropClient(next));
  next.on('end', () => dropClient(next));
  await next.connect();
  client = next;
  activeKey = key;
  return client;
}

function isRetryableDisconnect(error) {
  if (!error) return false;
  if (typeof error.code === 'string' && RETRYABLE_CODES.has(error.code)) return true;
  const msg = typeof error.message === 'string' ? error.message : '';
  if (/query read timeout/iu.test(msg)) return false;
  return /connection terminated|socket hang up|closed unexpectedly/iu.test(msg);
}

function truncateUtf8(text, maxBytes) {
  let encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= maxBytes) return encoded;
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end);
}

function writeResponse(signal, payloadBuffer, ok, message) {
  const encoded = truncateUtf8(String(message), payloadBuffer.byteLength);
  encoded.copy(payloadBuffer, 0, 0, encoded.length);
  Atomics.store(signal, 1, encoded.length);
  Atomics.store(signal, 0, ok ? 1 : 2);
  Atomics.notify(signal, 0, 1);
}

async function runStatements(connection, statements) {
  const createMatch = statements.length === 1 ? /^CREATE DATABASE "([a-z0-9_]+)"$/u.exec(statements[0]) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = await ensureClient(connection);
      if (attempt === 1 && createMatch) {
        const existing = await current.query('SELECT 1 FROM pg_database WHERE datname = $1', [createMatch[1]]);
        if (existing.rowCount > 0) return;
      }
      for (const statement of statements) await current.query(statement);
      return;
    } catch (error) {
      dropClient();
      if (attempt === 0 && isRetryableDisconnect(error)) continue;
      throw error;
    }
  }
}

async function handleMessage(message) {
  const signal = new Int32Array(message.signalBuffer);
  const payload = Buffer.from(message.payloadBuffer);
  try {
    if (message.type === 'close') {
      const current = client;
      client = undefined;
      activeKey = undefined;
      if (current) {
        try { await current.end(); } catch {}
      }
      writeResponse(signal, payload, true, '');
      return;
    }
    if (loadError) throw loadError;
    await runStatements(message.connection, message.statements);
    writeResponse(signal, payload, true, '');
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown';
    writeResponse(signal, payload, false, 'PostgreSQL fixture control failed: ' + code);
  }
}

parentPort.on('message', message => {
  queue = queue.then(() => handleMessage(message));
});
`

let controlWorker: Worker | undefined

function getControlWorker(): Worker {
  if (controlWorker) return controlWorker
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
  const worker = new Worker(controlWorkerScript, { eval: true, workerData: { packageJsonPath } })
  worker.unref()
  worker.on('error', () => {
    if (controlWorker === worker) controlWorker = undefined
  })
  worker.once('exit', () => {
    if (controlWorker === worker) controlWorker = undefined
  })
  controlWorker = worker
  return worker
}

function callControlWorker(message: Record<string, unknown>): void {
  const worker = getControlWorker()
  const signalBuffer = new SharedArrayBuffer(8)
  const payloadBuffer = new SharedArrayBuffer(RESPONSE_BUFFER_BYTES)
  const signal = new Int32Array(signalBuffer)
  worker.postMessage({ ...message, signalBuffer, payloadBuffer })
  const waited = Atomics.wait(signal, 0, 0, CONTROL_TIMEOUT_MS)
  if (waited === 'timed-out') {
    if (controlWorker === worker) controlWorker = undefined
    void worker.terminate()
    throw new Error('PostgreSQL fixture control timed out')
  }
  const status = Atomics.load(signal, 0)
  const length = Atomics.load(signal, 1)
  if (status !== 1) {
    const text = Buffer.from(payloadBuffer, 0, length).toString('utf8')
    throw new Error(text || 'PostgreSQL fixture control failed')
  }
}

function executePostgresStatements(fixture: PostgresFixtureInfo, statements: readonly string[]): void {
  callControlWorker({
    type: 'exec',
    connection: { host: fixture.host, port: fixture.port, database: 'postgres', user: 'postgres', password: fixture.password },
    statements,
  })
}

export function postgresConnection(): PlatformDatabaseConnection {
  const fixture = inject('postgres'),
    database = 'phalanx_' + randomUUID().replaceAll('-', '')
  executePostgresStatements(fixture, [`CREATE DATABASE "${database}"`])
  created.push(database)
  return { host: fixture.host, port: fixture.port, database, username: 'postgres', password: fixture.password, tls: 'disable' }
}

/** A closed per-case owner can release its database before the rest of a large file runs. */
export function dropCreatedDatabase(database: string): void {
  const index = created.indexOf(database)
  if (index < 0) throw Error('Refusing to drop a database this file did not create')
  executePostgresStatements(inject('postgres'), [`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`])
  created.splice(index, 1)
}

/** Drop this file's databases so one container does not accumulate every suite's data and WAL. */
export function dropCreatedDatabases(): void {
  if (!created.length) return
  // Each statement commits separately; retain ownership after partial failure so IF EXISTS can retry.
  executePostgresStatements(
    inject('postgres'),
    created.map(database => `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
  )
  created.splice(0)
}

/** Close and terminate the worker-scoped persistent PG control client before teardown proceeds. */
export async function closePostgresControlWorker(): Promise<void> {
  if (!controlWorker) return
  const worker = controlWorker
  controlWorker = undefined
  try {
    const signalBuffer = new SharedArrayBuffer(8)
    const payloadBuffer = new SharedArrayBuffer(1024)
    const signal = new Int32Array(signalBuffer)
    worker.postMessage({ type: 'close', signalBuffer, payloadBuffer })
    Atomics.wait(signal, 0, 0, 5_000)
  } finally {
    await worker.terminate()
  }
}
