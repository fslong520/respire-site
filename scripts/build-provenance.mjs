import { execFileSync } from 'node:child_process';

/** Record the actual checkout; a provider SHA must agree, never override it. */
export function buildProvenance(cwd, env = process.env) {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error('An exact Site checkout revision is required');
  if (env.CF_PAGES_COMMIT_SHA !== undefined && (!/^[0-9a-f]{40}$/.test(env.CF_PAGES_COMMIT_SHA) || env.CF_PAGES_COMMIT_SHA !== revision)) {
    throw new Error('CF_PAGES_COMMIT_SHA must be a full SHA matching the actual Site checkout');
  }
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd, encoding: 'utf8' }).trim());
  return { site_revision: revision, source_tree_dirty: dirty };
}
