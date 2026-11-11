import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRedappCliEnsurer,
  createRedappCommandRunner,
  createRedappOperations,
  parseTaggedOutput,
  sanitizeCredentials
} from '../src/lib/redappCli.js';

test('parses PROMPT and RESULT_JSON lines', () => {
  const parsed = parseTaggedOutput([
    'PROMPT:{"type":"auth_device_code","userCode":"ABCD-EFGH"}',
    'RESULT_JSON:{"status":"ok","credentials":{"loggedIn":true,"openId":"ob1234567890","accessToken":"secret","refreshToken":"secret2","credentialPath":"C:/Users/example/.redapp/credentials.json","scope":"base_info,skill_publish","expireTimeMs":"1794"}}'
  ].join('\n'));
  assert.equal(parsed.prompts[0].userCode, 'ABCD-EFGH');
  assert.equal(parsed.results[0].status, 'ok');
  assert.deepEqual(parsed.results[0].credentials, {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info', 'skill_publish'],
    expireTimeMs: 1794,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('ob1234567890'), false);
  assert.equal(serialized.toLowerCase().includes('credentialpath'), false);
  assert.equal(serialized.toLowerCase().includes('credentialsfile'), false);
});

test('sanitizes credentials and never serializes tokens', () => {
  const dto = sanitizeCredentials({
    loggedIn: true,
    openId: 'ob1234567890',
    accessToken: 'secret',
    refreshToken: 'secret2',
    scope: 'base_info,skill_publish',
    expireTimeMs: '1794'
  });
  assert.equal(dto.openIdMasked, 'ob12…7890');
  assert.deepEqual(dto.scope, ['base_info', 'skill_publish']);
  assert.equal(JSON.stringify(dto).includes('secret'), false);
  assert.equal('accessToken' in dto, false);
  assert.equal('refreshToken' in dto, false);
});

test('preserves numeric zero expiry and marks it for reauthorization', () => {
  const dto = sanitizeCredentials({
    loggedIn: true,
    expireTimeMs: 0,
    refreshExpireTimeMs: '0'
  });
  assert.equal(dto.expireTimeMs, 0);
  assert.equal(dto.refreshExpireTimeMs, 0);
  assert.equal(dto.needsReauth, true);
});

test('blocks business commands when the version gate fails', () => {
  let commandExecutions = 0;
  const run = createRedappCommandRunner({
    ensureCli() {
      throw new Error('gate failed');
    },
    execute() {
      commandExecutions += 1;
      return { status: 0, stdout: '', stderr: '', error: null };
    }
  });

  assert.throws(() => run(['upload']), /gate failed/);
  assert.equal(commandExecutions, 0);
});

test('public command runner sanitizes successful command credentials', () => {
  const accessToken = 'runner-access-token';
  const refreshToken = 'runner-refresh-token';
  const rawResult = {
    status: 'ok',
    credentials: {
      loggedIn: true,
      openId: 'ob1234567890',
      accessToken,
      refreshToken,
      credentialPath: 'C:/private/credentials.json',
      scope: 'base_info'
    }
  };
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute() {
      return {
        status: 0,
        stdout: `RESULT_JSON:${JSON.stringify(rawResult)}`,
        stderr: '',
        error: null
      };
    }
  });

  const result = run(['whoami']);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.credentials, {
    available: true,
    loggedIn: true,
    openIdMasked: 'ob12…7890',
    scope: ['base_info'],
    expireTimeMs: null,
    refreshExpireTimeMs: null,
    needsReauth: false
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(accessToken), false);
  assert.equal(serialized.includes(refreshToken), false);
  assert.equal(serialized.includes('ob1234567890'), false);
  assert.equal(serialized.toLowerCase().includes('credentialpath'), false);
});

test('result schemas drop alternate tokens, nested unknowns, and decorated credential structures', () => {
  const parsed = parseTaggedOutput(`RESULT_JSON:${JSON.stringify({
    status: 'ok',
    command: 'upload',
    token: 'generic-secret',
    access_token: 'access-secret',
    'id-token': 'id-secret',
    credentials: {
      loggedIn: true,
      openId: 'ob1234567890',
      openIdMasked: 'ob1234567890',
      userOpenId: 'ob1234567890',
      credential: { path: 'C:/private/credentials.json' },
      credentialData: { location: '/private/credentials.json' },
      nested: { generic: 'unknown-secret' }
    },
    credential: { file: 'C:/private/credentials.json' },
    plan: { planHash: 'plan-1', credentialPath: 'C:/private/credentials.json', extra: 'drop-me' },
    data: {
      fileId: 'file-1',
      md5: 'abc123',
      previewUrl: 'https://preview.example',
      qrCodePath: 'preview.png',
      qrError: 'safe operational error',
      access_token: 'nested-access-secret',
      nested: { generic: 'unknown-secret' }
    },
    unknownTopLevel: 'drop-me'
  })}`);

  assert.deepEqual(parsed.results[0], {
    status: 'ok',
    command: 'upload',
    credentials: {
      available: true,
      loggedIn: true,
      openIdMasked: 'ob12…7890',
      scope: [],
      expireTimeMs: null,
      refreshExpireTimeMs: null,
      needsReauth: false
    },
    plan: { planHash: 'plan-1' },
    data: {
      fileId: 'file-1',
      md5: 'abc123',
      qrCodePath: 'preview.png',
      previewUrl: 'https://preview.example',
      qrError: 'safe operational error'
    }
  });
  const serialized = JSON.stringify(parsed);
  for (const secret of [
    'generic-secret', 'access-secret', 'id-secret', 'credentials.json',
    'unknown-secret', 'nested-access-secret', 'drop-me'
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('credentials use exact allowlisted source keys and drop decorated openId keys', () => {
  const parsed = parseTaggedOutput(`RESULT_JSON:${JSON.stringify({
    credentials: {
      loggedIn: true,
      open_id: 'abcd',
      openIdValue: 'abcdefgh',
      userOpenId: 'ob1234567890',
      credential: { path: 'C:/private/credentials.json' }
    }
  })}`);
  assert.equal(parsed.results[0].credentials.openIdMasked, null);
  assert.equal(JSON.stringify(parsed).includes('abcd'), false);
  assert.equal(JSON.stringify(parsed).includes('ob1234567890'), false);
  assert.equal(JSON.stringify(parsed).includes('credentials.json'), false);
});

test('openId masking never reveals the complete source at any length', () => {
  for (const source of ['a', 'ab', 'abcd', 'abcdefgh', 'ob1234567890']) {
    const dto = sanitizeCredentials({ openId: source });
    assert.notEqual(dto.openIdMasked, source);
    const revealed = [...source].filter(character => dto.openIdMasked.includes(character)).length;
    assert.ok(revealed < source.length, `${source} must reveal fewer source characters`);
  }
});

test('prompt schema preserves auth fields and drops unknown or token-like fields', () => {
  const prompt = parseTaggedOutput(`PROMPT:${JSON.stringify({
    type: 'auth_device_code',
    authorizeCommonUrl: 'https://common.example',
    authorizeH5Url: 'https://h5.example',
    authorizeUrl: 'https://authorize.example',
    userCode: 'ABCD-EFGH',
    expiresInSeconds: 300,
    message: 'Scan to authorize',
    qrCodePath: 'auth.png',
    access_token: 'access-secret',
    token: 'token-secret',
    nested: { generic: 'unknown-secret' },
    unknown: 'drop-me'
  })}`).prompts[0];

  assert.deepEqual(prompt, {
    type: 'auth_device_code',
    authorizeCommonUrl: 'https://common.example',
    authorizeH5Url: 'https://h5.example',
    authorizeUrl: 'https://authorize.example',
    userCode: 'ABCD-EFGH',
    expiresInSeconds: 300,
    message: 'Scan to authorize',
    qrCodePath: 'auth.png'
  });
});

test('version gate errors never expose malformed output', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate() {
      return { status: 0, stdout: 'TEST_GATE_SECRET', stderr: 'TEST_GATE_SECRET', error: null };
    }
  });

  assert.throws(() => ensureCli(), error => {
    assert.equal(error.message, 'CLI 版本门禁输出无法解析');
    assert.equal(error.message.includes('TEST_GATE_SECRET'), false);
    return true;
  });
});

test('version gate errors never expose untrusted verdict messages', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate() {
      return {
        status: 0,
        stdout: 'CLI_VERSION_JSON:{"status":"error","message":"TEST_GATE_SECRET"}',
        stderr: '',
        error: null
      };
    }
  });

  assert.throws(() => ensureCli(), error => {
    assert.equal(error.message, 'CLI 版本门禁未通过');
    assert.equal(error.message.includes('TEST_GATE_SECRET'), false);
    return true;
  });
});

test('version gate accepts current, installed, and updated statuses', () => {
  for (const status of ['current', 'installed', 'updated']) {
    const ensureCli = createRedappCliEnsurer({
      gateExists: () => true,
      cliExists: () => true,
      prepareCache() {},
      executeGate: () => ({
        status: 0,
        stdout: `CLI_VERSION_JSON:${JSON.stringify({ status })}`,
        stderr: '',
        error: null
      })
    });
    assert.equal(ensureCli().status, status);
  }
});

test('version gate rejects allowed verdict after nonzero exit', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 1,
      stdout: 'CLI_VERSION_JSON:{"status":"current"}',
      stderr: 'TEST_GATE_SECRET',
      error: null
    })
  });
  assert.throws(() => ensureCli(), { message: 'CLI 版本门禁执行失败' });
});

test('version gate rejects allowed verdict after execution error', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 0,
      stdout: 'CLI_VERSION_JSON:{"status":"current"}',
      stderr: '',
      error: new Error('TEST_GATE_SECRET')
    })
  });
  assert.throws(() => ensureCli(), { message: 'CLI 版本门禁执行失败' });
});

test('business runner rejects successful result after nonzero exit', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute: () => ({
      status: 1,
      stdout: 'RESULT_JSON:{"status":"ok","data":{"fileId":"file-1"}}',
      stderr: 'TEST_BUSINESS_SECRET',
      error: null
    })
  });
  assert.throws(() => run(['upload']), { message: 'redapp 命令执行失败' });
});

test('business runner rejects successful result after execution error', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute: () => ({
      status: 0,
      stdout: 'RESULT_JSON:{"status":"ok","data":{"fileId":"file-1"}}',
      stderr: '',
      error: new Error('TEST_BUSINESS_SECRET')
    })
  });
  assert.throws(() => run(['upload']), { message: 'redapp 命令执行失败' });
});

test('upload and preview preserve existing command flow and return shapes', () => {
  const calls = [];
  const runCommand = (args, options) => {
    calls.push({ args, options });
    if (args.includes('--dry-run')) return { plan: { planHash: `plan-${calls.length}` } };
    if (args[0] === 'upload') return { data: { fileId: 'file-1', md5: 'abc123' } };
    return {
      data: {
        qrCodePath: 'preview.png',
        previewUrl: 'https://preview.example',
        fileId: 'file-1',
        token: 'preview-secret',
        nested: { generic: 'unknown-secret' }
      }
    };
  };
  const written = [];
  const operations = createRedappOperations({
    runCommand,
    writeFile: (...args) => written.push(args),
    fileExists: () => false
  });

  assert.deepEqual(operations.uploadPackage('package.zip'), { fileId: 'file-1', md5: 'abc123' });
  assert.deepEqual(operations.createPreview({
    fileId: 'file-1', md5: 'abc123', appName: 'App', qrOut: 'preview.png'
  }), {
    qrCodePath: 'preview.png',
    previewUrl: 'https://preview.example',
    raw: { qrCodePath: 'preview.png', previewUrl: 'https://preview.example', fileId: 'file-1' }
  });
  assert.deepEqual(calls.map(call => call.args), [
    ['upload', '--file', 'package.zip', '--type', 'pkg', '--dry-run'],
    ['upload', '--file', 'package.zip', '--type', 'pkg', '--confirm', 'plan-1'],
    ['preview', '--source', 'thirdAgent', '--file', 'preview.json', '--dry-run'],
    ['preview', '--source', 'thirdAgent', '--file', 'preview.json', '--qr-out', 'preview.png', '--confirm', 'plan-3']
  ]);
  assert.deepEqual(calls.map(call => call.options.timeoutMs), [180000, 180000, 120000, 120000]);
  assert.equal(written.length, 1);
});

test('public command runner does not copy malformed raw output into errors', () => {
  const run = createRedappCommandRunner({
    ensureCli() {},
    execute() {
      return {
        status: 1,
        stdout: 'RESULT_JSON:{"accessToken":"malformed-secret"',
        stderr: 'refreshToken=stderr-secret openId=ob-full-secret',
        error: null
      };
    }
  });

  assert.throws(
    () => run(['whoami']),
    error => {
      assert.equal(error.message, 'redapp 命令执行失败');
      assert.equal(error.message.includes('malformed-secret'), false);
      assert.equal(error.message.includes('stderr-secret'), false);
      assert.equal(error.message.includes('ob-full-secret'), false);
      return true;
    }
  );
});

test('allowed prompt and result fields project only expected primitive types', () => {
  const injected = { accessToken: 'TEST_SECRET', openId: 'complete-open-id' };
  const parsed = parseTaggedOutput([
    `PROMPT:${JSON.stringify({
      type: 't'.repeat(300),
      authorizeCommonUrl: 'u'.repeat(5000),
      authorizeH5Url: ['TEST_SECRET'],
      authorizeUrl: 'https://authorize.example',
      userCode: 'c'.repeat(300),
      expiresInSeconds: 0,
      message: injected,
      qrCodePath: 'p'.repeat(5000)
    })}`,
    `RESULT_JSON:${JSON.stringify({
      status: 's'.repeat(100),
      command: injected,
      plan: { planHash: injected },
      data: {
        fileId: injected,
        md5: 'm'.repeat(200),
        qrCodePath: 'preview.png',
        previewUrl: ['TEST_SECRET'],
        qrError: injected
      }
    })}`
  ].join('\n'));

  assert.deepEqual(parsed.prompts[0], {
    type: 't'.repeat(256),
    authorizeCommonUrl: 'u'.repeat(4096),
    authorizeUrl: 'https://authorize.example',
    userCode: 'c'.repeat(256),
    expiresInSeconds: 0,
    qrCodePath: 'p'.repeat(4096)
  });
  assert.deepEqual(parsed.results[0], {
    status: 's'.repeat(64),
    data: { md5: 'm'.repeat(128), qrCodePath: 'preview.png' }
  });
  assert.equal(JSON.stringify(parsed).includes('TEST_SECRET'), false);
});

test('credentials accept only typed scope and finite numeric expiry values', () => {
  assert.deepEqual(sanitizeCredentials({
    loggedIn: true,
    scope: ['base_info', { token: 'TEST_SECRET' }, 42, 'skill_publish'],
    expireTimeMs: '0',
    refreshExpireTimeMs: { token: 'TEST_SECRET' }
  }), {
    available: true,
    loggedIn: true,
    openIdMasked: null,
    scope: ['base_info', 'skill_publish'],
    expireTimeMs: 0,
    refreshExpireTimeMs: null,
    needsReauth: true
  });
  assert.deepEqual(sanitizeCredentials({ scope: { token: 'TEST_SECRET' }, expireTimeMs: 'Infinity' }).scope, []);
});

test('credentials require exact boolean true for authenticated state', () => {
  for (const loggedIn of ['false', 1, {}, [], undefined]) {
    const credentials = loggedIn === undefined ? {} : { loggedIn };
    const dto = sanitizeCredentials(credentials);
    assert.equal(dto.loggedIn, false);
    assert.equal(dto.needsReauth, true);
  }

  assert.equal(sanitizeCredentials({ loggedIn: true }).loggedIn, true);
  assert.equal(sanitizeCredentials({ loggedIn: false }).loggedIn, false);
});

test('version gate returns only its accepted status', () => {
  const ensureCli = createRedappCliEnsurer({
    gateExists: () => true,
    cliExists: () => true,
    prepareCache() {},
    executeGate: () => ({
      status: 0,
      stdout: 'CLI_VERSION_JSON:{"status":"current","token":"TEST_SECRET","openId":"complete-open-id","path":"C:/private"}',
      stderr: '',
      error: null
    })
  });

  assert.deepEqual(ensureCli(), { status: 'current' });
});

test('operation validation errors never reflect CLI-controlled results', () => {
  const planOperations = createRedappOperations({
    runCommand: () => ({ command: 'TEST_SECRET' }),
    writeFile() {},
    fileExists: () => false
  });
  assert.throws(() => planOperations.uploadPackage('package.zip'), error => {
    assert.equal(error.message, 'dry-run 未返回 planHash');
    assert.equal(error.message.includes('TEST_SECRET'), false);
    return true;
  });

  let calls = 0;
  const uploadOperations = createRedappOperations({
    runCommand: () => {
      calls += 1;
      if (calls === 1) return { plan: { planHash: 'plan-1' } };
      return { data: { fileId: 'file-1', qrError: 'TEST_SECRET' } };
    },
    writeFile() {},
    fileExists: () => false
  });
  assert.throws(() => uploadOperations.uploadPackage('package.zip'), error => {
    assert.equal(error.message, '上传回执缺少 fileId/md5');
    assert.equal(error.message.includes('TEST_SECRET'), false);
    return true;
  });
});
