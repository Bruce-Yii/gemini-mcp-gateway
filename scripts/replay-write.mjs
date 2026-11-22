#!/usr/bin/env node
/**
 * Controlled real GitHub write replay (B10 end-to-end).
 *
 * Requires GITHUB_TOKEN in the environment and an explicit --yes. Creates a
 * throwaway branch, seeds a file, runs dryRun + real applyFilePatch, verifies
 * the patched body, then deletes the branch in finally. Never prints the token.
 *
 *   GITHUB_TOKEN=... node scripts/replay-write.mjs --yes
 */
import { UpstreamManager } from '../src/upstreams.js';
import { createCodeModeTools } from '../src/codemode.js';

const YES = process.argv.includes('--yes');
if (!YES) {
  console.error('refusing to write without --yes');
  process.exit(2);
}
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(2);
}
const owner = process.env.REPLAY_OWNER || 'Bruce-Yii';
const repo = process.env.REPLAY_REPO || 'gemini-mcp-gateway';
const branch = `codex/write-replay-${Date.now()}`;
const path = `work/write-replay-${Date.now()}.txt`;
const body = 'one\ntwo\nthree\n';

const config = {
  name: 'github', transport: 'http',
  url: 'https://api.githubcopilot.com/mcp/', tokenEnv: 'GITHUB_TOKEN',
  allowTools: [], denyTools: [],
};
const mgr = new UpstreamManager([config]);
let created = false;
try {
  process.env.GITHUB_TOKEN = token;
  await mgr.connect();
  const execute = createCodeModeTools(mgr).find((tool) => tool.name === 'execute');
  const code = `async () => {
    const owner=${JSON.stringify(owner)}, repo=${JSON.stringify(repo)}, branch=${JSON.stringify(branch)}, path=${JSON.stringify(path)};
    const created = await codemode.github__create_branch({owner,repo,branch,from_branch:'main'});
    const seed = await codemode.github__create_or_update_file({owner,repo,branch,path,content:${JSON.stringify(body)},message:'test: write replay seed'});
    const patch='@@ -2,1 +2,1 @@\\n-two\\n+TWO\\n';
    const dry = await codemode.applyFilePatch({owner,repo,path,branch,patch,dryRun:true});
    const real = await codemode.applyFilePatch({owner,repo,path,branch,patch,dryRun:false,message:'test: write replay patch'});
    return { created, seed, dry, real };
  }`;
  const out = await execute.handler({ code });
  const result = out?.result ?? out;
  if (!result?.real?.ok) throw new Error(`real patch failed: ${JSON.stringify(result?.real)}`);
  created = true;
  const headers = { authorization: `Bearer ${token}`, 'user-agent': 'dsh', accept: 'application/vnd.github+json' };
  const file = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`, { headers }).then((r) => r.json());
  const text = Buffer.from(file.content, 'base64').toString('utf8');
  if (text !== 'one\nTWO\nthree\n') throw new Error(`patched body mismatch: ${JSON.stringify(text)}`);
  console.log(JSON.stringify({ ok: true, branch, path, sha: result.real.sha, commitSha: result.real.commitSha, text }, null, 2));
} finally {
  try { await mgr.close(); } catch { /* ignore */ }
  if (created) {
    try {
      const headers = { authorization: `Bearer ${token}`, 'user-agent': 'dsh', accept: 'application/vnd.github+json' };
      await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'DELETE', headers });
      console.error(`[replay] cleanup deleted ${branch}`);
    } catch (error) {
      console.error(`[replay] cleanup failed for ${branch}: ${error?.message ?? error}`);
    }
  }
}
