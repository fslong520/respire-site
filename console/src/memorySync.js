import { api } from './api.js';
import { normalizeApiBase } from './config.js';
import { openMemoryCache } from './memoryCache.js';

// One controller owns one unlocked session. Cancellation prevents old sessions
// from rendering data or advancing a cache cursor after a lock/account change.
export class MemorySync {
  constructor({ token, vault, isCurrent, onBlobs, onReset, onLoading, onCacheError }) {
    this.token = token;
    this.vault = JSON.stringify([vault.version, vault.kdf_salt, vault.wrapped_urk, vault.urk_nonce]);
    this.onBlobs = onBlobs;
    this.isCurrent = isCurrent;
    this.onReset = onReset;
    this.onLoading = onLoading;
    this.onCacheError = onCacheError;
    this.abort = new AbortController();
    this.cache = null;
    this.pending = null;
    this.trailing = false;
  }

  call(path) { return api(path, { token: this.token, signal: this.abort.signal }); }

  current() {
    if (!this.isCurrent()) this.close();
    this.abort.signal.throwIfAborted();
  }

  async cached(action) {
    const cache = this.cache;
    if (!cache) return null;
    try { return await action(cache); }
    catch (error) {
      cache.close();
      if (this.cache === cache) this.cache = null;
      if (!this.abort.signal.aborted) this.onCacheError(error);
      return null;
    }
  }

  start() {
    this.pending = this.initialize().then(() => this.drain()).finally(() => {
      this.pending = null;
      if (!this.abort.signal.aborted) this.onLoading(false);
    });
    return this.pending;
  }

  async initialize() {
    this.onLoading(true);
    const [identity, capabilities] = await Promise.all([
      this.call('/api/self'), this.call('/v2/capabilities'),
    ]);
    this.current();
    this.scope = JSON.stringify([normalizeApiBase(import.meta.env?.VITE_API_BASE_URL), identity.user]);
    this.state = { epoch: capabilities.epoch, cursor: 0, until: null, snapshot: true, vault: this.vault };
    try { this.cache = await openMemoryCache(); }
    catch (error) { if (!this.abort.signal.aborted) this.onCacheError(error); }
    if (this.abort.signal.aborted) { this.cache?.close(); this.current(); }
    const saved = await this.cached(cache => cache.read(this.scope));
    this.current();
    if (saved && saved.metadata.epoch === this.state.epoch && saved.metadata.vault === this.vault) {
      this.state = saved.metadata;
      await this.onBlobs(saved.blobs, this.abort.signal);
    } else {
      await this.cached(cache => cache.clear(this.scope));
      this.current();
      this.onReset();
    }
  }

  sync() {
    this.current();
    if (this.pending) { this.trailing = true; return this.pending; }
    this.onLoading(true);
    this.pending = this.drain().finally(() => {
      this.pending = null;
      if (!this.abort.signal.aborted) this.onLoading(false);
    });
    return this.pending;
  }

  async drain() {
    // Recover exactly once from a restored database/invalid persisted cursor.
    let restarted = false;
    do {
      this.trailing = false;
      try { await this.pages(); }
      catch (error) {
        this.current();
        if (error.status !== 409 || error.body?.code !== 'snapshot_required' || restarted) throw error;
        restarted = true;
        const capabilities = await this.call('/v2/capabilities');
        this.current();
        await this.cached(cache => cache.clear(this.scope));
        this.current();
        this.state = { epoch: capabilities.epoch, cursor: 0, until: null, snapshot: true, vault: this.vault };
        this.onReset();
        this.trailing = true;
      }
    } while (this.trailing);
  }

  async pages() {
    const wasSnapshot = this.state.snapshot;
    let more;
    do {
      this.current();
      const { epoch, cursor, until, snapshot } = this.state;
      const params = new URLSearchParams({ epoch, after: String(cursor), snapshot: snapshot ? '1' : '0' });
      if (until !== null) params.set('until', String(until));
      const page = await this.call(`/api/self/memories?${params}`);
      this.current();
      if (page.epoch !== epoch || !Number.isSafeInteger(page.cursor) || page.cursor < cursor
        || !Number.isSafeInteger(page.until) || page.until < page.cursor
        || (until !== null && page.until !== until) || (page.has_more && page.cursor === cursor)) {
        throw new Error('Invalid memory page cursor');
      }
      await this.onBlobs(page.blobs, this.abort.signal);
      this.current();
      more = page.has_more;
      const next = { epoch, cursor: page.cursor, until: more ? page.until : null,
        snapshot: more && snapshot, vault: this.vault };
      await this.cached(cache => cache.write(this.scope, next, page.blobs, this.abort.signal));
      this.current();
      this.state = next;
    } while (more);
    // Changes written while the initial snapshot was downloading follow its bound.
    if (wasSnapshot) this.trailing = true;
  }

  close() {
    this.abort.abort();
    this.cache?.close();
    this.cache = null;
  }
}
