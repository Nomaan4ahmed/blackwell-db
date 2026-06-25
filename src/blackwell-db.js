import { MemoryAdapter } from "./adapters/memory-adapter.js";

const SNAPSHOT_VERSION = 1;

export async function openBlackwellDB(options = {}) {
  const db = new BlackwellDB(options);
  await db.open();
  return db;
}

export class BlackwellDB {
  constructor(options = {}) {
    this.adapter = options.adapter ?? new MemoryAdapter();
    this.clock = options.clock ?? (() => Date.now());
    this.idFactory = options.idFactory ?? createId;
    this.collections = new Map();
    this.listeners = new Map();
    this.writeQueue = Promise.resolve();
    this.opened = false;
    this.opening = null;
  }

  async open() {
    if (this.opened) return this;
    if (this.opening) return this.opening;

    this.opening = (async () => {
      if (typeof this.adapter.open === "function") {
        await this.adapter.open();
      }

      const entries = await this.adapter.readLog();
      for (const entry of entries) {
        this.applyEntry(entry, { replay: true });
      }

      this.opened = true;
      return this;
    })();

    return this.opening;
  }

  async close() {
    await this.writeQueue;
    if (typeof this.adapter.close === "function") {
      await this.adapter.close();
    }
    this.opened = false;
    this.opening = null;
  }

  collection(name) {
    assertCollectionName(name);
    return new BlackwellCollection(this, name);
  }

  async ensureCollection(name, options = {}) {
    assertCollectionName(name);
    await this.ready();

    const indexes = normalizeIndexes(options.indexes);
    const state = this.collections.get(name);
    const missing = state
      ? indexes.filter((field) => !state.indexes.has(field))
      : indexes;

    if (!state || missing.length > 0) {
      await this.commit({
        type: "schema",
        collection: name,
        indexes
      });
    }

    return this.collection(name);
  }

  async put(collection, doc, id = undefined) {
    assertPlainObject(doc, "doc");
    await this.ready();
    this.ensureCollectionState(collection);

    const documentId = String(id ?? doc.id ?? this.idFactory());
    const nextDoc = clone({ ...doc, id: documentId });

    await this.commit({
      type: "put",
      collection,
      id: documentId,
      doc: nextDoc
    });

    return clone(nextDoc);
  }

  async update(collection, id, patchOrUpdater) {
    await this.ready();
    const current = await this.get(collection, id);
    if (!current) return undefined;

    const patch =
      typeof patchOrUpdater === "function"
        ? await patchOrUpdater(clone(current))
        : patchOrUpdater;

    assertPlainObject(patch, "patch");
    return this.put(collection, { ...current, ...patch, id: String(id) }, id);
  }

  async delete(collection, id) {
    await this.ready();
    const state = this.collections.get(collection);
    if (!state || !state.docs.has(String(id))) return false;

    await this.commit({
      type: "delete",
      collection,
      id: String(id)
    });

    return true;
  }

  async clear(collection) {
    await this.ready();
    this.ensureCollectionState(collection);
    await this.commit({
      type: "clear",
      collection
    });
  }

  async get(collection, id) {
    await this.ready();
    const state = this.collections.get(collection);
    if (!state) return undefined;
    return clone(state.docs.get(String(id)));
  }

  async count(collection, query = {}) {
    const rows = await this.find(collection, { ...query, limit: undefined });
    return rows.length;
  }

  async find(collection, query = {}) {
    await this.ready();
    const state = this.collections.get(collection);
    if (!state) return [];

    const where = query.where ?? {};
    const ids = this.candidateIds(state, where);
    const rows = [];
    const docs = ids
      ? Array.from(ids, (id) => state.docs.get(id)).filter(Boolean)
      : Array.from(state.docs.values());

    for (const doc of docs) {
      if (matchesWhere(doc, where)) {
        rows.push(clone(doc));
      }
    }

    applySort(rows, query.sort ?? query.sortBy);

    const offset = query.offset ?? 0;
    const limit = query.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async range(collection, field, bounds = {}) {
    await this.ready();
    const state = this.collections.get(collection);
    if (!state) return [];

    const index = state.indexes.get(field);
    const candidateIds = index?.range(bounds);
    const rows = [];
    const source = candidateIds
      ? Array.from(candidateIds, (id) => state.docs.get(id)).filter(Boolean)
      : Array.from(state.docs.values()).filter((doc) => inBounds(readField(doc, field), bounds));

    for (const doc of source) {
      rows.push(clone(doc));
    }

    rows.sort((a, b) => compareValues(readField(a, field), readField(b, field)));

    if (bounds.desc === true) rows.reverse();
    return rows.slice(0, bounds.limit ?? rows.length);
  }

  async transaction(callback) {
    await this.ready();

    const ops = [];
    const tx = {
      put: (collection, doc, id = undefined) => {
        assertPlainObject(doc, "doc");
        const documentId = String(id ?? doc.id ?? this.idFactory());
        ops.push({
          type: "put",
          collection,
          id: documentId,
          doc: clone({ ...doc, id: documentId })
        });
        return documentId;
      },
      delete: (collection, id) => {
        ops.push({
          type: "delete",
          collection,
          id: String(id)
        });
      },
      clear: (collection) => {
        ops.push({
          type: "clear",
          collection
        });
      }
    };

    const result = await callback(tx);
    if (ops.length === 0) return result;

    const schemaOps = [];
    for (const collection of new Set(ops.map((op) => op.collection))) {
      if (!this.collections.has(collection)) {
        schemaOps.push({ type: "schema", collection, indexes: [] });
      }
    }

    await this.commit({
      type: "batch",
      ops: [...schemaOps, ...ops]
    });

    return result;
  }

  subscribe(collection, listener) {
    assertCollectionName(collection);
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function");
    }

    let listeners = this.listeners.get(collection);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(collection, listeners);
    }

    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async compact() {
    await this.ready();
    const snapshot = this.createSnapshotEntry();

    await this.enqueue(async () => {
      await this.adapter.replace([snapshot]);
    });
  }

  async exportJSON() {
    await this.ready();
    return clone(this.createSnapshotEntry().data);
  }

  async importJSON(data) {
    await this.ready();
    const snapshot = {
      type: "snapshot",
      version: SNAPSHOT_VERSION,
      ts: this.clock(),
      data: clone(data)
    };

    await this.enqueue(async () => {
      await this.adapter.replace([snapshot]);
      this.applyEntry(snapshot);
      this.emitChange("*", { type: "import" });
    });
  }

  async ready() {
    if (!this.opened) {
      await this.open();
    }
  }

  async commit(entry) {
    await this.enqueue(async () => {
      const stamped = {
        ...entry,
        version: SNAPSHOT_VERSION,
        ts: this.clock()
      };
      await this.adapter.append(stamped);
      this.applyEntry(stamped);
      this.emitFromEntry(stamped);
    });
  }

  async enqueue(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  ensureCollectionState(name, indexes = []) {
    assertCollectionName(name);
    let state = this.collections.get(name);
    if (!state) {
      state = {
        docs: new Map(),
        indexes: new Map()
      };
      this.collections.set(name, state);
    }

    for (const field of normalizeIndexes(indexes)) {
      if (!state.indexes.has(field)) {
        const index = new FieldIndex(field);
        for (const [id, doc] of state.docs) {
          index.add(id, doc);
        }
        state.indexes.set(field, index);
      }
    }

    return state;
  }

  candidateIds(state, where) {
    for (const [field, condition] of Object.entries(where)) {
      const index = state.indexes.get(field);
      if (!index) continue;

      if (isOperatorObject(condition)) {
        if (Object.hasOwn(condition, "$eq")) {
          return index.lookup(condition.$eq);
        }
        if (Object.hasOwn(condition, "$in") && Array.isArray(condition.$in)) {
          const ids = new Set();
          for (const value of condition.$in) {
            for (const id of index.lookup(value)) ids.add(id);
          }
          return ids;
        }
      } else {
        return index.lookup(condition);
      }
    }

    return undefined;
  }

  applyEntry(entry) {
    if (!entry || typeof entry !== "object") return;

    if (entry.type === "snapshot") {
      this.applySnapshot(entry.data);
      return;
    }

    if (entry.type === "batch") {
      for (const op of entry.ops ?? []) {
        this.applyOperation(op);
      }
      return;
    }

    this.applyOperation(entry);
  }

  applyOperation(op) {
    switch (op.type) {
      case "schema": {
        this.ensureCollectionState(op.collection, op.indexes);
        break;
      }
      case "put": {
        const state = this.ensureCollectionState(op.collection);
        const id = String(op.id);
        const oldDoc = state.docs.get(id);
        if (oldDoc) {
          for (const index of state.indexes.values()) {
            index.remove(id, oldDoc);
          }
        }

        const nextDoc = clone({ ...op.doc, id });
        state.docs.set(id, nextDoc);
        for (const index of state.indexes.values()) {
          index.add(id, nextDoc);
        }
        break;
      }
      case "delete": {
        const state = this.collections.get(op.collection);
        if (!state) break;

        const id = String(op.id);
        const oldDoc = state.docs.get(id);
        if (!oldDoc) break;

        for (const index of state.indexes.values()) {
          index.remove(id, oldDoc);
        }
        state.docs.delete(id);
        break;
      }
      case "clear": {
        const state = this.collections.get(op.collection);
        if (!state) break;

        state.docs.clear();
        for (const index of state.indexes.values()) {
          index.clear();
        }
        break;
      }
      default:
        throw new Error(`Unknown Blackwell DB operation: ${op.type}`);
    }
  }

  applySnapshot(data) {
    this.collections.clear();

    for (const [name, collection] of Object.entries(data?.collections ?? {})) {
      const state = this.ensureCollectionState(name, collection.indexes ?? []);
      for (const doc of collection.docs ?? []) {
        const id = String(doc.id);
        const nextDoc = clone(doc);
        state.docs.set(id, nextDoc);
      }

      for (const index of state.indexes.values()) {
        index.clear();
        for (const [id, doc] of state.docs) {
          index.add(id, doc);
        }
      }
    }
  }

  createSnapshotEntry() {
    const collections = {};

    for (const [name, state] of this.collections) {
      collections[name] = {
        indexes: Array.from(state.indexes.keys()),
        docs: Array.from(state.docs.values(), clone)
      };
    }

    return {
      type: "snapshot",
      version: SNAPSHOT_VERSION,
      ts: this.clock(),
      data: {
        version: SNAPSHOT_VERSION,
        collections
      }
    };
  }

  emitFromEntry(entry) {
    if (entry.type === "batch") {
      for (const op of entry.ops ?? []) {
        this.emitFromEntry(op);
      }
      return;
    }

    if (entry.collection) {
      this.emitChange(entry.collection, entry);
    }
  }

  emitChange(collection, change) {
    const listeners = [
      ...(this.listeners.get(collection) ?? []),
      ...(this.listeners.get("*") ?? [])
    ];

    for (const listener of listeners) {
      queueMicrotask(() => listener(clone(change)));
    }
  }
}

export class BlackwellCollection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  ensure(options = {}) {
    return this.db.ensureCollection(this.name, options);
  }

  put(doc, id = undefined) {
    return this.db.put(this.name, doc, id);
  }

  update(id, patchOrUpdater) {
    return this.db.update(this.name, id, patchOrUpdater);
  }

  delete(id) {
    return this.db.delete(this.name, id);
  }

  clear() {
    return this.db.clear(this.name);
  }

  get(id) {
    return this.db.get(this.name, id);
  }

  find(query = {}) {
    return this.db.find(this.name, query);
  }

  range(field, bounds = {}) {
    return this.db.range(this.name, field, bounds);
  }

  count(query = {}) {
    return this.db.count(this.name, query);
  }

  subscribe(listener) {
    return this.db.subscribe(this.name, listener);
  }
}

class FieldIndex {
  constructor(field) {
    this.field = field;
    this.values = new Map();
    this.sortedKeys = [];
  }

  add(id, doc) {
    const value = readField(doc, this.field);
    const key = indexKey(value);
    if (key === undefined) return;

    let bucket = this.values.get(key);
    if (!bucket) {
      bucket = {
        value: clone(value),
        ids: new Set()
      };
      this.values.set(key, bucket);
      this.sortedKeys.splice(this.findInsertIndex(value, key), 0, key);
    }

    bucket.ids.add(id);
  }

  remove(id, doc) {
    const value = readField(doc, this.field);
    const key = indexKey(value);
    if (key === undefined) return;

    const bucket = this.values.get(key);
    if (!bucket) return;

    bucket.ids.delete(id);
    if (bucket.ids.size === 0) {
      this.values.delete(key);
      const sortedIndex = this.sortedKeys.indexOf(key);
      if (sortedIndex >= 0) this.sortedKeys.splice(sortedIndex, 1);
    }
  }

  clear() {
    this.values.clear();
    this.sortedKeys.length = 0;
  }

  lookup(value) {
    const bucket = this.values.get(indexKey(value));
    return new Set(bucket?.ids ?? []);
  }

  range(bounds = {}) {
    const ids = new Set();

    for (const key of this.sortedKeys) {
      const bucket = this.values.get(key);
      if (!bucket) continue;
      if (!inBounds(bucket.value, bounds)) continue;

      for (const id of bucket.ids) {
        ids.add(id);
        if (bounds.limit && ids.size >= bounds.limit) return ids;
      }
    }

    return ids;
  }

  findInsertIndex(value, key) {
    let low = 0;
    let high = this.sortedKeys.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      const midKey = this.sortedKeys[mid];
      const midBucket = this.values.get(midKey);
      const order = compareValues(midBucket?.value, value) || midKey.localeCompare(key);
      if (order < 0) low = mid + 1;
      else high = mid;
    }

    return low;
  }
}

function normalizeIndexes(indexes = []) {
  return Array.from(new Set(indexes.map((field) => {
    if (typeof field !== "string" || field.trim() === "") {
      throw new TypeError("index fields must be non-empty strings");
    }
    return field.trim();
  })));
}

function assertCollectionName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
    throw new TypeError("collection name must contain only letters, numbers, _, ., :, or -");
  }
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function createId() {
  const random = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function readField(doc, path) {
  let value = doc;
  for (const part of path.split(".")) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

function indexKey(value) {
  if (value === undefined) return undefined;
  return `${typeof value}:${JSON.stringify(value)}`;
}

function isOperatorObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith("$"))
  );
}

function matchesWhere(doc, where) {
  for (const [field, condition] of Object.entries(where)) {
    const actual = readField(doc, field);
    if (isOperatorObject(condition)) {
      if (!matchesOperators(actual, condition)) return false;
    } else if (!Object.is(actual, condition)) {
      return false;
    }
  }

  return true;
}

function matchesOperators(actual, condition) {
  for (const [operator, expected] of Object.entries(condition)) {
    switch (operator) {
      case "$eq":
        if (!Object.is(actual, expected)) return false;
        break;
      case "$ne":
        if (Object.is(actual, expected)) return false;
        break;
      case "$gt":
        if (!(compareValues(actual, expected) > 0)) return false;
        break;
      case "$gte":
        if (!(compareValues(actual, expected) >= 0)) return false;
        break;
      case "$lt":
        if (!(compareValues(actual, expected) < 0)) return false;
        break;
      case "$lte":
        if (!(compareValues(actual, expected) <= 0)) return false;
        break;
      case "$in":
        if (!Array.isArray(expected) || !expected.some((value) => Object.is(value, actual))) {
          return false;
        }
        break;
      case "$contains":
        if (Array.isArray(actual)) {
          if (!actual.includes(expected)) return false;
        } else if (typeof actual === "string") {
          if (!actual.includes(String(expected))) return false;
        } else {
          return false;
        }
        break;
      case "$startsWith":
        if (typeof actual !== "string" || !actual.startsWith(String(expected))) return false;
        break;
      default:
        throw new Error(`Unsupported query operator: ${operator}`);
    }
  }

  return true;
}

function inBounds(value, bounds) {
  if (Object.hasOwn(bounds, "gt") && !(compareValues(value, bounds.gt) > 0)) return false;
  if (Object.hasOwn(bounds, "gte") && !(compareValues(value, bounds.gte) >= 0)) return false;
  if (Object.hasOwn(bounds, "lt") && !(compareValues(value, bounds.lt) < 0)) return false;
  if (Object.hasOwn(bounds, "lte") && !(compareValues(value, bounds.lte) <= 0)) return false;
  return true;
}

function applySort(rows, sort) {
  if (!sort) return;

  const field = typeof sort === "string" ? sort : sort.field;
  const dir = typeof sort === "object" && sort.dir === "desc" ? -1 : 1;
  if (!field) return;

  rows.sort((a, b) => dir * compareValues(readField(a, field), readField(b, field)));
}

function compareValues(a, b) {
  if (Object.is(a, b)) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (a === null) return -1;
  if (b === null) return 1;

  if (typeof a === typeof b) {
    if (typeof a === "number" || typeof a === "bigint") return a < b ? -1 : 1;
    if (typeof a === "string") return a < b ? -1 : 1;
    if (typeof a === "boolean") return Number(a) - Number(b);
  }

  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : 1;
}
