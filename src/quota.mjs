import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedQuota = null;

export function getCachedQuota() {
  return cachedQuota;
}

function findAgyBinary() {
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    candidates.push(join(localAppData, 'agy', 'bin', 'agy.exe'));
    candidates.push('agy.exe');
    candidates.push('agy');
  } else {
    candidates.push(join(homedir(), '.local', 'bin', 'agy'));
    candidates.push('/usr/local/bin/agy');
    candidates.push('/opt/homebrew/bin/agy');
    candidates.push('agy');
  }

  for (const c of candidates) {
    if (c.includes('/') || c.includes('\\')) {
      if (existsSync(c)) return c;
    } else {
      return c;
    }
  }
  return 'agy';
}

function parseQuotaJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) {
    throw new Error('Empty output from agy CLI.');
  }

  // Find the JSON object in stdout in case any prefix/warning line was printed
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Unexpected non-JSON output from agy CLI.');
  }
  const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));

  if (parsed.status && parsed.status !== 'SUCCESS') {
    throw new Error(parsed.response || `agy returned status ${parsed.status}`);
  }

  const data = parsed?.command?.data;
  if (!data || !Array.isArray(data.groups)) {
    throw new Error('Quota data missing from agy /usage response.');
  }

  const groups = data.groups.map((g) => ({
    name: g.name || 'Model Group',
    description: g.description || '',
    buckets: (g.buckets || []).map((b) => {
      const remainingFraction = Math.max(0, Math.min(1, Number(b.remaining_fraction ?? 0)));
      const remainingPct = Math.round(remainingFraction * 1000) / 10;
      const usedPct = Math.round((1 - remainingFraction) * 1000) / 10;
      return {
        id: b.id || '',
        name: b.name || (b.window === '5h' ? '5-Hour Limit' : 'Weekly Limit'),
        window: b.window || '',
        description: b.description || '',
        remainingFraction,
        remainingPct,
        usedPct,
        resetTime: b.reset_time || '',
      };
    }),
  }));

  return {
    ok: true,
    fetchedAt: new Date().toISOString(),
    description: data.description || '',
    groups,
  };
}

export async function fetchLiveQuota() {
  const bin = findAgyBinary();
  try {
    const { stdout } = await execFileAsync(
      bin,
      ['--print', '/usage', '--output-format', 'json', '--print-timeout', '15s'],
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    const result = parseQuotaJson(stdout);
    cachedQuota = result;
    return result;
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        fetchedAt: new Date().toISOString(),
        error: 'Antigravity CLI (agy) was not found on PATH.',
        hint: 'Install the official Antigravity CLI (agy) so this button can run `agy --print /usage --output-format json`.',
      };
    }
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    return {
      ok: false,
      fetchedAt: new Date().toISOString(),
      error: stderr || err?.message || 'Failed to query quota via agy CLI.',
      hint: 'Make sure you are signed in to `agy` CLI, or check Settings → Models.',
    };
  }
}

export function formatQuotaTextSummary(quota) {
  if (!quota?.ok) {
    return `Unable to fetch live quota: ${quota?.error || 'Unknown error'}${quota?.hint ? `\n${quota.hint}` : ''}`;
  }
  const lines = ['Antigravity Live Account Quota (via `agy --print /usage`):'];
  for (const g of quota.groups) {
    lines.push(`- ${g.name}:`);
    for (const b of g.buckets) {
      const label = b.window === '5h' ? '5-Hour' : b.window === 'weekly' ? 'Weekly' : b.name;
      lines.push(`  * ${label}: ${b.usedPct}% used (${b.remainingPct}% remaining)${b.resetTime ? ` · resets ${b.resetTime}` : ''}`);
    }
  }
  return lines.join('\n');
}
