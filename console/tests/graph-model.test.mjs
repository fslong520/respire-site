import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGraph } from '../src/graphModel.js';

const mem = (id, parent_id = '', extra = {}) => ({ id, parent_id, title: `mem ${id}`, kind: 'context', importance: 'important', ...extra });

test('keeps every non-trivial memory as a node and links real parent-child pairs', () => {
  const { nodes, links } = buildGraph([mem('a'), mem('b', 'a'), mem('c', 'a')]);
  assert.deepEqual(nodes.map((n) => n.id).sort(), ['a', 'b', 'c']);
  assert.deepEqual(links, [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }]);
  assert.equal(nodes.find((n) => n.id === 'a').kind, 'context');
});

test('filters trivial diary entries from nodes and edges', () => {
  const { nodes, links, subtreeSizes } = buildGraph([
    mem('a'),
    mem('d1', 'a', { importance: 'trivial' }),
    mem('b', 'd1', { importance: 'trivial' }),
  ]);
  assert.deepEqual(nodes.map((n) => n.id), ['a']);
  assert.deepEqual(links, []);
  assert.equal(subtreeSizes.get('a'), 1);
});

test('a dangling parent_id leaves the node root-level without an edge', () => {
  const { nodes, links } = buildGraph([mem('a', 'ghost')]);
  assert.deepEqual(nodes.map((n) => n.id), ['a']);
  assert.deepEqual(links, []);
});

test('subtreeSizes counts each node plus all descendants', () => {
  const { subtreeSizes } = buildGraph([
    mem('root'),
    mem('left', 'root'), mem('right', 'root'),
    mem('leaf', 'left'),
  ]);
  assert.equal(subtreeSizes.get('root'), 4);
  assert.equal(subtreeSizes.get('left'), 2);
  assert.equal(subtreeSizes.get('right'), 1);
  assert.equal(subtreeSizes.get('leaf'), 1);
});

test('an empty vault yields an empty model', () => {
  const { nodes, links, subtreeSizes } = buildGraph([]);
  assert.deepEqual(nodes, []);
  assert.deepEqual(links, []);
  assert.equal(subtreeSizes.size, 0);
});


test('cycle members count the same unique reachable nodes including attached trees', () => {
  const rows = [
    mem('a', 'c'), mem('b', 'a'), mem('c', 'b'),
    mem('branch', 'a'), mem('leaf', 'branch'), mem('other-leaf', 'b'),
    mem('unrelated'),
  ];
  for (const input of [rows, [...rows].reverse()]) {
    const { links, subtreeSizes } = buildGraph(input);
    for (const id of ['a', 'b', 'c']) assert.equal(subtreeSizes.get(id), 6);
    assert.equal(subtreeSizes.get('branch'), 2);
    assert.equal(subtreeSizes.get('leaf'), 1);
    assert.equal(subtreeSizes.get('other-leaf'), 1);
    assert.equal(subtreeSizes.get('unrelated'), 1);
    assert.equal(links.length, 6);
    assert.ok(links.some(({ source, target }) => source === 'c' && target === 'a'));
  }
});

test('self-parentage preserves its edge and counts attached descendants once', () => {
  const { links, subtreeSizes } = buildGraph([mem('a', 'a'), mem('b', 'a'), mem('c', 'b')]);
  assert.deepEqual(links, [
    { source: 'a', target: 'a' }, { source: 'a', target: 'b' }, { source: 'b', target: 'c' },
  ]);
  assert.deepEqual([...subtreeSizes], [['a', 3], ['b', 2], ['c', 1]]);
});

test('disjoint cycles retain independent reachability counts', () => {
  const { subtreeSizes } = buildGraph([
    mem('a', 'b'), mem('b', 'a'), mem('c', 'a'),
    mem('d', 'e'), mem('e', 'd'), mem('f'),
  ]);
  assert.deepEqual([...subtreeSizes], [['a', 3], ['b', 3], ['c', 1], ['d', 2], ['e', 2], ['f', 1]]);
});

test('duplicate and malformed IDs cannot inflate nodes, edges or subtree sizes', () => {
  const { nodes, links, subtreeSizes } = buildGraph([
    null, undefined, {}, mem(''), mem('   '), mem({}), mem(false), mem(NaN), mem(Infinity),
    mem('root'), mem('child', 'root'), mem('child', 'child'), mem('root', 'child'),
    mem('filtered', '', { importance: 'trivial' }), mem('filtered', 'root'),
  ]);
  assert.deepEqual(nodes.map(({ id }) => id), ['root', 'child', 'filtered']);
  assert.deepEqual(links, [{ source: 'root', target: 'child' }, { source: 'root', target: 'filtered' }]);
  assert.deepEqual([...subtreeSizes], [['root', 3], ['child', 1], ['filtered', 1]]);
});

test('numeric zero remains a valid node and parent ID using DOM-compatible string keys', () => {
  const { nodes, links, subtreeSizes } = buildGraph([mem(0, undefined, { title: '' }), mem(1, 0)]);
  assert.equal(nodes[0].title, '0');
  assert.deepEqual(nodes.map(({ id }) => id), ['0', '1']);
  assert.deepEqual(links, [{ source: '0', target: '1' }]);
  assert.equal(subtreeSizes.get('0'), 2);
  assert.equal(subtreeSizes.get('1'), 1);
});

test('numeric IDs and equivalent strings deduplicate before linking and counting', () => {
  for (const rootId of [0, '0']) {
    const duplicateRootId = typeof rootId === 'number' ? '0' : 0;
    const rows = [
      mem(rootId, '', { title: 'First root' }), mem(duplicateRootId, '1'),
      mem('1', 0, { title: 'First child' }), mem(1, '1'), mem(2, '1'),
    ];
    const { nodes, links, subtreeSizes } = buildGraph(rows);
    assert.deepEqual(nodes.map(({ id, title }) => ({ id, title })), [
      { id: '0', title: 'First root' }, { id: '1', title: 'First child' }, { id: '2', title: 'mem 2' },
    ]);
    assert.deepEqual(links, [{ source: '0', target: '1' }, { source: '1', target: '2' }]);
    assert.deepEqual([...subtreeSizes], [['0', 3], ['1', 2], ['2', 1]]);
    assert.equal(rows[0].id, rootId); // Normalization must not mutate the input.
    assert.equal(rows[2].parent_id, 0);
    assert.equal(rows[4].id, 2);
  }
});

test('mixed numeric and string cycle IDs use a single canonical lookup identity', () => {
  const { nodes, links, subtreeSizes } = buildGraph([
    mem(0, '1'), mem('1', '0'), mem(2, 1), mem(3, '3'),
  ]);
  assert.deepEqual(nodes.map(({ id }) => id), ['0', '1', '2', '3']);
  assert.deepEqual(links, [
    { source: '1', target: '0' }, { source: '0', target: '1' },
    { source: '1', target: '2' }, { source: '3', target: '3' },
  ]);
  assert.deepEqual([...subtreeSizes], [['0', 3], ['1', 3], ['2', 1], ['3', 1]]);
});

test('missing or non-array input yields an empty graph', () => {
  for (const input of [undefined, null, {}, 'invalid']) {
    assert.deepEqual(buildGraph(input), { nodes: [], links: [], subtreeSizes: new Map() });
  }
});

test('a 10,000-node parent chain is counted without recursion', () => {
  const count = 10_000;
  const rows = Array.from({ length: count }, (_, i) => mem(`node-${i}`, i ? `node-${i - 1}` : ''));
  const { nodes, links, subtreeSizes } = buildGraph(rows);
  assert.equal(nodes.length, count);
  assert.equal(links.length, count - 1);
  for (let i = 0; i < count; i += 1) assert.equal(subtreeSizes.get(`node-${i}`), count - i);
});

test('a 10,000-node cycle counts each reachable node exactly once', () => {
  const count = 10_000;
  const rows = Array.from({ length: count }, (_, i) => mem(`node-${i}`, `node-${(i + 1) % count}`));
  const { nodes, links, subtreeSizes } = buildGraph(rows);
  assert.equal(nodes.length, count);
  assert.equal(links.length, count);
  for (const { id } of nodes) assert.equal(subtreeSizes.get(id), count);
});
