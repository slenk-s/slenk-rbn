import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRedappNpmEnv, createAsyncProcessRunner, createRedappOperationsAsync } from '../src/lib/redappCli.js';

test('injects SKILLHUB_UPLOAD_HOME when credentialHome is set', () => {
  const env = createRedappNpmEnv('win32', { credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(env.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('omits SKILLHUB_UPLOAD_HOME when credentialHome is absent', () => {
  const env = createRedappNpmEnv('win32');
  assert.equal('SKILLHUB_UPLOAD_HOME' in env, false);
});

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('async process runner forwards per-call credentialHome into the child env', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  const run = createAsyncProcessRunner({
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  const pending = run(['fake'], 1000, { credentialHome: 'C:/auth/u1/acct1' });
  child.emit('close', 0);
  await pending;
  assert.equal(capturedEnv.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('async process runner omits SKILLHUB_UPLOAD_HOME when credentialHome is absent', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  const run = createAsyncProcessRunner({
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  const pending = run(['fake'], 1000);
  child.emit('close', 0);
  await pending;
  assert.equal('SKILLHUB_UPLOAD_HOME' in capturedEnv, false);
});

test('async process runner accepts spawnProcess from per-call args with credentialHome env', async () => {
  const child = createFakeChild();
  let capturedEnv = null;
  let factorySpawnUsed = false;
  const run = createAsyncProcessRunner({
    spawnProcess: () => {
      factorySpawnUsed = true;
      return createFakeChild();
    }
  });
  const pending = run(['fake'], 1000, {
    credentialHome: 'C:/auth/u1/acct1',
    spawnProcess: (cmd, args, options) => {
      capturedEnv = options.env;
      return child;
    }
  });
  child.emit('close', 0);
  await pending;
  assert.equal(factorySpawnUsed, false);
  assert.equal(capturedEnv.SKILLHUB_UPLOAD_HOME, 'C:/auth/u1/acct1');
});

test('uploadPackageAsync forwards credentialHome to every runCommand invocation', async () => {
  const seen = [];
  const operations = createRedappOperationsAsync({
    runCommand: async (args, options) => {
      seen.push({ args, options });
      return args.includes('--dry-run') ? { plan: { planHash: 'plan-1' } } : { data: { fileId: 'file', md5: 'md5' } };
    },
    writeFile() {}, fileExists: () => false
  });
  await operations.uploadPackageAsync('package.zip', { credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].args.includes('--dry-run'), true);
  assert.equal(seen[1].args.includes('--confirm'), true);
  for (const { options } of seen) {
    assert.equal(options.credentialHome, 'C:/auth/u1/acct1');
  }
});

test('createPreviewAsync forwards credentialHome to every runCommand invocation', async () => {
  const seen = [];
  const operations = createRedappOperationsAsync({
    runCommand: async (args, options) => {
      seen.push({ args, options });
      return args.includes('--dry-run') ? { plan: { planHash: 'plan-1' } } : { data: { qrCodePath: 'qr.png', previewUrl: 'https://example.test/p' } };
    },
    writeFile() {}, fileExists: () => false
  });
  await operations.createPreviewAsync({ fileId: 'file', md5: 'md5', qrOut: 'qr.png', credentialHome: 'C:/auth/u1/acct1' });
  assert.equal(seen.length, 2);
  for (const { options } of seen) {
    assert.equal(options.credentialHome, 'C:/auth/u1/acct1');
  }
});
