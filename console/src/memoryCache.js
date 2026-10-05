// Persist only ciphertext and the cursor committed with it, never keys or plaintext.
const DATABASE = 'respire-memory-ciphertext-v1';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Memory cache transaction aborted'));
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function openMemoryCache() {
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore('metadata', { keyPath: 'scope' });
    const records = db.createObjectStore('records', { keyPath: ['scope', 'id'] });
    records.createIndex('scope', 'scope');
  };
  const db = await requestResult(request);
  db.onversionchange = () => db.close();
  return {
    async read(scope) {
      const tx = db.transaction(['metadata', 'records'], 'readonly');
      const done = finished(tx);
      const [metadata, blobs] = await Promise.all([
        requestResult(tx.objectStore('metadata').get(scope)),
        requestResult(tx.objectStore('records').index('scope').getAll(scope)),
        done,
      ]);
      return metadata ? { metadata, blobs } : null;
    },
    async clear(scope) {
      const tx = db.transaction(['metadata', 'records'], 'readwrite');
      const done = finished(tx);
      tx.objectStore('metadata').delete(scope);
      const records = tx.objectStore('records');
      const cursor = records.index('scope').openKeyCursor(IDBKeyRange.only(scope));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        records.delete(row.primaryKey);
        row.continue();
      };
      await done;
    },
    async write(scope, metadata, blobs, signal) {
      const tx = db.transaction(['metadata', 'records'], 'readwrite');
      const done = finished(tx);
      const cancel = () => tx.abort();
      signal.addEventListener('abort', cancel, { once: true });
      const records = tx.objectStore('records');
      for (const blob of blobs) {
        if (blob.deleted) records.delete([scope, blob.id]);
        else records.put({ scope, id: blob.id, ciphertext: blob.ciphertext,
          nonce: blob.nonce, updated_at: blob.updated_at, deleted: false });
      }
      tx.objectStore('metadata').put({ scope, ...metadata });
      try { await done; }
      finally { signal.removeEventListener('abort', cancel); }
    },
    close() { db.close(); },
  };
}
