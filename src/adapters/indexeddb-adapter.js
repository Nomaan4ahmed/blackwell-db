export class IndexedDBAdapter {
  constructor(options = {}) {
    this.name = options.name ?? "blackwell-db";
    this.storeName = options.storeName ?? "log";
    this.db = null;
  }

  async open() {
    if (this.db) return;
    if (typeof indexedDB === "undefined") {
      throw new Error("IndexedDBAdapter can only run in a browser or IndexedDB-compatible runtime");
    }

    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: "seq", autoIncrement: true });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async readLog() {
    await this.open();
    return this.withStore("readonly", (store) => requestToPromise(store.getAll()))
      .then((rows) => rows.map((row) => row.entry));
  }

  async append(entry) {
    await this.open();
    await this.withStore("readwrite", (store) => requestToPromise(store.add({ entry })));
  }

  async appendMany(entries) {
    await this.open();
    if (entries.length === 0) return;

    await this.withStore("readwrite", async (store) => {
      for (const entry of entries) {
        await requestToPromise(store.add({ entry }));
      }
    });
  }

  async replace(entries) {
    await this.open();
    await this.withStore("readwrite", async (store) => {
      await requestToPromise(store.clear());
      for (const entry of entries) {
        await requestToPromise(store.add({ entry }));
      }
    });
  }

  async close() {
    this.db?.close();
    this.db = null;
  }

  withStore(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, mode);
      const store = tx.objectStore(this.storeName);
      let result;

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);

      Promise.resolve(work(store))
        .then((value) => {
          result = value;
        })
        .catch((error) => {
          tx.abort();
          reject(error);
        });
    });
  }
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
