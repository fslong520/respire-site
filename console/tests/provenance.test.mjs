import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProvenance } from '../../scripts/build-provenance.mjs';

test('frontend provenance uses the actual checkout and validates provider SHAs', () => {
  const actual = buildProvenance(process.cwd(), {});
  assert.match(actual.site_revision, /^[0-9a-f]{40}$/);
  assert.equal(typeof actual.source_tree_dirty, 'boolean');
  assert.deepEqual(buildProvenance(process.cwd(), { CF_PAGES_COMMIT_SHA: actual.site_revision }), actual);
  for (const sha of ['main', 'not-a-commit', '0'.repeat(40), actual.site_revision.slice(0, 7)]) {
    assert.throws(() => buildProvenance(process.cwd(), { CF_PAGES_COMMIT_SHA: sha }), /matching the actual Site checkout/);
  }
});
