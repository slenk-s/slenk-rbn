// 跨平台运行 MySQL 契约测试：TEST_DATA_BACKEND=mysql 时跑同一组 store 测试。
import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['--test'], {
  stdio: 'inherit',
  env: { ...process.env, TEST_DATA_BACKEND: 'mysql', SLENK_DATA_BACKEND: 'mysql' }
});
child.on('exit', code => process.exit(code ?? 1));
