# Blackwell DB Architecture

Blackwell DB is an embedded, local-first database. The app imports the database engine directly, and the user's computer handles reads, writes, indexing, query filtering, persistence, and compaction. There is no backend process to deploy for normal storage.

## What "No Server" Means

- The database engine runs inside the app process.
- Node, Electron, Tauri, and desktop apps can persist through `FileAdapter`.
- Browser apps can persist through `IndexedDBAdapter`.
- App data remains usable offline because local storage is the source of truth.
- A network is optional. Export/import, LAN, WebRTC, or a custom peer layer can sync data later, but the database does not require a cloud backend to function.

## Storage Model

Blackwell DB writes an append-only log:

1. A write becomes a small JSON operation.
2. The adapter appends that operation to durable local storage.
3. The in-memory collection and indexes update immediately after the append succeeds.
4. On restart, the log replays into memory.
5. `compact()` replaces the log with a snapshot to keep startup fast.

This is the same broad shape used by many high-throughput embedded systems: sequential writes first, indexed reads after.

## Query Model

Collections store JSON documents by `id`. Secondary indexes are declared per collection:

```js
await db.ensureCollection("users", {
  indexes: ["email", "plan", "profile.city"]
});
```

Equality queries use indexed candidate sets when possible:

```js
await db.collection("users").find({
  where: { email: "ada@example.com" }
});
```

Range queries use sorted index keys:

```js
await db.collection("users").range("createdAt", {
  gte: 1770000000000,
  limit: 100
});
```

## Performance Strategy

- Append-only writes avoid random disk writes.
- Transactions batch many operations into one durable log entry.
- Hot data and indexes stay in memory for fast local reads.
- Snapshots keep replay cost bounded.
- Adapters keep the core independent from Node, browser, or native shell runtimes.

## Encrypted User Data and Company Controls

Secure collections store private user data as an AES-GCM encrypted envelope. The database log contains ciphertext, IV, and authenticated metadata, not the plaintext payload.

The company/admin side gets an operations-only view:

- suspend
- unsuspend
- lock
- unlock
- flag and unflag
- add admin notes
- mark for deletion
- restore
- update non-sensitive company metadata

The company view is intentionally limited to operational metadata and reports `companyAccessPercent: 7.5`. It does not expose `private`, `encryptedPrivate`, or plaintext private fields. This models the "company can only touch the small control layer" rule while keeping the user's actual payload encrypted at rest.

Important boundary: encryption protects stored data from casual inspection and from company-control code that does not hold the key. Any process that has the encryption key can decrypt the private payload, so apps should store and release that key carefully.

Secure collections also support optional 5FA gates for private payload reads. When enabled, apps must verify exactly five configured factors inside a short challenge window before `getPrivate()` succeeds.

## Truthful Boundary

Blackwell DB can make the backend unnecessary for local reads and writes. Multi-device internet sync cannot be 100 percent magic without some path for peers to find each other. That path can be a local network, removable file, WebRTC rendezvous, or a tiny relay. The database itself remains serverless; sync is an optional layer above it.

## Optional AI Backend Routing

Blackwell DB also includes an optional AI backend hub for apps that want model calls near local data workflows. It supports pluggable backends, per-backend request timeouts, input size limits, and sensitive-context key rejection before a request is sent. HTTP backends default to HTTPS-only endpoints.
