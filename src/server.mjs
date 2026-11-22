import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveQuota, formatQuotaTextSummary, getCachedQuota } from './quota.mjs';
import { collectUsageAnalytics, formatUsageTextSummary } from './usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://usage-dashboard/app.html';
const APP_MIME = 'text/html;profile=mcp-app';

function resolveAppHtmlPath() {
  if (process.env.USAGE_DASHBOARD_APP_HTML && existsSync(process.env.USAGE_DASHBOARD_APP_HTML)) {
    return process.env.USAGE_DASHBOARD_APP_HTML;
  }
  const sibling = join(__dirname, 'app.html');
  if (existsSync(sibling)) return sibling;
  return join(dirname(__dirname), 'dist', 'app.html');
}

const server = new Server(
  {
    name: 'agy-usage-dashboard',
    version: '1.2.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'Antigravity Usage Dashboard',
      description: 'Interactive local token, KV-cache, model, tool, conversation, and live quota dashboard.',
      mimeType: APP_MIME,
      _meta: {
        ui: {
          prefersBorder: false,
        },
      },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== APP_URI) {
    throw new Error(`Unknown resource URI: ${request.params.uri}`);
  }
  const htmlPath = resolveAppHtmlPath();
  const html = readFileSync(htmlPath, 'utf-8');
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: APP_MIME,
        text: html,
        _meta: {
          ui: {
            prefersBorder: false,
          },
        },
      },
    ],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_usage_dashboard',
      title: 'Usage',
      description:
        'Open the interactive Antigravity Usage Dashboard showing local token consumption, KV-cache hit rate, model breakdown, daily/hourly charts, top tools, per-conversation telemetry, and an on-demand Live Quota check.',
      inputSchema: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['24h', '7d', '30d', 'all'],
            description: 'Time window filter (default: 30d).',
          },
          model: {
            type: 'string',
            description: 'Optional model ID filter (default: all).',
          },
          workspace: {
            type: 'string',
            description: 'Optional workspace name filter (default: all).',
          },
        },
      },
      _meta: {
        ui: {
          resourceUri: APP_URI,
        },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'global', title: 'Usage' },
            { type: 'aux_pane', title: 'Usage' },
          ],
        },
      },
    },
    {
      name: 'get_usage_data',
      title: 'Get Usage Data',
      description: 'App-only tool for refreshing and filtering usage analytics in the UI.',
      inputSchema: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['24h', '7d', '30d', 'all'],
          },
          model: { type: 'string' },
          workspace: { type: 'string' },
          search: { type: 'string' },
        },
      },
      _meta: {
        ui: {
          visibility: ['app'],
        },
      },
    },
    {
      name: 'get_live_quota',
      title: 'Check Live Quota',
      description:
        'Run the official local Antigravity CLI (`agy --print /usage --output-format json`) with zero tokens consumed to fetch current 5-hour and weekly model quota usage percentages and reset times.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'get_usage_summary',
      title: 'Get Usage Summary',
      description:
        'Return a text summary of local Antigravity token usage, KV-cache hit rate, model breakdown, and historical session counts.',
      inputSchema: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            enum: ['24h', '7d', '30d', 'all'],
            description: 'Time window filter (default: 30d).',
          },
          model: {
            type: 'string',
            description: 'Optional model ID filter.',
          },
          workspace: {
            type: 'string',
            description: 'Optional workspace name filter.',
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'open_usage_dashboard' || name === 'get_usage_data') {
    const data = await collectUsageAnalytics({
      range: args?.range || '30d',
      model: args?.model || 'all',
      workspace: args?.workspace || 'all',
      search: args?.search || '',
    });
    const quota = getCachedQuota();
    if (quota) {
      data.quota = quota;
    }
    const text = formatUsageTextSummary(data);
    return {
      content: [{ type: 'text', text }],
      structuredContent: data,
    };
  }

  if (name === 'get_live_quota') {
    const quota = await fetchLiveQuota();
    return {
      content: [{ type: 'text', text: formatQuotaTextSummary(quota) }],
      structuredContent: quota,
    };
  }

  if (name === 'get_usage_summary') {
    const data = await collectUsageAnalytics({
      range: args?.range || '30d',
      model: args?.model || 'all',
      workspace: args?.workspace || 'all',
    });
    return {
      content: [{ type: 'text', text: formatUsageTextSummary(data) }],
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
