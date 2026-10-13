// Trusted-browser mode deliberately stores only a nonexportable CryptoKey and
// public binding metadata. Recovery material, URKs, server wrappers, tokens and
// PRF output must never enter this database (or local/session storage).
const DB_NAME = 'respire-trusted-browser-v1';
const STORE = 'keys';
const EPOCHS = 'epochs';
const DOMAIN = 'respire:trusted-browser:key:v1';
const coordinators = new WeakMap();
const fail = (code, cause) => Object.assign(new Error(code), { code, ...(cause ? { cause } : {}) });
const aborted = () => new DOMException('Trusted-browser operation superseded', 'AbortError');
const unavailable = cause => fail('trustedBrowserStorageUnavailable', cause);
const invalid = () => fail('trustedBrowserKeyInvalid');
const errorCodes = new Set(['trustedBrowserStorageUnavailable', 'trustedBrowserKeyInvalid', 'trustedBrowserKeyExists', 'trustedCleanupFailed']);
const ownError = error => typeof error?.code === 'string' && errorCodes.has(error.code);
const storageError = error => error?.name === 'AbortError' || ownError(error) ? error : unavailable(error);
const text = value => new TextEncoder().encode(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function accountId(value) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}
function scopeOf(value) {
  const account_id = accountId(value?.account_id);
  if (typeof value?.rp_id !== 'string' || !value.rp_id || value.rp_id.length > 253
    || !/^[a-z0-9.-]+$/.test(value.rp_id)) throw invalid();
  return { account_id, rp_id: value.rp_id };
}
function generation(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}
function contextOf(value) {
  const scope = scopeOf(value);
  if (typeof value.device_id !== 'string' || !uuid.test(value.device_id)) throw invalid();
  return { ...scope, device_id: value.device_id, key_generation: generation(value.key_generation) };
}
function credentialId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > 65536) throw invalid();
  return value;
}
const idOf = context => JSON.stringify([DOMAIN, context.account_id, context.rp_id, context.device_id, context.key_generation]);
function validateKey(key) {
  if (key?.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'AES-GCM'
    || key.algorithm.length !== 256 || !Array.isArray(key.usages) || key.usages.length !== 2
    || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) throw invalid();
  return key;
}
function recordContext(record) {
  const context = contextOf(record);
  if (record.id !== idOf(context) || typeof record.active !== 'boolean'
    || (record.credential_id !== undefined && credentialId(record.credential_id) !== record.credential_id)
    || (record.active && record.credential_id === undefined)
    || typeof record.revision !== 'string' || !/^[0-9a-f]{32}$/.test(record.revision)) throw invalid();
  return context;
}
function publicRecord(record) {
  return { ...recordContext(record), active: record.active, revision: record.revision,
    ...(record.credential_id !== undefined ? { credential_id: record.credential_id } : {}) };
}
function coordinatorFor(indexedDB) {
  if (!indexedDB || (typeof indexedDB !== 'object' && typeof indexedDB !== 'function')) {
    return { epoch: 0, accounts: new Map(), records: new Map(), transactions: new Set(), clearOwner: null, blocked: false };
  }
  let coordinator = coordinators.get(indexedDB);
  if (!coordinator) {
    coordinator = { epoch: 0, accounts: new Map(), records: new Map(), transactions: new Set(), clearOwner: null, blocked: false };
    coordinators.set(indexedDB, coordinator);
  }
  return coordinator;
}

// Different store instances in one page share logout/revocation fences. These
// fences do not make CryptoKeys revocable; callers must also fence their own
// WebAuthn/network/crypto operations when locking, switching or signing out.
export function createTrustedKeyStore({ indexedDB = globalThis.indexedDB, crypto = globalThis.crypto, timeoutMs = 10000 } = {}) {
  const shared = coordinatorFor(indexedDB);
  const randomMarker = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const accountEpochId = account_id => `account:${JSON.stringify(account_id)}`;
  const accountFloorId = account_id => `account-floor:${JSON.stringify(account_id)}`;
  const floorId = scope => `floor:${JSON.stringify([scope.account_id, scope.rp_id])}`;
  let connection, opening, storageEpoch = 0, permanentlyUnavailable = false;
  const accountState = account_id => {
    let state = shared.accounts.get(account_id);
    if (!state) { state = { epoch: 0, clearOwner: null, blocked: false, minimumGeneration: 0, minimumGenerations: new Map() }; shared.accounts.set(account_id, state); }
    return state;
  };
  const abortTransactions = predicate => {
    for (const transaction of [...shared.transactions]) if (predicate(transaction)) transaction.cancel(aborted());
  };
  function fenceAccount(account_id) {
    accountId(account_id);
    accountState(account_id).epoch++;
    abortTransactions(transaction => transaction.account_id === account_id);
  }
  function fenceRecord(context) {
    const id = idOf(context);
    shared.records.set(id, (shared.records.get(id) || 0) + 1);
    abortTransactions(transaction => transaction.id === id);
  }
  function raiseGeneration(scope, currentGeneration) {
    const state = accountState(scope.account_id);
    state.minimumGenerations.set(scope.rp_id, Math.max(currentGeneration, state.minimumGenerations.get(scope.rp_id) || 0));
    abortTransactions(transaction => transaction.account_id === scope.account_id && transaction.rp_id === scope.rp_id
      && transaction.key_generation !== undefined && transaction.key_generation < currentGeneration);
  }
  function raiseAccountGeneration(account_id, currentGeneration) {
    const state = accountState(account_id);
    state.minimumGeneration = Math.max(currentGeneration, state.minimumGeneration);
    abortTransactions(transaction => transaction.account_id === account_id
      && transaction.key_generation !== undefined && transaction.key_generation < currentGeneration);
  }
  function operation(scope, options = {}, cleanupOwner) {
    const state = scope?.account_id ? accountState(scope.account_id) : null;
    const epoch = shared.epoch, accountEpoch = state?.epoch, localEpoch = storageEpoch;
    const id = scope?.device_id ? idOf(scope) : null, recordEpoch = id ? shared.records.get(id) || 0 : 0;
    const op = { ...scope, id, signal: options.signal, current(ignoreCancellation = false) {
      if ((!ignoreCancellation && (options.signal?.aborted || (options.isCurrent && !options.isCurrent()))) || epoch !== shared.epoch
        || localEpoch !== storageEpoch || (state && state.epoch !== accountEpoch)
        || (id && (shared.records.get(id) || 0) !== recordEpoch)
        || (scope?.key_generation && scope.key_generation < Math.max(state.minimumGeneration, state.minimumGenerations.get(scope.rp_id) || 0))) throw aborted();
      if (permanentlyUnavailable || (shared.blocked && shared.clearOwner !== cleanupOwner)
        || (state?.blocked && state.clearOwner !== cleanupOwner)) throw unavailable();
      if ((shared.clearOwner && shared.clearOwner !== cleanupOwner)
        || (state?.clearOwner && state.clearOwner !== cleanupOwner)) throw aborted();
    } };
    op.current();
    return op;
  }
  async function database() {
    if (permanentlyUnavailable) throw unavailable();
    if (connection) return connection;
    if (opening) return opening;
    if (!indexedDB?.open || !crypto?.subtle || !crypto?.getRandomValues) throw unavailable();
    const pending = new Promise((resolve, reject) => {
      let request, settled = false;
      const timer = setTimeout(() => finish(unavailable()), timeoutMs);
      const finish = (error, db) => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        if (error) reject(error); else { connection = db; resolve(db); }
      };
      try { request = indexedDB.open(DB_NAME, 1); }
      catch (error) { finish(unavailable(error)); return; }
      request.onblocked = () => finish(unavailable());
      request.onerror = () => finish(unavailable(request.error));
      const abortUpgrade = () => {
        try { request.transaction?.abort(); } catch { /* It may already have aborted or finished. */ }
      };
      request.onupgradeneeded = () => {
        if (settled) { abortUpgrade(); return; }
        try {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
          if (!request.result.objectStoreNames.contains(EPOCHS)) request.result.createObjectStore(EPOCHS, { keyPath: 'id' });
        } catch (error) { abortUpgrade(); finish(unavailable(error)); }
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => {
          // A schema change is a page-lifetime hard failure, never an implicit
          // recreation/reset of trust. Close so the other upgrade can proceed.
          permanentlyUnavailable = true; storageEpoch++; connection = null;
          abortTransactions(transaction => transaction.owner === owner);
          db.close();
        };
        db.onclose = () => {
          if (connection === db) {
            permanentlyUnavailable = true; storageEpoch++; connection = null;
            abortTransactions(transaction => transaction.owner === owner);
          }
        };
        finish(null, db);
      };
    });
    opening = pending;
    try { return await pending; }
    finally { if (opening === pending) opening = null; }
  }
  const owner = {};
  async function transaction(op, mode, body) {
    op.current();
    const db = await database();
    op.current();
    return new Promise((resolve, reject) => {
      let tx, result, settled = false, requestedError;
      const tracked = { ...op, owner, cancel(error) {
        // IDB methods may throw synchronously inside a request callback. DOM
        // exceptions have numeric legacy codes, not our public error codes.
        error = storageError(error);
        requestedError = error;
        try { tx?.abort(); } catch { /* Already complete; still reject stale use. */ }
        finish(error);
      } };
      const onAbort = () => tracked.cancel(aborted());
      const timer = setTimeout(() => tracked.cancel(unavailable()), timeoutMs);
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer); shared.transactions.delete(tracked);
        op.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve(result);
      };
      try {
        tx = db.transaction([STORE, EPOCHS], mode);
        shared.transactions.add(tracked);
        op.signal?.addEventListener('abort', onAbort, { once: true });
        tx.onabort = () => finish(requestedError || unavailable(tx.error));
        tx.onerror = () => tracked.cancel(requestedError || unavailable(tx.error));
        tx.oncomplete = () => { try { op.current(); finish(); } catch (error) { finish(error); } };
        op.current();
        // Epoch reads and the caller's writes share one IDB transaction. A
        // logout in another tab cannot slip between this check and insertion.
        const epochs = tx.objectStore(EPOCHS);
        const ids = ['global', ...(op.account_id ? [accountEpochId(op.account_id), accountFloorId(op.account_id)] : []),
          ...(op.rp_id ? [floorId(op)] : [])];
        const values = new Map();
        let remaining = ids.length;
        for (const id of ids) {
          const request = epochs.get(id);
          request.onsuccess = () => {
            try {
              values.set(id, request.result?.value);
              if (--remaining) return;
              const durable = ['global', ...(op.account_id ? [accountEpochId(op.account_id)] : [])].map(key => {
                const value = values.get(key) ?? '0';
                if (typeof value !== 'string' || (value !== '0' && !/^[0-9a-f]{32}$/.test(value))) throw invalid();
                return value;
              });
              const accountFloor = op.account_id ? values.get(accountFloorId(op.account_id)) ?? 0 : 0;
              const rpFloor = op.rp_id ? values.get(floorId(op)) ?? 0 : 0;
              if (!Number.isSafeInteger(accountFloor) || accountFloor < 0 || !Number.isSafeInteger(rpFloor) || rpFloor < 0) throw invalid();
              const floor = Math.max(accountFloor, rpFloor);
              if ((op.key_generation && op.key_generation < floor)
                || (op.durable && JSON.stringify(op.durable) !== JSON.stringify(durable))) throw aborted();
              op.durable = durable;
              op.current();
              body(tx.objectStore(STORE), value => { result = value; }, error => tracked.cancel(error), epochs, floor);
            } catch (error) { tracked.cancel(error); }
          };
        }
      } catch (error) { tracked.cancel(error); }
    });
  }
  const getRecord = (op, context) => transaction(op, 'readonly', (store, result) => {
    const request = store.get(idOf(context));
    request.onsuccess = () => result(request.result);
  });
  async function verifyRoundtrip(original, persisted, context, op) {
    validateKey(original); validateKey(persisted);
    const probe = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const parameters = { name: 'AES-GCM', iv: nonce, additionalData: text(idOf(context)), tagLength: 128 };
    let reopened;
    try {
      op.current();
      const ciphertext = await crypto.subtle.encrypt(parameters, original, probe);
      op.current();
      reopened = new Uint8Array(await crypto.subtle.decrypt(parameters, persisted, ciphertext));
      op.current();
      if (reopened.length !== probe.length || reopened.some((value, index) => value !== probe[index])) throw invalid();
    } catch (error) {
      if (error?.name === 'AbortError' || ownError(error)) throw error;
      throw invalid();
    } finally { probe.fill(0); reopened?.fill(0); }
  }
  async function create(value, options) {
    const context = contextOf(value), op = operation(context, options);
    if (!crypto?.subtle || !crypto?.getRandomValues) throw unavailable();
    const revision = randomMarker();
    const credential_id = value.credential_id === undefined ? undefined : credentialId(value.credential_id);
    let written = false;
    try {
      if (!crypto?.subtle) throw unavailable();
      await transaction(op, 'readonly', () => {});
      op.current();
      const key = validateKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
      op.current();
      await transaction(op, 'readwrite', (store, result, reject) => {
        const request = store.add({ id: idOf(context), ...context, active: false, revision, ...(credential_id ? { credential_id } : {}), key });
        request.onsuccess = () => { written = true; };
        request.onerror = () => reject(request.error?.name === 'ConstraintError' ? fail('trustedBrowserKeyExists') : unavailable(request.error));
      });
      op.current();
      // A separate committed read transaction must return the structured clone,
      // and that clone must decrypt a challenge made with the original key.
      const stored = await getRecord(op, context);
      if (!stored || idOf(recordContext(stored)) !== idOf(context)) throw invalid();
      await verifyRoundtrip(key, stored.key, context, op);
      await transaction(op, 'readonly', () => {});
      op.current();
      return stored.key;
    } catch (error) {
      if (written) {
        // Ignore the caller's aborted signal, but never cross logout/revocation
        // epochs. Their cleanup transaction owns deletion after such a fence.
        try {
          op.current(true);
          const cleanup = operation(context);
          cleanup.durable = op.durable;
          await transaction(cleanup, 'readwrite', (store, result, reject) => {
            const request = store.get(idOf(context));
            request.onsuccess = () => {
              try { if (request.result?.revision === revision) store.delete(idOf(context)); }
              catch (error) { reject(error); }
            };
          });
        } catch (cleanupError) {
          // A newer logout/revocation owns cleanup after an epoch change.
          // Other failures are actionable: callers must not claim local trust
          // was removed when IndexedDB did not confirm that transaction.
          if (cleanupError?.name !== 'AbortError') throw Object.assign(fail('trustedCleanupFailed', error), { cleanupCause: cleanupError });
        }
      }
      throw error;
    }
  }
  async function readLease(value, options) {
    const context = contextOf(value), op = operation(context, options);
    const expectedCredential = value.credential_id === undefined ? undefined : credentialId(value.credential_id);
    const stored = await getRecord(op, context);
    op.current();
    if (!stored) return null;
    if (idOf(recordContext(stored)) !== idOf(context)
      || (expectedCredential !== undefined && stored.credential_id !== expectedCredential)) throw invalid();
    await verifyRoundtrip(stored.key, stored.key, context, op);
    const assertCurrent = async () => {
      op.current();
      // Call immediately before delivering a decrypted result. Checking both
      // durable epochs and exact revision/existence closes the interval while
      // the caller was performing asynchronous unwrap/derivation operations.
      const present = await getRecord(op, context);
      op.current();
      if (!present || idOf(recordContext(present)) !== idOf(context) || present.revision !== stored.revision
        || present.credential_id !== stored.credential_id || present.active !== stored.active) throw aborted();
    };
    await assertCurrent();
    return Object.freeze({ key: stored.key, assertCurrent });
  }
  async function read(value, options) {
    return (await readLease(value, options))?.key ?? null;
  }
  function remove(value, options) {
    const context = contextOf(value);
    fenceRecord(context);
    return transaction(operation(context, options), 'readwrite', (store, result, reject, epochs) => {
      epochs.put({ id: accountEpochId(context.account_id), value: randomMarker() });
      store.delete(idOf(context));
    });
  }
  async function list(value, options) {
    const scope = scopeOf(value), op = operation(scope, options);
    return transaction(op, 'readonly', (store, result, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try { result(request.result.filter(record => record.account_id === scope.account_id && record.rp_id === scope.rp_id).map(publicRecord)); }
        catch (error) { reject(error); }
      };
    });
  }
  async function listAll(options) {
    const op = operation(null, options);
    return transaction(op, 'readonly', (store, result, reject) => {
      const request = store.getAll();
      request.onsuccess = () => {
        try { result(request.result.map(publicRecord)); }
        catch (error) { reject(error); }
      };
    });
  }
  async function markActive(value, credential, options) {
    const context = contextOf(value), op = operation(context, options), credential_id = credentialId(credential);
    await transaction(op, 'readwrite', (store, result, reject) => {
      const request = store.get(idOf(context));
      request.onsuccess = () => {
        try {
          op.current();
          const record = request.result;
          if (!record || idOf(recordContext(record)) !== idOf(context)
            || (record.credential_id !== undefined && record.credential_id !== credential_id)) throw invalid();
          validateKey(record.key);
          if (record.active && record.credential_id === credential_id) return;
          store.put({ id: idOf(context), ...context, key: record.key, active: true, credential_id, revision: randomMarker() });
        } catch (error) { reject(error); }
      };
    });
  }
  async function prune(value, currentGeneration, allowed, options, accountWide = false) {
    const scope = accountWide ? { account_id: accountId(value?.account_id) } : scopeOf(value);
    generation(currentGeneration);
    // Publish the floor before awaiting IndexedDB, so an old-generation create
    // still generating its CryptoKey cannot write after pruning has completed.
    const op = operation(scope, options);
    if (accountWide) raiseAccountGeneration(scope.account_id, currentGeneration);
    else raiseGeneration(scope, currentGeneration);
    return transaction(op, 'readwrite', (store, result, reject, epochs, floor) => {
      epochs.put({ id: accountWide ? accountFloorId(scope.account_id) : floorId(scope), value: Math.max(floor, currentGeneration) });
      const request = store.getAll();
      request.onsuccess = () => {
        try {
          op.current();
          for (const record of request.result) {
            if (record.account_id !== scope.account_id || (scope.rp_id && record.rp_id !== scope.rp_id)) continue;
            const context = recordContext(record);
            const revoked = allowed && context.key_generation === currentGeneration && record.active
              && !allowed.has(idOf(context)) && options?.observedRecords?.some(observed =>
                observed.active === true && observed.revision === record.revision && idOf(contextOf(observed)) === record.id);
            if (context.key_generation < currentGeneration || revoked) {
              fenceRecord(context); store.delete(record.id);
              // The generation floor already fences expired keys. Only a
              // same-generation revocation needs a new account epoch, so an
              // older-generation cleanup cannot disrupt a newer enrollment.
              if (revoked) epochs.put({ id: accountEpochId(scope.account_id), value: randomMarker() });
            }
          }
        } catch (error) { reject(error); }
      };
    });
  }
  function reconcile(value, allowedContexts, options) {
    const scope = scopeOf(value), currentGeneration = generation(value.key_generation);
    if (!Array.isArray(allowedContexts) || (options?.observedRecords !== undefined && !Array.isArray(options.observedRecords))) throw invalid();
    for (const observed of options?.observedRecords || []) {
      const context = contextOf(observed);
      if (context.account_id !== scope.account_id || context.rp_id !== scope.rp_id || typeof observed.active !== 'boolean'
        || typeof observed.revision !== 'string' || !/^[0-9a-f]{32}$/.test(observed.revision)) throw invalid();
    }
    const allowed = new Set(allowedContexts.map(item => {
      const context = contextOf(item);
      if (context.account_id !== scope.account_id || context.rp_id !== scope.rp_id || context.key_generation !== currentGeneration) throw invalid();
      return idOf(context);
    }));
    return prune(scope, currentGeneration, allowed, options);
  }
  function clearAccount(account_id) {
    accountId(account_id);
    fenceAccount(account_id);
    const state = accountState(account_id), clearOwner = {};
    state.clearOwner = clearOwner;
    return (async () => {
      try {
        const op = operation({ account_id }, {}, clearOwner);
        const cleanup = await transaction(op, 'readwrite', (store, result, reject, epochs) => {
          epochs.put({ id: accountEpochId(account_id), value: randomMarker() });
          const request = store.getAll();
          request.onsuccess = () => {
            try {
              let clearedRecords = 0;
              for (const record of request.result) if (record.account_id === account_id) {
                store.delete(record.id); clearedRecords++;
              }
              result({ clearedRecords });
            } catch (error) { reject(error); }
          };
        });
        if (state.clearOwner === clearOwner) state.blocked = false;
        return cleanup;
      } catch (error) { if (state.clearOwner === clearOwner) state.blocked = true; throw error; }
      finally { if (state.clearOwner === clearOwner) state.clearOwner = null; }
    })();
  }
  function clearAll() {
    shared.epoch++;
    abortTransactions(() => true);
    const clearOwner = {};
    shared.clearOwner = clearOwner;
    return (async () => {
      try {
        const cleanup = await transaction(operation(null, {}, clearOwner), 'readwrite', (store, result, reject, epochs) => {
          // Count and deletion are atomic with the fence. Even an empty store
          // gets a new epoch so an older in-flight enrollment cannot repopulate it.
          epochs.put({ id: 'global', value: randomMarker() });
          const request = store.count();
          request.onsuccess = () => {
            try {
              const clearedRecords = request.result;
              if (!Number.isSafeInteger(clearedRecords) || clearedRecords < 0) throw invalid();
              store.clear();
              result({ clearedRecords });
            } catch (error) { reject(error); }
          };
        });
        if (shared.clearOwner === clearOwner) {
          shared.blocked = false;
          for (const state of shared.accounts.values()) state.blocked = false;
        }
        return cleanup;
      } catch (error) { if (shared.clearOwner === clearOwner) shared.blocked = true; throw error; }
      finally { if (shared.clearOwner === clearOwner) shared.clearOwner = null; }
    })();
  }
  return Object.freeze({ create, read, readLease, remove, list, listAll, markActive, reconcile,
    clearOlderGenerations: (scope, currentGeneration, options) => prune(scope, currentGeneration, null, options),
    clearAccountOlderGenerations: (account_id, currentGeneration, options) => prune({ account_id }, currentGeneration, null, options, true),
    clearAccount, clearAll, fenceAccount });
}

export const trustedKeyStore = createTrustedKeyStore();
