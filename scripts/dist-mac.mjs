/**
 * 打 macOS 安装包(arm64 dmg)。
 *
 * pnpm workspace 的依赖是符号链接,electron-builder 直接打 apps/desktop 会漏掉
 * @bigbotart/* 和 pi-ai。先 deploy 成一份自包含目录,再在那份目录上打包。
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// 必须放在仓库外面。放在仓库里时 electron-builder 会顺着 pnpm-workspace.yaml
// 把整个 monorepo 当成工作区，打包会卡住。
const stage = join(tmpdir(), 'bigbotart-stage');
const output = join(root, 'release/out');

function run(cmd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value == null) delete env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: root,
      stdio: 'inherit',
      env,
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}`));
    });
  });
}

await rm(stage, { recursive: true, force: true });
await run('pnpm', ['build:packages']);
await run('pnpm', ['--filter', '@bigbotart/desktop', 'build']);
await run('pnpm', ['--filter', '@bigbotart/desktop', 'deploy', '--prod', '--legacy', stage]);
// deploy --prod 会把仓库的 workspace state 写成「仅生产依赖」。不装回去的话，
// 下一条 pnpm 命令会试图删掉 node_modules。
await run('pnpm', ['install']);
await run(
  'pnpm',
  [
    '--filter',
    '@bigbotart/desktop',
    'exec',
    'electron-builder',
    '--mac',
    'dmg',
    '--arm64',
    '--publish',
    'never',
    '--config',
    join(root, 'apps/desktop/electron-builder.yml'),
    '--projectDir',
    stage,
    `--config.directories.output=${output}`,
  ],
  { CSC_IDENTITY_AUTO_DISCOVERY: 'false', CI: null },
);
