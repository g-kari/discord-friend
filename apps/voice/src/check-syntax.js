import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
for (const directory of ['src', 'test']) {
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exit(1);
  }
}
