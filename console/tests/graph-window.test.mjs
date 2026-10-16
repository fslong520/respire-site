import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGraph } from '../src/graphModel.js';
import { graphWindow, GRAPH_PAGE_SIZE } from '../src/graphWindow.js';
const memories = n => Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(5, '0'), parent_id: i ? String(i - 1).padStart(5, '0') : '', title: `Synthetic ${i}` }));
test('10,000 memories have stable bounded pages without omissions or duplication', () => {
  const items = memories(10000), graph = buildGraph(items), reverse = buildGraph([...items].reverse());
  const seen = new Set();
  for (let page = 0; page < graphWindow(graph).pages; page++) {
    const window = graphWindow(graph, page);
    assert.ok(window.nodes.length <= GRAPH_PAGE_SIZE);
    assert.deepEqual(window.nodes, graphWindow(reverse, page).nodes);
    for (const node of window.nodes) { assert.ok(!seen.has(node.id)); seen.add(node.id); }
  }
  assert.equal(seen.size, items.length);
});
test('cross-page parent and child relations are explicit and retain global sizes', () => {
  const graph = buildGraph(memories(601));
  const first = graphWindow(graph), middle = graphWindow(graph, 1);
  assert.deepEqual(first.external.get('00299'), [{ id: '00300', direction: 'child' }]);
  assert.deepEqual(middle.external.get('00300'), [{ id: '00299', direction: 'parent' }]);
  assert.equal(first.subtreeSizes.get('00000'), 601);
  assert.equal(first.links.length, 299);
  assert.equal(graphWindow(graph, 999).page, 2);
  assert.equal(graphWindow(buildGraph([])).pages, 1);
});

test('a cross-page two-cycle retains both relationship directions', () => {
  const items = memories(301);
  items[0].parent_id = '00300'; items[300].parent_id = '00000';
  const window = graphWindow(buildGraph(items));
  assert.deepEqual(window.external.get('00000'), [
    { id: '00300', direction: 'parent' }, { id: '00300', direction: 'child' },
  ]);
});
