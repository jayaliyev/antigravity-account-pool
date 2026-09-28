import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// The installed AGY binary contains its native-app OAuth client. Identify the
// known client without redistributing its credential values in this repository.
const clientIdHash = 'bf00c418024ba6bf606ccdc37120976e41bc429dd1d46ecf16a729aa532626ea';
const clientSecretHash = '1d2f041093fd95aa8995a038c711d50a7960da09a505381c09a745d6ad0ecc60';
const idPattern = /[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com/g;
const secretPattern = /GOCSPX-[A-Za-z0-9_-]{28}/g;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

async function readInstalledClient() {
  const configuredId = process.env.AGY_POOL_OAUTH_CLIENT_ID;
  const configuredSecret = process.env.AGY_POOL_OAUTH_CLIENT_SECRET;
  if (configuredId || configuredSecret) {
    if (!configuredId || !configuredSecret) {
      throw new Error('Set both AGY_POOL_OAUTH_CLIENT_ID and AGY_POOL_OAUTH_CLIENT_SECRET.');
    }
    return { id: configuredId, secret: configuredSecret };
  }

  const localAppData = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const binaryPath = process.env.AGY_POOL_AGY_PATH || path.join(localAppData, 'agy', 'bin', 'agy.exe');
  const handle = await fs.open(binaryPath, 'r').catch(() => {
    throw new Error(`Antigravity CLI was not found at ${binaryPath}. Set AGY_POOL_AGY_PATH to agy.exe.`);
  });
  let id = null;
  let secret = null;
  let tail = '';
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      const text = tail + chunk.toString('latin1', 0, bytesRead);
      for (const match of text.matchAll(idPattern)) {
        if (digest(match[0]) === clientIdHash) id = match[0];
      }
      for (const match of text.matchAll(secretPattern)) {
        if (digest(match[0]) === clientSecretHash) secret = match[0];
      }
      if (id && secret) break;
      tail = text.slice(-256);
    }
  } finally {
    await handle.close();
  }
  if (!id || !secret) {
    throw new Error('This AGY version has an unrecognized OAuth client. Update the pool or set AGY_POOL_OAUTH_CLIENT_ID and AGY_POOL_OAUTH_CLIENT_SECRET locally.');
  }
  return { id, secret };
}

let cached;
export function installedOAuthClient() {
  if (!cached) cached = readInstalledClient().catch(error => { cached = null; throw error; });
  return cached;
}
