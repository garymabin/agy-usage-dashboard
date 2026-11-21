import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const transcriptCache = new Map();
let sqliteLoader;

async function getDatabaseSync() {
  if (!sqliteLoader) {
    sqliteLoader = import('node:sqlite')
      .then((mod) => mod.DatabaseSync || null)
      .catch(() => null);
  }
  return sqliteLoader;
}

function discoverDataDirs() {
  const dirs = new Set();
  const envDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (envDir) {
    for (let d = envDir; d !== dirname(d); d = dirname(d)) {
      if (existsSync(join(d, 'brain'))) {
        dirs.add(d);
        break;
      }
    }
  }

  const geminiRoot = join(homedir(), '.gemini');
  if (existsSync(geminiRoot)) {
    const primary = join(geminiRoot, 'antigravity');
    if (existsSync(primary)) dirs.add(primary);
    try {
      for (const entry of readdirSync(geminiRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(geminiRoot, entry.name);
        if (
          existsSync(join(candidate, 'brain')) ||
          existsSync(join(candidate, 'conversation_summaries.db'))
        ) {
          dirs.add(candidate);
        }
      }
    } catch {
      // Ignore unreadable directories
    }
  }
  return [...dirs];
}

function parseWorkspaceName(raw) {
  if (!raw || typeof raw !== 'string') return 'No workspace';
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return 'No workspace';

  let uris = [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) uris = parsed.filter((x) => typeof x === 'string' && x);
    } catch {
      uris = [trimmed];
    }
  } else {
    uris = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
  }

  if (!uris.length) return 'No workspace';
  let first = uris[0];
  try {
    first = decodeURIComponent(first);
  } catch {
    // Keep raw URI if malformed percent-encoding
  }
  first = first.replace(/^file:\/\/\/?/i, '').replace(/[\\/]+$/, '');
  const parts = first.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : first || 'No workspace';
}

async function loadConversationSummaries(dataDirs) {
  const byId = new Map();
  let dbFound = false;

  const DatabaseSync = await getDatabaseSync();
  if (!DatabaseSync) {
    return { byId, dbFound: false };
  }

  for (const dir of dataDirs) {
    const dbPath = join(dir, 'conversation_summaries.db');
    if (!existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      dbFound = true;
      const stmt = db.prepare(`
        SELECT
          conversation_id,
          title,
          preview,
          step_count,
          last_modified_time,
          workspace_uris,
          status,
          source,
          project_id,
          parent_conversation_id,
          nesting_depth
        FROM conversation_summaries
      `);
      for (const row of stmt.all()) {
        if (!row.conversation_id) continue;
        const existing = byId.get(row.conversation_id);
        const modMs = Date.parse(row.last_modified_time || '') || 0;
        if (!existing || modMs >= existing.lastModifiedMs) {
          const cleanTitle = (row.title || '').trim();
          const cleanPreview = (row.preview || '').replace(/\s+/g, ' ').trim();
          const title =
            cleanTitle ||
            (cleanPreview ? cleanPreview.slice(0, 72) + (cleanPreview.length > 72 ? '…' : '') : row.conversation_id.slice(0, 8));
          byId.set(row.conversation_id, {
            id: row.conversation_id,
            title,
            stepCount: Number(row.step_count) || 0,
            lastModifiedTime: row.last_modified_time || '',
            lastModifiedMs: modMs,
            workspace: parseWorkspaceName(row.workspace_uris),
            status: row.status || '',
            source: row.source || '',
            projectId: row.project_id || '',
            parentId: row.parent_conversation_id || '',
            isSubagent: Boolean(row.parent_conversation_id || (Number(row.nesting_depth) || 0) > 0),
          });
        }
      }
    } catch {
      // Ignore locked or incompatible DB
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  return { byId, dbFound };
}

function parseTranscriptFile(filePath, convId) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.turns;
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const turns = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line || !line.includes('PLANNER_RESPONSE')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== 'PLANNER_RESPONSE') continue;

    const freshInput = Math.max(0, Number(obj.input_tokens) || 0);
    const cacheRead = Math.max(0, Number(obj.cache_read_tokens) || 0);
    const output = Math.max(0, Number(obj.output_tokens) || 0);
    const totalInput = freshInput + cacheRead;
    const totalTokens = totalInput + output;

    if (totalTokens === 0 && !obj.model) continue;

    const tsMs = Date.parse(obj.created_at || '') || stat.mtimeMs;
    const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : 'unknown';
    const tools = [];
    if (Array.isArray(obj.tool_calls)) {
      for (const tc of obj.tool_calls) {
        if (tc && typeof tc.name === 'string' && tc.name) {
          tools.push(tc.name);
        }
      }
    }

    turns.push({
      convId,
      stepIndex: Number(obj.step_index) || 0,
      model,
      tsMs,
      freshInput,
      cacheRead,
      totalInput,
      output,
      totalTokens,
      tools,
    });
  }

  transcriptCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    turns,
  });
  return turns;
}

function loadAllTranscripts(dataDirs) {
  const allTurns = [];
  let transcriptFilesCount = 0;
  const seenFiles = new Set();

  for (const dir of dataDirs) {
    const brainDir = join(dir, 'brain');
    if (!existsSync(brainDir)) continue;
    let entries;
    try {
      entries = readdirSync(brainDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const convId = entry.name;
      const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
      if (seenFiles.has(transcriptPath) || !existsSync(transcriptPath)) continue;
      seenFiles.add(transcriptPath);
      const turns = parseTranscriptFile(transcriptPath, convId);
      if (turns && turns.length > 0) {
        transcriptFilesCount += 1;
        for (const t of turns) allTurns.push(t);
      }
    }
  }

  return { allTurns, transcriptFilesCount };
}

export function formatModelName(id) {
  if (!id || id === 'unknown') return 'Unknown Model';
  return id
    .split(/[-_]+/)
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      if (part.toLowerCase() === 'gpt') return 'GPT';
      if (part.toLowerCase() === 'pro') return 'Pro';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function modelFamily(id) {
  const lower = (id || '').toLowerCase();
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) return 'OpenAI';
  return 'Other';
}

function getRangeStartMs(range, nowMs) {
  const hour = 3600 * 1000;
  const day = 24 * hour;
  switch (range) {
    case '24h':
      return nowMs - day;
    case '7d':
      return nowMs - 7 * day;
    case '30d':
      return nowMs - 30 * day;
    case 'all':
    default:
      return 0;
  }
}

function toLocalDateKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toLocalHourKey(ms) {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, '0');
  return `${toLocalDateKey(ms)} ${h}:00`;
}

function formatDayLabel(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function collectUsageAnalytics(options = {}) {
  const nowMs = Date.now();
  const rawRange = ['24h', '7d', '30d', 'all'].includes(options.range) ? options.range : '30d';
  const modelFilter = options.model && options.model !== 'all' ? String(options.model) : 'all';
  const workspaceFilter = options.workspace && options.workspace !== 'all' ? String(options.workspace) : 'all';
  const searchQuery = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';

  const dataDirs = discoverDataDirs();
  const { byId: summariesById, dbFound } = await loadConversationSummaries(dataDirs);
  const { allTurns, transcriptFilesCount } = loadAllTranscripts(dataDirs);

  const allModelTotals = new Map();
  const allWorkspaceCounts = new Map();
  for (const t of allTurns) {
    allModelTotals.set(t.model, (allModelTotals.get(t.model) || 0) + t.totalTokens);
    const meta = summariesById.get(t.convId);
    const ws = meta ? meta.workspace : 'No workspace';
    if (!allWorkspaceCounts.has(ws)) allWorkspaceCounts.set(ws, new Set());
    allWorkspaceCounts.get(ws).add(t.convId);
  }

  const availableModels = [...allModelTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, totalTokens]) => ({ id, label: formatModelName(id), totalTokens }));

  const availableWorkspaces = [...allWorkspaceCounts.entries()]
    .map(([name, set]) => ({ name, count: set.size }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const startMs = getRangeStartMs(rawRange, nowMs);
  const filteredTurns = allTurns.filter((t) => {
    if (startMs > 0 && t.tsMs < startMs) return false;
    if (modelFilter !== 'all' && t.model !== modelFilter) return false;
    const meta = summariesById.get(t.convId);
    const ws = meta ? meta.workspace : 'No workspace';
    if (workspaceFilter !== 'all' && ws !== workspaceFilter) return false;
    if (searchQuery) {
      const title = (meta?.title || t.convId).toLowerCase();
      const modelName = formatModelName(t.model).toLowerCase();
      if (
        !title.includes(searchQuery) &&
        !t.convId.toLowerCase().includes(searchQuery) &&
        !modelName.includes(searchQuery) &&
        !ws.toLowerCase().includes(searchQuery)
      ) {
        return false;
      }
    }
    return true;
  });

  let freshInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let toolCallsCount = 0;
  let peakContextTokens = 0;

  const modelMap = new Map();
  const toolMap = new Map();
  const convMap = new Map();
  const bucketMap = new Map();

  const useHourly = rawRange === '24h';

  for (const t of filteredTurns) {
    freshInputTokens += t.freshInput;
    cacheReadTokens += t.cacheRead;
    outputTokens += t.output;
    toolCallsCount += t.tools.length;
    if (t.totalInput > peakContextTokens) peakContextTokens = t.totalInput;

    let mAgg = modelMap.get(t.model);
    if (!mAgg) {
      mAgg = {
        model: t.model,
        label: formatModelName(t.model),
        family: modelFamily(t.model),
        turns: 0,
        freshInput: 0,
        cacheRead: 0,
        totalInput: 0,
        output: 0,
        totalTokens: 0,
      };
      modelMap.set(t.model, mAgg);
    }
    mAgg.turns += 1;
    mAgg.freshInput += t.freshInput;
    mAgg.cacheRead += t.cacheRead;
    mAgg.totalInput += t.totalInput;
    mAgg.output += t.output;
    mAgg.totalTokens += t.totalTokens;

    for (const toolName of t.tools) {
      toolMap.set(toolName, (toolMap.get(toolName) || 0) + 1);
    }

    let cAgg = convMap.get(t.convId);
    if (!cAgg) {
      const meta = summariesById.get(t.convId);
      cAgg = {
        id: t.convId,
        title: meta?.title || `Conversation ${t.convId.slice(0, 8)}`,
        workspace: meta?.workspace || 'No workspace',
        isSubagent: Boolean(meta?.isSubagent),
        turns: 0,
        toolCalls: 0,
        freshInput: 0,
        cacheRead: 0,
        totalInput: 0,
        output: 0,
        totalTokens: 0,
        peakContext: 0,
        lastActiveMs: 0,
        modelTokens: new Map(),
      };
      convMap.set(t.convId, cAgg);
    }
    cAgg.turns += 1;
    cAgg.toolCalls += t.tools.length;
    cAgg.freshInput += t.freshInput;
    cAgg.cacheRead += t.cacheRead;
    cAgg.totalInput += t.totalInput;
    cAgg.output += t.output;
    cAgg.totalTokens += t.totalTokens;
    if (t.totalInput > cAgg.peakContext) cAgg.peakContext = t.totalInput;
    if (t.tsMs > cAgg.lastActiveMs) cAgg.lastActiveMs = t.tsMs;
    cAgg.modelTokens.set(t.model, (cAgg.modelTokens.get(t.model) || 0) + t.totalTokens);

    const bucketKey = useHourly ? toLocalHourKey(t.tsMs) : toLocalDateKey(t.tsMs);
    let bAgg = bucketMap.get(bucketKey);
    if (!bAgg) {
      bAgg = {
        bucket: bucketKey,
        label: useHourly ? bucketKey.slice(11, 16) : formatDayLabel(bucketKey),
        totalTokens: 0,
        freshInput: 0,
        cacheRead: 0,
        output: 0,
        turns: 0,
        byModel: {},
      };
      bucketMap.set(bucketKey, bAgg);
    }
    bAgg.totalTokens += t.totalTokens;
    bAgg.freshInput += t.freshInput;
    bAgg.cacheRead += t.cacheRead;
    bAgg.output += t.output;
    bAgg.turns += 1;
    bAgg.byModel[t.model] = (bAgg.byModel[t.model] || 0) + t.totalTokens;
  }

  const timeline = [];
  if (rawRange === '24h') {
    for (let i = 23; i >= 0; i--) {
      const ms = nowMs - i * 3600 * 1000;
      const key = toLocalHourKey(ms);
      timeline.push(
        bucketMap.get(key) || {
          bucket: key,
          label: key.slice(11, 16),
          totalTokens: 0,
          freshInput: 0,
          cacheRead: 0,
          output: 0,
          turns: 0,
          byModel: {},
        },
      );
    }
  } else if (rawRange === '7d' || rawRange === '30d') {
    const days = rawRange === '7d' ? 7 : 30;
    for (let i = days - 1; i >= 0; i--) {
      const ms = nowMs - i * 24 * 3600 * 1000;
      const key = toLocalDateKey(ms);
      timeline.push(
        bucketMap.get(key) || {
          bucket: key,
          label: formatDayLabel(key),
          totalTokens: 0,
          freshInput: 0,
          cacheRead: 0,
          output: 0,
          turns: 0,
          byModel: {},
        },
      );
    }
  } else {
    const sortedKeys = [...bucketMap.keys()].sort();
    for (const k of sortedKeys) {
      timeline.push(bucketMap.get(k));
    }
  }

  const totalInputTokens = freshInputTokens + cacheReadTokens;
  const totalTokens = totalInputTokens + outputTokens;
  const cacheHitRate = totalInputTokens > 0 ? Math.round((cacheReadTokens / totalInputTokens) * 1000) / 10 : 0;

  const models = [...modelMap.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((m) => ({
      ...m,
      cacheHitRate: m.totalInput > 0 ? Math.round((m.cacheRead / m.totalInput) * 1000) / 10 : 0,
      sharePct: totalTokens > 0 ? Math.round((m.totalTokens / totalTokens) * 1000) / 10 : 0,
    }));

  const tools = [...toolMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([name, count]) => ({
      name,
      count,
      sharePct: toolCallsCount > 0 ? Math.round((count / toolCallsCount) * 1000) / 10 : 0,
    }));

  const conversations = [...convMap.values()]
    .map((c) => {
      const sortedModels = [...c.modelTokens.entries()].sort((a, b) => b[1] - a[1]);
      const primaryModel = sortedModels[0]?.[0] || 'unknown';
      return {
        id: c.id,
        title: c.title,
        workspace: c.workspace,
        isSubagent: c.isSubagent,
        primaryModel,
        primaryModelLabel: formatModelName(primaryModel),
        models: sortedModels.map(([m]) => m),
        turns: c.turns,
        toolCalls: c.toolCalls,
        freshInput: c.freshInput,
        cacheRead: c.cacheRead,
        output: c.output,
        totalTokens: c.totalTokens,
        peakContext: c.peakContext,
        cacheHitRate: c.totalInput > 0 ? Math.round((c.cacheRead / c.totalInput) * 1000) / 10 : 0,
        lastActiveAt: c.lastActiveMs ? new Date(c.lastActiveMs).toISOString() : '',
        lastActiveMs: c.lastActiveMs,
      };
    })
    .sort((a, b) => b.lastActiveMs - a.lastActiveMs)
    .slice(0, 100);

  let totalDbSteps = 0;
  let dbSessionsInRange = 0;
  let dbStepsInRange = 0;
  const dbWorkspaceMap = new Map();
  for (const s of summariesById.values()) {
    totalDbSteps += s.stepCount;
    const inRange = startMs === 0 || s.lastModifiedMs >= startMs;
    if (inRange) {
      dbSessionsInRange += 1;
      dbStepsInRange += s.stepCount;
    }
    let w = dbWorkspaceMap.get(s.workspace);
    if (!w) {
      w = { workspace: s.workspace, sessions: 0, steps: 0 };
      dbWorkspaceMap.set(s.workspace, w);
    }
    w.sessions += 1;
    w.steps += s.stepCount;
  }

  const topWorkspaces = [...dbWorkspaceMap.values()]
    .sort((a, b) => b.sessions - a.sessions || b.steps - a.steps)
    .slice(0, 10);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    filters: {
      range: rawRange,
      model: modelFilter,
      workspace: workspaceFilter,
      search: options.search || '',
    },
    availableModels,
    availableWorkspaces,
    summary: {
      totalTokens,
      freshInputTokens,
      cacheReadTokens,
      totalInputTokens,
      outputTokens,
      cacheHitRate,
      turns: filteredTurns.length,
      toolCalls: toolCallsCount,
      telemetryConversations: convMap.size,
      totalDbConversations: summariesById.size,
      totalDbSteps,
      avgTokensPerTurn: filteredTurns.length > 0 ? Math.round(totalTokens / filteredTurns.length) : 0,
      peakContextTokens,
    },
    timeline,
    models,
    tools,
    conversations,
    sessionHistory: {
      dbFound,
      totalSessions: summariesById.size,
      totalSteps: totalDbSteps,
      sessionsInRange: dbSessionsInRange,
      stepsInRange: dbStepsInRange,
      topWorkspaces,
    },
    sources: {
      transcriptFilesCount,
      dbFound,
      dataDirsCount: dataDirs.length,
    },
  };
}

export function formatUsageTextSummary(data) {
  const s = data.summary;
  const fmt = (n) => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  const lines = [
    `Antigravity Usage Summary (${data.filters.range}):`,
    `- Total Tokens: ${fmt(s.totalTokens)} (${fmt(s.freshInputTokens)} fresh input + ${fmt(s.cacheReadTokens)} cache read + ${fmt(s.outputTokens)} output)`,
    `- KV-Cache Hit Rate: ${s.cacheHitRate}%`,
    `- Model Turns: ${s.turns} | Tool Calls: ${s.toolCalls} | Conversations with Token Telemetry: ${s.telemetryConversations}`,
  ];

  if (data.models.length > 0) {
    lines.push('- Top Models:');
    for (const m of data.models.slice(0, 5)) {
      lines.push(`  * ${m.label}: ${fmt(m.totalTokens)} tokens (${m.sharePct}%, ${m.turns} turns, ${m.cacheHitRate}% cache hit)`);
    }
  }

  if (data.sessionHistory.dbFound) {
    lines.push(
      `- Historical Sessions DB: ${data.sessionHistory.totalSessions} total conversations (${data.sessionHistory.totalSteps} steps across all time).`,
    );
  }
  return lines.join('\n');
}
