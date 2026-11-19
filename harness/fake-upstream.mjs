#!/usr/bin/env node
/**
 * fake-upstream.mjs - deterministic stdio MCP upstream fixture.
 *
 * Exposes six GitHub/Notion-style tools used by tests/server.test.js and
 * scripts/smoke.mjs. Every response is predictable JSON text, so no network,
 * credentials, or real services are involved.
 *
 * IMPORTANT: `github__search_code` deliberately advertises an `array` property
 * without `items`. This lets the integration test verify that the gateway runs
 * sanitizeTool() on the schemas it registers.
 *
 * The tool list is served through the underlying Server of a McpServer so the
 * raw JSON Schema is advertised verbatim (a Zod round-trip would silently add
 * `items` and hide the fixture's deliberate defect).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const SERVER_INFO = { name: 'fake-upstream', version: '1.0.0' };

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });

/** @type {Array<{name:string, description:string, inputSchema:object}>} */
const TOOLS = [
  {
    name: 'github__get_file_contents',
    description: 'Read a file or directory listing from a GitHub repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Repository owner'),
        repo: str('Repository name'),
        path: str('Path inside the repository'),
        ref: str('Branch, tag or commit SHA'),
      },
      required: ['owner', 'repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'github__list_issues',
    description: 'List issues in a GitHub repository filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Repository owner'),
        repo: str('Repository name'),
        state: str('Issue state filter', { enum: ['open', 'closed', 'all'] }),
        limit: int('Maximum issues to return', { minimum: 1, maximum: 100 }),
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'github__search_code',
    description: 'Search code across GitHub repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Code search query'),
        // Deliberately missing `items` - gateway sanitizeTool() must add it.
        filters: { type: 'array', description: 'Optional filters (intentionally missing items)' },
        language: str('Programming language filter'),
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'github__create_issue',
    description: 'WRITE OPERATION: create a GitHub issue (excluded from the gateway whitelist).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('Repository owner'),
        repo: str('Repository name'),
        title: str('Issue title'),
        body: str('Issue body'),
        draft: bool('Create as draft'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'notion__notion-search',
    description: 'Search Notion pages and databases by title or text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: str('Search query'),
        filter: str('Result type filter', { enum: ['page', 'database'] }),
        pageSize: int('Maximum results', { minimum: 1, maximum: 100 }),
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'notion__notion-fetch',
    description: 'Fetch a Notion page or database by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Notion page or database id'),
        includeContent: bool('Include the body content'),
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function toolResult(name, args) {
  const separator = name.indexOf('__');
  const server = separator === -1 ? name : name.slice(0, separator);
  const tool = separator === -1 ? name : name.slice(separator + 2);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          fixture: 'fake-upstream',
          server,
          tool,
          arguments: args ?? {},
        }),
      },
    ],
  };
}

const mcpServer = new McpServer(SERVER_INFO, {
  instructions: 'Deterministic fake upstream for gemini-mcp-gateway tests.',
});
const server = mcpServer.server;
server.registerCapabilities({ tools: { listChanged: false } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params ?? {};
  if (!TOOL_NAMES.has(name)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `unknown tool: ${name}` }) }],
      isError: true,
    };
  }
  return toolResult(name, args ?? {});
});

await mcpServer.connect(new StdioServerTransport());
