import test from 'node:test';
import assert from 'node:assert/strict';
import { runInSandbox } from '../src/codemode.js';

async function evalCode(code) {
  const out = await runInSandbox({ code: `async () => { ${code} }`, tools: [], callTool: async () => ({}) });
  assert.ok(!out.isError, out.result);
  return JSON.parse(out.result);
}

test('fileResult flattens text/resources and keeps sha/size/path metadata', async () => {
  const result = await evalCode(`
    return {
      fromText: codemode.fileResult({ text: 'hello', resources: [{ text: 'hello' }] }),
      fromContent: codemode.fileResult({ content: 'abc', sha: 'deadbeef', size: 3, path: 'a.txt' }),
      fromResult: codemode.fileResult({ result: { content: 'xyz', sha: 's' } }),
      plain: codemode.fileResult('raw'),
      marker: codemode.fileResult({ content: 'a--- TRUNCATED --- 10 chars total' }),
    };
  `);
  assert.equal(result.fromText.content, 'hello');
  assert.equal(result.fromText.size, 5);
  assert.equal(result.fromContent.sha, 'deadbeef');
  assert.equal(result.fromContent.path, 'a.txt');
  assert.equal(result.fromResult.content, 'xyz');
  assert.equal(result.plain.content, 'raw');
  assert.equal(result.marker.truncated, true);
});

test('prResult flattens number/url/sha from common PR shapes', async () => {
  const result = await evalCode(`
    return {
      gh: codemode.prResult({ number: 12, html_url: 'https://github.com/a/b/pull/12', sha: 'abc' }),
      viaResult: codemode.prResult({ result: { number: 7, url: 'https://example/pull/7', head: { sha: 'def' } } }),
      urlOnly: codemode.prResult({ url: 'https://github.com/a/b/pull/99' }),
      empty: codemode.prResult({}),
    };
  `);
  assert.equal(result.gh.number, 12);
  assert.equal(result.gh.url, 'https://github.com/a/b/pull/12');
  assert.equal(result.gh.sha, 'abc');
  assert.equal(result.viaResult.number, 7);
  assert.equal(result.urlOnly.number, 99);
  assert.equal(result.empty.number, null);
});

test('canonical helpers never throw on hostile shapes', async () => {
  const result = await evalCode(`
    const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
    return {
      file: codemode.fileResult(hostile),
      pr: codemode.prResult(hostile),
    };
  `);
  assert.equal(result.file.content, null);
  assert.equal(result.pr.number, null);
});
