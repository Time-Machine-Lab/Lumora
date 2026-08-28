import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { chromium } from '@playwright/test';

async function inspectEdge() {
  const override = process.env.PLAYWRIGHT_EDGE_PATH?.trim();
  let browser;
  try {
    browser = await chromium.launch(override
      ? { executablePath: override }
      : { channel: 'msedge' });
    const page = await browser.newPage();
    const userAgent = await page.evaluate(() => globalThis.navigator.userAgent);
    if (!userAgent.includes('Edg/')) {
      throw new Error(`launched browser did not identify as Microsoft Edge (${userAgent})`);
    }
    return { userAgent };
  } finally {
    await browser?.close();
  }
}

function ffprobeVersion() {
  const result = spawnSync('ffprobe', ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/, 1)[0]?.trim() || 'ffprobe (version unavailable)';
}

let edge = null;
let edgeError = null;
try {
  edge = await inspectEdge();
} catch (error) {
  edgeError = error instanceof Error ? error.message : String(error);
}
const probeVersion = ffprobeVersion();
const failures = [];

if (!edge) {
  const override = process.env.PLAYWRIGHT_EDGE_PATH?.trim();
  failures.push(override
    ? `PLAYWRIGHT_EDGE_PATH must launch Microsoft Edge (${override}): ${edgeError}`
    : `Microsoft Edge could not be launched through Playwright's msedge channel: ${edgeError}. Install system Edge, or set PLAYWRIGHT_EDGE_PATH to its executable.`);
}
if (!probeVersion) {
  failures.push('ffprobe is not runnable from PATH. Install FFmpeg and add its bin directory to PATH.');
}

if (failures.length > 0) {
  console.error('Production preview prerequisites are missing:');
  for (const failure of failures) console.error(`- ${failure}`);
  console.error('Run `node scripts/check-preview-prerequisites.mjs` after fixing the environment.');
  process.exitCode = 1;
} else {
  console.log('Production preview prerequisites satisfied:');
  console.log(`- Microsoft Edge: ${edge.userAgent}`);
  console.log(`- ${probeVersion}`);
}
