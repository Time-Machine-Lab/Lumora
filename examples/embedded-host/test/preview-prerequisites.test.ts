import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = existsSync(resolve(process.cwd(), 'scripts/check-preview-prerequisites.mjs'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
const prerequisiteScript = resolve(repositoryRoot, 'scripts/check-preview-prerequisites.mjs');

describe('production preview prerequisites', () => {
  it('rejects a PLAYWRIGHT_EDGE_PATH that is not a Microsoft Edge executable', () => {
    const result = spawnSync(process.execPath, [prerequisiteScript], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_EDGE_PATH: '.',
      },
      windowsHide: true,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PLAYWRIGHT_EDGE_PATH');
    expect(result.stderr).toContain('Microsoft Edge');
  });
});
