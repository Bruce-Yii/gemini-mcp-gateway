import test from 'node:test';
import assert from 'node:assert/strict';

import { searchEntries } from '../src/catalog.js';

const entry = (server, tool, description = '') => ({
  server,
  tool,
  name: `${server}__${tool}`,
  description,
});

const tools = [
  entry('github', 'create_branch', 'Create a new branch in a repository.'),
  entry('github', 'issue_write', 'Create a new issue in a repository.'),
  entry('figma', 'create_new_file', 'Create a new blank Figma file.'),
  entry('figma', 'create_branch', 'Create a branch in a Figma file.'),
  entry('vercel', 'list_deployments', 'List deployments for a project.'),
  entry('notion', 'notion-get-suggested-edit', 'Suggest edits for a Notion page.'),
  entry('notion', 'notion-get-comments', 'Get comments from a Notion page.'),
];

test('service alias repository/repo scopes ambiguous "create branch" to GitHub', () => {
  const result = searchEntries(tools, 'Create a new branch in the repository octocat/Hello-World.', { limit: 5 });
  assert.equal(result.matches[0].name, 'github__create_branch');
});

test('service alias deployment scopes ambiguous list query to Vercel', () => {
  const result = searchEntries(tools, 'List the deployments for this project.', { limit: 5 });
  assert.equal(result.matches[0].server, 'vercel');
});

test('per-server index keeps an existing service rank stable when another service grows', () => {
  const notionOnly = [
    entry('notion', 'notion-get-suggested-edit', 'Suggest edits for a Notion page.'),
    entry('notion', 'notion-get-comments', 'Get comments from a Notion page.'),
    entry('notion', 'notion-fetch', 'Fetch a Notion page.'),
  ];
  const before = searchEntries(notionOnly, 'Notion comments suggest edits for the launch proposal', { limit: 5 });
  const grown = [...notionOnly];
  for (let i = 0; i < 50; i += 1) grown.push(entry('figma', `figma_tool_${i}`, 'Create a new file and comments and edits.'));
  const after = searchEntries(grown, 'Notion comments suggest edits for the launch proposal', { limit: 5 });
  const beforeRank = before.matches.findIndex((match) => match.name === 'notion__notion-get-suggested-edit');
  const afterRank = after.matches.findIndex((match) => match.name === 'notion__notion-get-suggested-edit');
  assert.equal(afterRank, beforeRank);
});

test('no strong alias means no hard filter (generic file query can still hit Figma)', () => {
  const result = searchEntries(tools, 'Create a new blank Figma file.', { limit: 5 });
  assert.equal(result.matches[0].name, 'figma__create_new_file');
});
