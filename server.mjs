import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestedModel, quotaBuckets, quotaForModel, quotaGroup, quotaWindowsForModel, quotaPools, quotaResetMs, chooseAccountForModel, isAuxiliaryModel, orderAccountsForGroup } from './quota-policy.mjs';
import { installedOAuthClient } from './oauth-client.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const metaPath = path.join(dataDir, 'accounts.json');
const bridgePath = path.join(root, 'CredentialBridge.ps1');
const openWindowPath = path.join(root, 'Open-AgyWindow.ps1');
const pwsh = process.env.AGY_POOL_PWSH || 'pwsh.exe';
const port = Number(process.env.AGY_POOL_PORT || 18454);
const globalTarget = 'gemini:antigravity';
const recoveryTarget = 'agy-pool:recovery';
const upstreamHost = 'daily-cloudcode-pa.googleapis.com';
const maxRequestBytes = 128 * 1024 * 1024;
const secret = randomBytes(32).toString('hex');
const agent = new https.Agent({ keepAlive: true });

let meta = { accounts: [], activeId: null, events: [] };
let enrollment = null;
let launchBusyUntil = 0;
let diagnosticNext429Model = null;
let diagnosticNextLowModel = null;
let polling = false;
let quotaRequestTemplate = null;
let lastRequestedModel = null;
let quotaCheckError = null;
const snapshots = new Map();
const refreshes = new Map();
const quotaCache = new Map();
const quotaChecks = new Map();
const removingAccounts = new Set();
const accountUse = new Map();
const idleWaiters = new Map();
// Transient UI activity. No prompt, response, or token content is retained here.
const modelWork = new Map();
let saveQueue = Promise.resolve();

function beginModelWork(id, model) {
  const work = modelWork.get(id) || { inFlight: 0, lastModel: null, lastStartedAt: null, lastFinishedAt: null };
  work.inFlight++;
  work.lastModel = model;
  work.lastStartedAt = Date.now();
  modelWork.set(id, work);
}
function endModelWork(id) {
  const work = modelWork.get(id);
  if (!work) return;
  work.inFlight = Math.max(0, work.inFlight - 1);
  work.lastFinishedAt = Date.now();
}

function acquireAccount(id) { accountUse.set(id, (accountUse.get(id) || 0) + 1); }
function releaseAccount(id) {
  const remaining = (accountUse.get(id) || 1) - 1;
  if (remaining > 0) { accountUse.set(id, remaining); return; }
  accountUse.delete(id);
  for (const resolve of idleWaiters.get(id) || []) resolve();
  idleWaiters.delete(id);
}
function waitForIdle(id) {
  if (!accountUse.has(id)) return Promise.resolve();
  return new Promise(resolve => {
    if (!idleWaiters.has(id)) idleWaiters.set(id, []);
    idleWaiters.get(id).push(resolve);
  });
}

function targetFor(id) { return `agy-pool:${id}`; }
function note(message) {
  meta.events.unshift({ at: new Date().toISOString(), message });
  meta.events = meta.events.slice(0, 30);
  void saveMeta().catch(error => process.stderr.write(`Could not save account metadata: ${error.message}\n`));
}
async function saveMeta() {
  const out = JSON.stringify(meta, null, 2);
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    const tempPath = `${metaPath}.tmp`;
    await fs.writeFile(tempPath, out, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(tempPath, metaPath);
  });
  return saveQueue;
}
function bridge(action, target, source, payload) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bridgePath,
      '-Action', action, '-Target', target];
    if (source) args.push('-Source', source);
    const child = spawn(pwsh, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 5_000_000) child.kill(); });
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100_000) child.kill(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Credential operation ${action} failed (exit ${code}). ${stderr.trim().slice(0, 400)}`));
    });
    child.stdin.end(payload ? JSON.stringify(payload) : '');
  });
}
async function readSnapshot(target) { return JSON.parse(await bridge('read', target)); }
function parseCredential(snapshot) {
  const raw = Buffer.from(snapshot.Blob, 'base64').toString('utf8');
  const credential = JSON.parse(raw);
  if (!credential?.token?.access_token) throw new Error('Antigravity credential has no access token.');
  return credential;
}
async function snapshotFor(account) {
  if (!snapshots.has(account.id)) snapshots.set(account.id, await readSnapshot(targetFor(account.id)));
  return snapshots.get(account.id);
}
async function refreshToken(account, snapshot, credential) {
  if (refreshes.has(account.id)) return refreshes.get(account.id);
  const task = (async () => {
    const oldRefreshToken = credential?.token?.refresh_token;
    if (!oldRefreshToken) throw new Error(`Account ${account.label} has no refresh token; sign in again.`);
    const oauth = await installedOAuthClient();
    const form = new URLSearchParams({
      client_id: oauth.id, client_secret: oauth.secret,
      refresh_token: oldRefreshToken, grant_type: 'refresh_token',
    });
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', body: form, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`OAuth refresh failed for ${account.label} (HTTP ${response.status}).`);
    const updated = await response.json();
    if (!updated.access_token) throw new Error('OAuth refresh returned no access token.');
    credential.token.access_token = updated.access_token;
    if (updated.refresh_token) credential.token.refresh_token = updated.refresh_token;
    credential.token.expiry = new Date(Date.now() + Number(updated.expires_in || 3600) * 1000).toISOString();
    snapshot.Blob = Buffer.from(JSON.stringify(credential), 'utf8').toString('base64');
    await bridge('write', targetFor(account.id), null, snapshot);
    snapshots.set(account.id, snapshot);
    note(`Refreshed access token for ${account.label}.`);
    return credential.token.access_token;
  })();
  refreshes.set(account.id, task);
  try { return await task; }
  finally { refreshes.delete(account.id); }
}
async function accessToken(account, forceRefresh = false) {
  const snapshot = await snapshotFor(account);
  const credential = parseCredential(snapshot);
  const expiry = Date.parse(credential.token.expiry || '');
  if (forceRefresh || (Number.isFinite(expiry) && expiry < Date.now() + 120_000)) {
    return refreshToken(account, snapshot, credential);
  }
  return credential.token.access_token;
}
async function emailFor(target) {
  const snapshot = await readSnapshot(target);
  const token = parseCredential(snapshot).token.access_token;
  try {
    const result = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (result.ok) {
      const data = await result.json();
      if (typeof data.email === 'string' && data.email.includes('@')) return data.email;
    }
  } catch { /* The account can still work without a display email. */ }
  return null;
}
async function recoverCredential() {
  if ((await bridge('exists', recoveryTarget)) !== 'true') return;
  await bridge('copy', globalTarget, recoveryTarget);
  await bridge('delete', recoveryTarget);
  note('Recovered the original Antigravity credential after an interrupted account login.');
}
async function bootstrap() {
  await fs.mkdir(dataDir, { recursive: true });
  try { meta = JSON.parse(await fs.readFile(metaPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  meta.accounts ||= [];
  meta.events ||= [];
  meta.activeByModel ||= {};
  meta.lowQuotaPercent = Number.isFinite(Number(meta.lowQuotaPercent)) ?
    Math.min(100, Math.max(0, Number(meta.lowQuotaPercent))) : 10;
  for (const account of meta.accounts) account.blockedByModel ||= {};
  await recoverCredential();
  if (meta.accounts.length === 0) {
    if ((await bridge('exists', globalTarget)) !== 'true') {
      throw new Error('Sign into Antigravity once before starting the account pool.');
    }
    const id = randomUUID();
    await bridge('copy', targetFor(id), globalTarget);
    const email = await emailFor(targetFor(id));
    meta.accounts.push({ id, email, label: email || 'Account 1', blockedUntil: 0, blockedByModel: {} });
    meta.activeId = id;
    note('Saved the currently signed-in account in Windows Credential Manager.');
  }
  if (!meta.accounts.some(account => account.id === meta.activeId)) meta.activeId = meta.accounts[0].id;

  await saveMeta();
}
function availableAccounts(exclude = new Set(), model = null) {
  const now = Date.now();
  const accounts = meta.accounts.filter(account => !exclude.has(account.id) &&
    !removingAccounts.has(account.id) && Number(account.blockedUntil || 0) <= now &&
    (!model || Number(account.blockedByModel?.[model] || 0) <= now));
  return orderAccountsForGroup(accounts, meta.activeId, meta.activeByModel, model);
}
function isQuotaError(status, message) {
  return status === 429 && /Individual quota reached|weekly quota|5.hour|one.week|Resets? in/i.test(message);
}
function quotaShape(payload) {
  return { rootKeys: Object.keys(payload || {}), buckets: quotaBuckets(payload) };
}
async function fetchQuotaSummary(account) {
  const request = (quotaRequestTemplate?.accountId === account.id ? quotaRequestTemplate : null) || {
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'antigravity' },
    body: Buffer.from('{}'),
  };
  const upstream = { method: 'POST', url: '/v1internal:retrieveUserQuotaSummary', headers: request.headers };
  let response = await upstreamRequest(upstream, request.body, await accessToken(account), 8_000);
  if (response.statusCode === 401) {
    await collect(response);
    response = await upstreamRequest(upstream, request.body, await accessToken(account, true), 8_000);
  }
  const raw = await collect(response, 2_000_000);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Quota check returned HTTP ${response.statusCode}.`);
  }
  return JSON.parse(raw.toString('utf8'));
}
async function checkedQuota(account, force = false) {
  const cached = quotaCache.get(account.id);
  const age = cached ? Date.now() - cached.checkedAt : Infinity;
  if (!force && cached && age < (cached.error ? 60_000 : 5_000)) return cached.payload;
  if (quotaChecks.has(account.id)) return quotaChecks.get(account.id);
  acquireAccount(account.id);
  const task = (async () => {
    try {
      const payload = await fetchQuotaSummary(account);
      quotaCache.set(account.id, { payload, checkedAt: Date.now(), error: null });
      quotaCheckError = null;
      return payload;
    } catch (error) {
      quotaCache.set(account.id, { payload: null, checkedAt: Date.now(), error: error.message });
      quotaCheckError = `Quota check unavailable: ${error.message.slice(0, 120)}`;
      return null;
    } finally {
      releaseAccount(account.id);
    }
  })();
  quotaChecks.set(account.id, task);
  try { return await task; }
  finally { quotaChecks.delete(account.id); }
}
async function refreshAllQuotas() {
  await Promise.all(meta.accounts.filter(account => !removingAccounts.has(account.id))
    .map(account => checkedQuota(account, true)));
}
async function chooseAccount(tried, model, simulateLow = false) {
  const candidates = availableAccounts(tried, quotaGroup(model));
  return chooseAccountForModel(candidates, model, meta.lowQuotaPercent, checkedQuota, simulateLow);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Request body too large.')); req.destroy(); }
      else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function upstreamRequest(req, body, token, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, authorization: `Bearer ${token}` };
    delete headers.host;
    delete headers.connection;
    delete headers['transfer-encoding'];
    delete headers['accept-encoding'];
    headers['content-length'] = String(body.length);
    const call = https.request({
      hostname: upstreamHost, method: req.method, path: req.url,
      headers, agent, timeout: timeoutMs,
    }, resolve);
    call.on('timeout', () => call.destroy(new Error('Google request timed out.')));
    call.on('error', reject);
    call.end(body);
  });
}
function collect(response, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Upstream error response too large.')); response.destroy(); }
      else chunks.push(chunk);
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}
function relayBuffered(res, status, headers, body) {
  const outgoing = { ...headers, 'content-length': String(body.length) };
  delete outgoing['transfer-encoding'];
  res.writeHead(status, outgoing);
  res.end(body);
}
async function proxy(req, res) {
  if (req.headers.origin || req.headers['sec-fetch-site']) {
    json(res, 403, { error: 'Browser requests cannot use the CLI proxy.' });
    return;
  }
  const body = await readBody(req, maxRequestBytes);
  let quotaTemplateCandidate = null;
  if (req.url.includes('retrieveUserQuotaSummary')) {
    const allowed = ['content-type', 'accept', 'user-agent', 'x-goog-api-client', 'x-goog-user-project'];
    quotaTemplateCandidate = { headers: Object.fromEntries(allowed.filter(key => req.headers[key]).map(key => [key, req.headers[key]])), body };
  }
  const model = requestedModel(req.url, body);
  if (model && !isAuxiliaryModel(model)) lastRequestedModel = model;
  const simulateLow = !!model && model === diagnosticNextLowModel;
  if (simulateLow) diagnosticNextLowModel = null;
  const tried = new Set();
  while (tried.size < meta.accounts.length) {
    const choice = await chooseAccount(tried, model, simulateLow && tried.size === 0);
    const account = choice.account;
    if (!account) break;
    tried.add(account.id);
    acquireAccount(account.id);
    const trackedWork = !!model && !isAuxiliaryModel(model);
    if (trackedWork) beginModelWork(account.id, model);
    try {
    if (choice.firstLow != null && account.id !== choice.preferredId) {
      note(`Switched ${model} before a request: selected account was at ${Math.round(choice.firstLow * 100)}% (threshold ${meta.lowQuotaPercent}%).`);
    }
    let token = await accessToken(account);
    let response;
    if (model && model === diagnosticNext429Model) {
      diagnosticNext429Model = null;
      response = { statusCode: 429, headers: { 'content-type': 'application/json' },
        syntheticBody: Buffer.from('{"error":{"code":429,"message":"Individual quota reached. Resets in 1m","status":"RESOURCE_EXHAUSTED"}}') };
    } else {
      response = await upstreamRequest(req, body, token);
    }
    if (response.statusCode === 401 && !response.syntheticBody) {
      await collect(response);
      token = await accessToken(account, true);
      response = await upstreamRequest(req, body, token);
    }
    if (response.statusCode === 429) {
      const errorBody = response.syntheticBody || await collect(response);
      const errorText = errorBody.toString('utf8');
      if (isQuotaError(429, errorText)) {
        const until = Date.now() + quotaResetMs(errorText);
        if (model) account.blockedByModel[quotaGroup(model)] = until;
        else account.blockedUntil = until;
        note(`${account.label} reached its ${quotaGroup(model) || 'account'} quota; ${availableAccounts(tried, quotaGroup(model)).length ? 'retrying with the next account' : 'no other account is available'}.`);
        if (availableAccounts(tried, quotaGroup(model)).length > 0) continue;
      }
      relayBuffered(res, 429, response.headers, errorBody);
      return;
    }
    if (req.url.includes('retrieveUserQuotaSummary') && response.statusCode >= 200 && response.statusCode < 300) {
      const quotaBody = await collect(response, 2_000_000);
      try {
        quotaCache.set(account.id, { payload: JSON.parse(quotaBody.toString('utf8')), checkedAt: Date.now(), error: null });
        quotaRequestTemplate = { ...quotaTemplateCandidate, accountId: account.id };
      }
      catch { /* Return the original response even if its quota format changes. */ }
      relayBuffered(res, response.statusCode, response.headers, quotaBody);
      return;
    }
    if (meta.accounts.includes(account) && !removingAccounts.has(account.id) && model &&
        response.statusCode >= 200 && response.statusCode < 300) {
      const group = quotaGroup(model);
      const previous = meta.activeByModel[group] || meta.activeId;
      meta.activeByModel[group] = account.id;
      if (previous !== account.id) note(`Now routing ${group} requests through ${account.label}.`);
    }
    if (response.syntheticBody) { relayBuffered(res, response.statusCode, response.headers, response.syntheticBody); return; }
    res.writeHead(response.statusCode || 502, response.headers);
    response.pipe(res);
    res.on('close', () => response.destroy());
    await new Promise(resolve => res.once('close', resolve));
    return;
    } finally {
      if (trackedWork) endModelWork(account.id);
      releaseAccount(account.id);
    }
  }
  res.writeHead(429, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 429, message: 'Every saved account is currently quota blocked.' } }));
}
function launch(mode, projectPath, resume = false) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', openWindowPath, '-Mode', mode];
    if (mode === 'Project') {
      args.push('-ProjectPath', projectPath, '-Port', String(port));
      if (resume) args.push('-ContinueConversation');
    }
    const child = spawn(pwsh, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      const pid = Number(stdout.trim());
      if (code === 0 && Number.isInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error(`Could not open the ${mode.toLowerCase()} CLI window: ${stderr.trim().slice(0, 300)}`));
    });
  });
}
async function finishEnrollment(snapshot) {
  const id = randomUUID();
  await bridge('write', targetFor(id), null, snapshot);
  const email = await emailFor(targetFor(id));
  if (email && meta.accounts.some(account => account.email === email)) {
    await bridge('delete', targetFor(id));
    enrollment.message = 'That Google account is already in the pool. Sign into a different account.';
    return;
  }
  await bridge('copy', globalTarget, recoveryTarget);
  await bridge('delete', recoveryTarget);
  const added = { id, email, label: email || `Account ${meta.accounts.length + 1}`, blockedUntil: 0, blockedByModel: {} };
  meta.accounts.push(added);
  void checkedQuota(added, true);
  enrollment = null;
  note(`Added ${email || 'a new account'} and restored the original CLI credential.`);
}
async function cancelEnrollment(message) {
  if (!enrollment) return;
  await bridge('copy', globalTarget, recoveryTarget);
  await bridge('delete', recoveryTarget);
  enrollment = null;
  note(message);
}
async function pollEnrollment() {
  if (!enrollment || polling) return;
  polling = true;
  try {
    if (Date.now() > enrollment.deadline) {
      await cancelEnrollment('Account login timed out; original CLI credential restored.');
      return;
    }
    if ((await bridge('exists', globalTarget)) !== 'true') return;
    const snapshot = await readSnapshot(globalTarget);
    const previous = await readSnapshot(recoveryTarget);
    if (snapshot.Blob === previous.Blob) return;
    await finishEnrollment(snapshot);
  } catch (error) { if (enrollment) enrollment.message = error.message.slice(0, 160); }
  finally { polling = false; }
}
function status() {
  const model = lastRequestedModel;
  const group = quotaGroup(model);
  const displayWindow = window => window ? {
    percent: Math.round(window.remainingFraction * 100), resetTime: window.resetTime,
  } : null;
  return {
    accounts: meta.accounts.map(({ id, email, label, blockedUntil, blockedByModel }) => {
      const cached = quotaCache.get(id);
      const quota = model && cached?.payload ? quotaForModel(cached.payload, model) : null;
      const windows = model && cached?.payload ? quotaWindowsForModel(cached.payload, model) : [];
      const pools = quotaPools(cached?.payload);
      const work = modelWork.get(id);
      return { id, email, label, blockedUntil,
        work: work ? { inFlight: work.inFlight, lastModel: work.lastModel,
          lastStartedAt: work.lastStartedAt, lastFinishedAt: work.lastFinishedAt } : null,
        modelBlockedUntil: group ? Number(blockedByModel?.[group] || 0) : 0,
        blockedGroups: { gemini: Number(blockedByModel?.gemini || 0), other: Number(blockedByModel?.['3p'] || 0) },
        quotaRemainingPercent: quota ? Math.round(quota.remainingFraction * 100) : null,
        quotaWindows: windows.map(item => ({ id: item.modelId, percent: Math.round(item.remainingFraction * 100) })),
        quotaPools: {
          gemini: { fiveHour: displayWindow(pools.gemini.fiveHour), weekly: displayWindow(pools.gemini.weekly) },
          other: { fiveHour: displayWindow(pools.other.fiveHour), weekly: displayWindow(pools.other.weekly) },
        },
        quotaCheckedAt: cached?.checkedAt || null,
        quotaError: cached?.error || null };
    }),
    activeId: (group && meta.activeByModel[group]) || meta.activeId, events: meta.events,
    activeGroups: { gemini: meta.activeByModel.gemini || meta.activeId,
      other: meta.activeByModel['3p'] || meta.activeId },
    enrollment: enrollment ? { message: enrollment.message || 'Sign in in the new Antigravity CLI window.', deadline: enrollment.deadline } : null,
    removingId: removingAccounts.values().next().value || null,
    lastRequestedModel,
    lastRequestedGroup: group,
    diagnosticNextLowModel,
    diagnosticNext429Model,
    lowQuotaPercent: meta.lowQuotaPercent,
    quotaCheckError,
    launchBusy: Date.now() < launchBusyUntil,
  };
}
function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function api(req, res) {
  if (req.method === 'GET' && req.url === '/api/status') { json(res, 200, status()); return; }
  if (req.method !== 'POST' || req.headers['x-agy-pool-key'] !== secret ||
      !String(req.headers['content-type'] || '').startsWith('application/json')) {
    json(res, 403, { error: 'Invalid local app request.' }); return;
  }
  const body = JSON.parse((await readBody(req, 1_000_000)).toString('utf8') || '{}');
  if (removingAccounts.size) throw new Error('Wait for the current account removal to finish.');
  if (req.url === '/api/accounts/add') {
    if (enrollment) throw new Error('An account login is already in progress.');
    if (Date.now() < launchBusyUntil) throw new Error('Wait for the previous CLI launch to finish loading.');
    await bridge('copy', recoveryTarget, globalTarget);
    try {
      await bridge('delete', globalTarget);
      enrollment = { deadline: Date.now() + 10 * 60_000, message: null };
      launchBusyUntil = Date.now() + 35_000;
      const pid = await launch('Login');
      note(`Opened Antigravity CLI for a new account (process ${pid}).`);
      json(res, 200, status()); return;
    } catch (error) {
      await bridge('copy', globalTarget, recoveryTarget);
      await bridge('delete', recoveryTarget);
      enrollment = null;
      throw error;
    }
  }
  if (req.url === '/api/accounts/cancel') {
    await cancelEnrollment('Account login canceled; original CLI credential restored.');
    json(res, 200, status()); return;
  }
  if (req.url === '/api/accounts/select') {
    const account = meta.accounts.find(item => item.id === body.id);
    if (!account) throw new Error('Unknown account.');
    account.blockedUntil = 0;
    account.blockedByModel = {};
    meta.activeByModel = {};
    meta.activeId = account.id;
    note(`Selected ${account.label} for future requests.`);
    json(res, 200, status()); return;
  }
  if (req.url === '/api/accounts/label') {
    const account = meta.accounts.find(item => item.id === body.id);
    const label = String(body.label || '').trim();
    if (!account || !label || label.length > 80) throw new Error('Enter a label of 1 to 80 characters.');
    account.label = label;
    await saveMeta();
    json(res, 200, status()); return;
  }
  if (req.url === '/api/accounts/remove') {
    if (enrollment) throw new Error('Finish or cancel the current account login first.');
    if (meta.accounts.length < 2) throw new Error('Keep at least one account in the pool.');
    const account = meta.accounts.find(item => item.id === body.id);
    if (!account) throw new Error('Unknown account.');
    removingAccounts.add(account.id);
    try {
      await waitForIdle(account.id);
      const refreshing = refreshes.get(account.id);
      if (refreshing) await refreshing.catch(() => {});
      await bridge('delete', targetFor(account.id));
      snapshots.delete(account.id);
      quotaCache.delete(account.id);
      modelWork.delete(account.id);
      meta.accounts = meta.accounts.filter(item => item.id !== account.id);
      for (const [model, id] of Object.entries(meta.activeByModel)) {
        if (id === account.id) delete meta.activeByModel[model];
      }
      if (meta.activeId === account.id) {
        meta.activeId = (availableAccounts()[0] || meta.accounts[0]).id;
      }
      note(`Removed ${account.label} from the account pool.`);
      await saveMeta();
      removingAccounts.delete(account.id);
      json(res, 200, status()); return;
    } finally { removingAccounts.delete(account.id); }
  }
  if (req.url === '/api/projects/launch') {
    if (Date.now() < launchBusyUntil) throw new Error('Wait for the previous CLI launch to finish loading.');
    const projectPath = path.resolve(String(body.path || ''));
    const info = await fs.stat(projectPath);
    if (!info.isDirectory()) throw new Error('Project path must be a directory.');
    launchBusyUntil = Date.now() + 35_000;
    const pid = await launch('Project', projectPath, !!body.resume);
    note(`Opened Antigravity CLI for ${path.basename(projectPath)} (process ${pid}).`);
    json(res, 200, { ...status(), pid }); return;
  }
  if (req.url === '/api/diagnostics/next429') {
    if (meta.accounts.length < 2) throw new Error('Add a second account first.');
    if (!lastRequestedModel) throw new Error('Send a prompt first so the selected model is known.');
    diagnosticNext429Model = lastRequestedModel;
    note(`The next ${lastRequestedModel} request will receive a local quota error, then retry through another account.`);
    json(res, 200, status()); return;
  }
  if (req.url === '/api/diagnostics/nextlow') {
    if (meta.accounts.length < 2) throw new Error('Add a second account first.');
    if (meta.lowQuotaPercent <= 0) throw new Error('Set a quota threshold above 0% first.');
    if (!lastRequestedModel) throw new Error('Send a prompt first so the selected model is known.');
    diagnosticNextLowModel = lastRequestedModel;
    note(`The next ${lastRequestedModel} request will test a low quota reading, then route through another account.`);
    json(res, 200, status()); return;
  }
  if (req.url === '/api/settings/threshold') {
    const value = Number(body.percent);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Enter a whole percentage from 0 to 100.');
    meta.lowQuotaPercent = value;
    note(`Low quota switch threshold set to ${value}%.`);
    json(res, 200, status()); return;
  }
  if (req.url === '/api/quota/check') {
    await refreshAllQuotas();
    json(res, 200, status()); return;
  }
  if (req.url === '/api/diagnostics/refresh') {
    const account = meta.accounts.find(item => item.id === (body.id || meta.activeId));
    if (!account) throw new Error('Unknown account.');
    await accessToken(account, true);
    json(res, 200, status()); return;
  }
  if (req.url === '/api/diagnostics/quota') {
    const account = meta.accounts.find(item => item.id === (body.id || meta.activeId));
    if (!account) throw new Error('Unknown account.');
    const result = quotaShape(await fetchQuotaSummary(account));
    json(res, 200, { ...result, lastRequestedModel }); return;
  }
  if (req.url === '/api/stop') {
    await cancelEnrollment('Stopped account enrollment; original credential restored.');
    json(res, 200, { stopped: true });
    setTimeout(() => server.close(() => process.exit(0)), 100);
    return;
  }
  json(res, 404, { error: 'Unknown endpoint.' });
}

const htmlTemplate = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
const html = htmlTemplate.replaceAll('__AGY_POOL_KEY__', secret);
let ready = false;
const server = http.createServer((req, res) => {
  (async () => {
    if (!ready) { json(res, 503, { error: 'Account pool is starting.' }); return; }
    if (req.headers.host !== `127.0.0.1:${port}`) {
      json(res, 403, { error: 'Invalid local host.' }); return;
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'nonce-__AGY_POOL_KEY__'; style-src 'unsafe-inline'".replace('__AGY_POOL_KEY__', secret) });
      res.end(html); return;
    }
    if (req.url.startsWith('/api/')) { await api(req, res); return; }
    if (req.url.startsWith('/v1internal:')) { await proxy(req, res); return; }
    json(res, 404, { error: 'Not found.' });
  })().catch(error => {
    if (!res.headersSent) json(res, 500, { error: error.message.slice(0, 200) });
    else res.destroy();
  });
});
await new Promise((resolve, reject) => {
  const fail = error => reject(error);
  server.once('error', fail);
  server.listen(port, '127.0.0.1', () => { server.off('error', fail); resolve(); });
});
try {
  await bootstrap();
  ready = true;
  setInterval(pollEnrollment, 2500).unref();
  setInterval(() => { void refreshAllQuotas(); }, 60_000).unref();
  void refreshAllQuotas();
  process.stdout.write(`Agy account pool listening at http://127.0.0.1:${port}/\n`);
} catch (error) {
  server.close();
  throw error;
}
