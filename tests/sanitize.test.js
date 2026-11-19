import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeInputSchema, sanitizeTool } from '../src/sanitize.js';

// ---------------------------------------------------------------------------
// Rule 1: array items
// ---------------------------------------------------------------------------

test('array 缺少 items 时补 {type:"string"}，并保留 description 等字段', () => {
  const schema = {
    type: 'object',
    properties: {
      tags: { type: 'array', description: '标签列表', title: 'Tags' },
    },
  };

  const out = sanitizeInputSchema(schema);

  assert.deepEqual(out.properties.tags.items, { type: 'string' });
  assert.equal(out.properties.tags.description, '标签列表');
  assert.equal(out.properties.tags.title, 'Tags');
});

test('嵌套 anyOf 分支内的 array 也递归补 items', () => {
  const schema = {
    anyOf: [
      { type: 'array' },
      {
        type: 'object',
        properties: {
          nested: { type: 'array', items: undefined },
          deep: { type: 'array', properties: { inner: { type: 'array' } } },
        },
      },
    ],
  };

  const out = sanitizeInputSchema(schema);

  assert.deepEqual(out.anyOf[0].items, { type: 'string' });
  assert.deepEqual(out.anyOf[1].properties.nested.items, { type: 'string' });
  assert.deepEqual(
    out.anyOf[1].properties.deep.properties.inner.items,
    { type: 'string' },
  );
});

test('已存在的 items 被保留并继续递归（不被覆盖成 string）', () => {
  const schema = {
    type: 'array',
    items: { type: 'object', properties: { list: { type: 'array' } } },
  };

  const out = sanitizeInputSchema(schema);

  assert.equal(out.items.type, 'object');
  assert.deepEqual(out.items.properties.list.items, { type: 'string' });
});

// ---------------------------------------------------------------------------
// Rule 2: multi-type collapse
// ---------------------------------------------------------------------------

test('多类型收敛为第一个非 null 类型', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: ['string', 'null'] },
      b: { type: ['null', 'integer', 'string'] },
      c: { type: ['null'] },
    },
  };

  const out = sanitizeInputSchema(schema);

  assert.equal(out.properties.a.type, 'string');
  assert.equal(out.properties.b.type, 'integer');
  assert.equal(out.properties.c.type, 'null');
});

// ---------------------------------------------------------------------------
// Rule 4: IDs stay strings
// ---------------------------------------------------------------------------

test('ID 字段保持 string，不新增 number 类型', () => {
  const schema = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'int64', description: '长数字 ID' },
      maybeId: { type: ['string', 'null'] },
    },
  };

  const out = sanitizeInputSchema(schema);

  assert.equal(out.properties.id.type, 'string');
  assert.equal(out.properties.maybeId.type, 'string');
  assert.ok(!JSON.stringify(out).includes('"number"'));
});

// ---------------------------------------------------------------------------
// Rule 3: branch truncation
// ---------------------------------------------------------------------------

test('oneOf 超过 8 个分支被截断到 8，并在 description 追加提示', () => {
  const branches = Array.from({ length: 10 }, (_, i) => ({
    type: 'string',
    enum: [`v${i}`],
  }));
  const schema = { oneOf: branches, description: 'base' };

  const out = sanitizeInputSchema(schema);

  assert.equal(out.oneOf.length, 8);
  assert.deepEqual(out.oneOf[7], { type: 'string', enum: ['v7'] });
  assert.match(out.description, /base/);
  assert.match(out.description, /oneOf/);
  assert.match(out.description, /10/);
  assert.match(out.description, /8/);
});

test('anyOf 超过 8 个分支同样截断并加提示；<=8 不动', () => {
  const many = { anyOf: Array.from({ length: 9 }, () => ({ type: 'string' })) };
  const outMany = sanitizeInputSchema(many);
  assert.equal(outMany.anyOf.length, 8);
  assert.match(outMany.description, /anyOf/);
  assert.match(outMany.description, /9/);

  const few = { anyOf: Array.from({ length: 8 }, () => ({ type: 'string' })) };
  const outFew = sanitizeInputSchema(few);
  assert.equal(outFew.anyOf.length, 8);
  assert.equal(outFew.description, undefined);
});

// ---------------------------------------------------------------------------
// Rule 5: tool name cleaning
// ---------------------------------------------------------------------------

test('工具名非法字符替换为 _，合法字符保留', () => {
  const out = sanitizeTool({
    name: 'github/get file:issues??',
    inputSchema: { type: 'object' },
  });

  assert.equal(out.name, 'github_get_file_issues__');
  assert.match(out.name, /^[a-zA-Z0-9_-]+$/);
});

test('工具名超 63 字符截断', () => {
  const out = sanitizeTool({ name: 'a'.repeat(70), inputSchema: { type: 'object' } });
  assert.equal(out.name.length, 63);
  assert.equal(out.name, 'a'.repeat(63));
});

// ---------------------------------------------------------------------------
// Rule 6: annotations
// ---------------------------------------------------------------------------

test('annotations 缺失时显式补默认值', () => {
  const out = sanitizeTool({ name: 'x', inputSchema: { type: 'object' } });

  assert.deepEqual(out.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
});

test('调用方传入的 annotations 覆盖默认值，其他默认仍保留', () => {
  const out = sanitizeTool({
    name: 'y',
    inputSchema: { type: 'object' },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      title: '自定义',
    },
  });

  assert.equal(out.annotations.readOnlyHint, true);
  assert.equal(out.annotations.destructiveHint, false);
  assert.equal(out.annotations.openWorldHint, true);
  assert.equal(out.annotations.title, '自定义');
});

// ---------------------------------------------------------------------------
// Rule 7: no mutation + shape
// ---------------------------------------------------------------------------

test('sanitizeInputSchema 不修改入参对象（深拷贝）', () => {
  const schema = {
    type: 'object',
    description: 'root',
    properties: {
      a: { type: ['string', 'null'] },
      list: { type: 'array' },
    },
    anyOf: [{ type: 'array' }, { type: 'string' }],
  };
  const snapshot = structuredClone(schema);

  const out = sanitizeInputSchema(schema);

  assert.deepEqual(schema, snapshot, '入参对象未被改动');
  assert.notStrictEqual(out, schema, '返回的是新对象');
  assert.notStrictEqual(out.properties, schema.properties, '嵌套对象也是新对象');
});

test('sanitizeTool 不修改入参对象，且返回固定四字段结构', () => {
  const tool = {
    name: 'x/y',
    description: 'desc',
    inputSchema: {
      type: 'object',
      properties: { list: { type: 'array' }, id: { type: ['string', 'null'] } },
    },
    annotations: { readOnlyHint: true },
  };
  const snapshot = structuredClone(tool);

  const out = sanitizeTool(tool);

  assert.deepEqual(tool, snapshot, '入参对象未被改动');
  assert.deepEqual(Object.keys(out).sort(), [
    'annotations',
    'description',
    'inputSchema',
    'name',
  ]);
  assert.equal(out.description, 'desc');
  assert.deepEqual(out.inputSchema.properties.list.items, { type: 'string' });
  assert.equal(out.inputSchema.properties.id.type, 'string');
  assert.equal(out.annotations.readOnlyHint, true);
});

test('sanitizeTool 在 inputSchema 缺失时给出安全的默认对象', () => {
  const out = sanitizeTool({ name: 'bare' });
  assert.deepEqual(out.inputSchema, { type: 'object', properties: {} });
  assert.equal(out.name, 'bare');
});
