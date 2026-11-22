# Tool snapshots

Committed `tools/list` snapshots, one file per upstream: `<server>.json`.

Format:

```json
{
  "server": "figma",
  "capturedAt": "2026-11-22T00:00:00.000Z",
  "source": "https://mcp.figma.com/mcp tools/list",
  "toolCount": 50,
  "tools": [{ "name": "...", "description": "...", "inputSchema": {}, "annotations": {} }]
}
```

Capture (requires a valid token in the configured `tokenEnv`; never commit the token):

```bash
node scripts/audit-tools.mjs --server figma --write-snapshot --sync-dataset
```

The snapshot is the reproducible evidence for `total/extras/denied`; a fresh
clone must be able to run `node scripts/audit-tools.mjs --server figma` without
credentials.
