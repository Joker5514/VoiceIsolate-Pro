/**
 * VoiceIsolate Pro v9.0 - IndexedDB Wrapper
 *
 * Provides a Promise-based interface over IndexedDB for persistent
 * storage of models, voiceprints, settings, audit logs, and cached audio.
 *
 * Object stores (created on first open / version upgrade):
 *   - models       : cached ML model binaries
 *   - voiceprints  : encrypted speaker voiceprint data
 *   - settings     : application settings and preferences
 *   - auditLog     : forensic audit log entries
 *   - audioCache   : temporary audio processing cache
 */

const DB_VERSION = 1;

const STORE_NAMES = Object.freeze([
  'models',
  'voiceprints',
  'settings',
  'auditLog',
  'audioCache',
]);

class VoiceIsolateDB {
  /** @type {string} */
  #dbName;

  /** @type {IDBDatabase | null} */
  #db = null;

  /** @type {Promise<IDBDatabase> | null} */
  #openPromise = null;

  /**
   * @param {string} [dbName='voiceisolate-pro']
   */
  constructor(dbName = 'voiceisolate-pro') {
    this.#dbName = dbName;
  }

  // ---------------------------------------------------------------------------
  // Connection lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open (or create) the database.
   *
   * Safe to call multiple times -- subsequent calls return the same
   * connection promise until `close()` is called.
   *
   * @returns {Promise<IDBDatabase>}
   */
  async open() {
    // Return existing connection if available.
    if (this.#db) return this.#db;

    // Deduplicate concurrent open() calls.
    if (this.#openPromise) return this.#openPromise;

    this.#openPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }

      const request = indexedDB.open(this.#dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = /** @type {IDBOpenDBRequest} */ (event.target).result;
        const existingStores = Array.from(db.objectStoreNames);

        for (const storeName of STORE_NAMES) {
          if (!existingStores.includes(storeName)) {
            db.createObjectStore(storeName);
          }
        }
      };

      request.onsuccess = (event) => {
        this.#db = /** @type {IDBOpenDBRequest} */ (event.target).result;

        // Handle unexpected database close (e.g. browser storage eviction).
        this.#db.onclose = () => {
          this.#db = null;
          this.#openPromise = null;
        };

        // Handle version change from another tab.
        this.#db.onversionchange = () => {
          if (this.#db) {
            this.#db.close();
            this.#db = null;
            this.#openPromise = null;
          }
        };

        resolve(this.#db);
      };

      request.onerror = (event) => {
        this.#openPromise = null;
        reject(new Error(`Failed to open IndexedDB "${this.#dbName}": ${request.error?.message || 'unknown error'}`));
      };

      request.onblocked = () => {
        console.warn(`[VoiceIsolateDB] Database "${this.#dbName}" open blocked -- close other tabs using this database`);
      };
    });

    return this.#openPromise;
  }

  /**
   * Close the database connection.
   */
  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
    this.#openPromise = null;
  }

  // ---------------------------------------------------------------------------
  // CRUD operations
  // ---------------------------------------------------------------------------

  /**
   * Store a value under the given key in the specified object store.
   *
   * @param {string} storeName  One of STORE_NAMES.
   * @param {string} key
   * @param {*}      value      Any structured-cloneable value.
   * @returns {Promise<void>}
   */
  async put(storeName, key, value) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.put(value, key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(
          `put("${storeName}", "${key}") failed: ${request.error?.message || 'unknown'}`,
        ));

        tx.onerror = () => reject(new Error(
          `Transaction error on put("${storeName}", "${key}"): ${tx.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Retrieve a value by key from the specified object store.
   *
   * @param {string} storeName
   * @param {string} key
   * @returns {Promise<*>} The stored value, or `undefined` if not found.
   */
  async get(storeName, key) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(key);

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(
          `get("${storeName}", "${key}") failed: ${request.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Delete a value by key from the specified object store.
   *
   * @param {string} storeName
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(storeName, key) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.delete(key);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(
          `delete("${storeName}", "${key}") failed: ${request.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Retrieve all entries from an object store.
   *
   * Returns an array of `{ key, value }` objects.
   *
   * @param {string} storeName
   * @returns {Promise<Array<{ key: string, value: * }>>}
   */
  async getAll(storeName) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);

        const results = [];
        const cursorRequest = store.openCursor();

        cursorRequest.onsuccess = (event) => {
          const cursor = /** @type {IDBRequest<IDBCursorWithValue>} */ (event.target).result;
          if (cursor) {
            results.push({ key: /** @type {string} */ (cursor.key), value: cursor.value });
            cursor.continue();
          } else {
            resolve(results);
          }
        };

        cursorRequest.onerror = () => reject(new Error(
          `getAll("${storeName}") failed: ${cursorRequest.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Clear all entries from an object store.
   *
   * @param {string} storeName
   * @returns {Promise<void>}
   */
  async clear(storeName) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const request = store.clear();

        request.onsuccess = () => resolve();
        request.onerror = () => reject(new Error(
          `clear("${storeName}") failed: ${request.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Approximate the total stored size for an object store in bytes.
   *
   * IndexedDB does not natively expose per-store size.  This method
   * iterates all entries and sums the byte length of ArrayBuffers and
   * the JSON-serialised size of other values.  It is an *estimate* --
   * actual on-disk usage may differ due to IndexedDB overhead.
   *
   * @param {string} storeName
   * @returns {Promise<number>} Approximate size in bytes.
   */
  async getSize(storeName) {
    const db = await this.#ensureOpen();
    this.#validateStore(storeName);

    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);

        let totalSize = 0;
        const cursorRequest = store.openCursor();

        cursorRequest.onsuccess = (event) => {
          const cursor = /** @type {IDBRequest<IDBCursorWithValue>} */ (event.target).result;
          if (cursor) {
            totalSize += this.#estimateValueSize(cursor.value);
            cursor.continue();
          } else {
            resolve(totalSize);
          }
        };

        cursorRequest.onerror = () => reject(new Error(
          `getSize("${storeName}") failed: ${cursorRequest.error?.message || 'unknown'}`,
        ));
      } catch (err) {
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Ensure the database is open, opening it if necessary.
   * @returns {Promise<IDBDatabase>}
   */
  async #ensureOpen() {
    if (this.#db) return this.#db;
    return this.open();
  }

  /**
   * Validate that a store name is recognised.
   * @param {string} storeName
   */
  #validateStore(storeName) {
    if (!STORE_NAMES.includes(storeName)) {
      throw new Error(
        `Unknown object store "${storeName}". ` +
          `Valid stores: ${STORE_NAMES.join(', ')}`,
      );
    }
  }

  /**
   * Rough byte-size estimate for a stored value.
   * @param {*} value
   * @returns {number}
   */
  #estimateValueSize(value) {
    if (value === null || value === undefined) return 0;

    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }

    if (ArrayBuffer.isView(value)) {
      return value.byteLength;
    }

    if (value instanceof Blob) {
      return value.size;
    }

    // For objects, recursively check for ArrayBuffer properties and
    // fall back to JSON serialisation length.
    if (typeof value === 'object') {
      let size = 0;

      for (const key of Object.keys(value)) {
        const v = value[key];
        if (v instanceof ArrayBuffer) {
          size += v.byteLength;
        } else if (ArrayBuffer.isView(v)) {
          size += v.byteLength;
        } else if (v instanceof Blob) {
          size += v.size;
        }
      }

      // If we found binary data, return that; otherwise approximate via JSON.
      if (size > 0) return size;

      try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
      } catch {
        return 0;
      }
    }

    if (typeof value === 'string') {
      return new TextEncoder().encode(value).byteLength;
    }

    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;

    return 0;
  }
}

export default VoiceIsolateDB;
