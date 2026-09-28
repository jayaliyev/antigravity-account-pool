export function canonicalModel(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim().replace(/^models\//i, '').toLowerCase();
  return model || null;
}

export function quotaGroup(modelId) {
  const model = canonicalModel(modelId);
  if (model?.startsWith('gemini')) return 'gemini';
  if (model?.startsWith('claude') || model?.startsWith('gpt')) return '3p';
  return model;
}

export function isAuxiliaryModel(modelId) {
  return /(?:^|[-_])lite(?:$|[-_])/.test(canonicalModel(modelId) || '');
}

export function orderAccountsForGroup(accounts, defaultId, activeByGroup, group) {
  const preferredId = (group && activeByGroup[group]) || defaultId;
  const preferred = accounts.find(account => account.id === preferredId);
  return preferred ? [preferred, ...accounts.filter(account => account.id !== preferredId)] : accounts;
}

export function requestedModel(url, body) {
  if (!/:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(url)) return null;
  try {
    const request = JSON.parse(body.toString('utf8'));
    return canonicalModel(request.model || request.request?.model);
  } catch { return null; }
}

export function quotaBuckets(payload) {
  const buckets = [];
  const bucketId = value => typeof value === 'string' && /^(?:gemini|3p)-(?:5h|weekly)$/i.test(value);
  function visit(value, inheritedModel, depth) {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedModel, depth + 1);
    } else if (typeof value === 'object') {
      const identity = [value.id, value.bucketId, value.quotaBucketId].find(bucketId);
      const model = canonicalModel(value.modelId || value.modelName || value.model || identity) || inheritedModel;
      const rawFraction = value.remainingFraction ?? value.remaining_fraction ??
        value.remaining?.remainingFraction ??
        (value.remaining?.case === 'remainingFraction' ? value.remaining.value : null);
      const fraction = Number(rawFraction);
      if (rawFraction != null && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && model) {
        buckets.push({ modelId: model, remainingFraction: fraction,
          resetTime: typeof (value.resetTime || value.reset_time) === 'string' ?
            (value.resetTime || value.reset_time) : null });
      }
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === 'object') {
          const keyedModel = /^(?:models\/)?(?:gemini|claude|gpt|3p)[\w.\-]+$/i.test(key) ? canonicalModel(key) : model;
          visit(item, keyedModel, depth + 1);
        }
      }
    }
  }
  visit(payload, null, 0);
  return buckets;
}

export function quotaWindowsForModel(payload, modelId) {
  const model = canonicalModel(modelId);
  if (!model) return [];
  const group = quotaGroup(model);
  const allowed = new Set([model]);
  if (group === 'gemini' || group === '3p') {
    allowed.add(`${group}-5h`);
    allowed.add(`${group}-weekly`);
  }
  return quotaBuckets(payload).filter(bucket => allowed.has(bucket.modelId));
}

export function quotaPools(payload) {
  const buckets = quotaBuckets(payload);
  function windowFor(id) {
    const matches = buckets.filter(bucket => bucket.modelId === id);
    if (!matches.length) return null;
    const lowest = matches.reduce((left, right) =>
      right.remainingFraction < left.remainingFraction ? right : left);
    return { remainingFraction: lowest.remainingFraction, resetTime: lowest.resetTime };
  }
  return {
    gemini: { fiveHour: windowFor('gemini-5h'), weekly: windowFor('gemini-weekly') },
    other: { fiveHour: windowFor('3p-5h'), weekly: windowFor('3p-weekly') },
  };
}

export function quotaForModel(payload, modelId) {
  const matches = quotaWindowsForModel(payload, modelId);
  if (!matches.length) return null;
  return matches.reduce((lowest, bucket) =>
    bucket.remainingFraction < lowest.remainingFraction ? bucket : lowest);
}

export async function chooseAccountForModel(candidates, model, thresholdPercent, readQuota, simulateLow = false) {
  if (!model || thresholdPercent <= 0 || candidates.length < 2) return { account: candidates[0] };
  let unknown = null;
  let bestLow = null;
  let firstLow = null;
  const threshold = thresholdPercent / 100;
  for (const [index, account] of candidates.entries()) {
    const quota = simulateLow && index === 0
      ? { remainingFraction: 0 }
      : quotaForModel(await readQuota(account), model);
    if (!quota) {
      if (index === 0) return { account };
      unknown ||= account;
      continue;
    }
    if (quota.remainingFraction > threshold) return { account, firstLow, preferredId: candidates[0].id };
    if (index === 0) firstLow = quota.remainingFraction;
    if (!bestLow || quota.remainingFraction > bestLow.quota.remainingFraction) bestLow = { account, quota };
  }
  return { account: unknown || bestLow?.account || candidates[0], firstLow, preferredId: candidates[0].id };
}

export function quotaResetMs(message) {
  const match = String(message).match(/Resets? in\s+(?:(\d+)w)?\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match || !/\d/.test(match[0])) return 5 * 60_000;
  const seconds = Number(match[1] || 0) * 604800 + Number(match[2] || 0) * 86400 +
    Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0);
  return Math.max(60_000, seconds * 1000);
}
