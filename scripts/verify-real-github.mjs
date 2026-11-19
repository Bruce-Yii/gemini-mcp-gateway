#!/usr/bin/env node
/**
 * Local end-to-end verification against the REAL GitHub remote MCP.
 *
 * Token source (in priority order):
 *   1. GITHUB_TOKEN env var
 *   2. CC Switch's Copilot token at ~/.cc-switch/copilot_auth.json
 *      (the `ghu_` OAuth token already used by api.githubcopilot.com)
 *
 * The token is injected only into process.env and never printed or written to
 * any file. Set GITHUB_MCP_READONLY=0 to use the read/write endpoint instead.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpstreamManager } from '../src/upstreams.js';

function loadTokenFromCcSwitch() {
  const file = path.join(os.homedir(), '.cc-switch', 'copilot_auth.json');
  if (!fs.existsSync(file)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const account of Object.values(data.accounts ?? {})) {
      if (typeof account?.github_token === 'string' && account.github_token) {
        return account.github_token;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function main() {
  const token = process.env.GITHUB_TOKEN || loadTokenFromCcSwitch();
  if (!token) {
    console.error('[verify-real-github] no token: set GITHUB_TOKEN or log into CC Switch');
    process.exitCode = 2;
    return;
  }
  process.env.GITHUB_TOKEN = token;

  const readonly = process.env.GITHUB_MCP_READONLY !== '0';
  const url = readonly
    ? 'https://api.githubcopilot.com/mcp/readonly'
    : 'https://api.githubcopilot.com/mcp/';

  const mgr = new UpstreamManager([
    {
      name: 'github',
      transport: 'http',
      url,
      tokenEnv: 'GITHUB_TOKEN',
      allowTools: [
        'get_file_contents',
        'list_issues',
        'search_code',
        'search_repositories',
        'list_branches',
        'get_issue',
      ],
    },
  ]);

  try {
    await mgr.connect();
    const whitelist = mgr.getWhitelist();
    console.log(`[verify-real-github] endpoint: ${url}`);
    console.log(`[verify-real-github] whitelist (${whitelist.length}): ${whitelist.map((e) => e.name).join(', ')}`);
    const result = await mgr.callTool('github', 'search_repositories', { query: 'octocat' });
    const text = result?.content?.[0]?.text ?? JSON.stringify(result);
    const parsed = JSON.parse(text);
    console.log(`[verify-real-github] search_repositories total_count=${parsed.total_count}`);
    console.log('[verify-real-github] OK');
  } catch (error) {
    console.error(`[verify-real-github] FAILED: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mgr.close();
  }
}

main();
