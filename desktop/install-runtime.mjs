import { downloadArtifact } from '@electron/get';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = dirname(require.resolve('electron/package.json'));
const { version } = require('electron/package.json');
const cacheRoot = join(root, '.electron-cache');
await mkdir(cacheRoot, { recursive: true });
let lastProgress = -1;
try {
  console.log(`正在获取 Electron ${version} 官方运行时并验证 SHA-256…`);
  await downloadArtifact({ version, artifactName: 'electron', platform: process.platform, arch: process.arch,
    cacheRoot, tempDirectory: cacheRoot, checksums: require('electron/checksums.json'),
    downloadOptions: { signal: AbortSignal.timeout(600000), quiet: true,
      getProgressCallback: ({ percent, transferred }) => {
        const progress = Math.floor(percent * 10);
        if (progress !== lastProgress) { lastProgress = progress; console.log(`下载 ${progress * 10}%（${Math.round(transferred / 1048576)} MB）`); }
      } },
  });
  const child = spawnSync(process.execPath, [join(directory, 'install.js')], {
    cwd: root, stdio: 'inherit', timeout: 120000,
    env: { ...process.env, electron_config_cache: cacheRoot, TEMP: cacheRoot, TMP: cacheRoot },
  });
  if (child.status !== 0) throw child.error ?? new Error('Electron 解压或安装失败');
  console.log('Electron 运行时已就绪。');
} catch (error) {
  console.error(`运行时安装失败：${error.message}`); process.exitCode = 1;
}
