# Blackwell DB

Blackwell DB is a small embedded database prototype for local-first apps. It makes the user's own computer the database host: no backend server is required for normal reads, writes, indexing, persistence, or offline use.

## Install

This workspace version has no production dependencies:

```bash
npm install
```

## Node/Desktop Usage

```js
import { FileAdapter, openBlackwellDB } from "./src/node.js";

const db = await openBlackwellDB({
  adapter: new FileAdapter("./app.bwl")
});

await db.ensureCollection("users", {
  indexes: ["email", "plan", "createdAt"]
});

const users = db.collection("users");

await users.put({
  id: "user-1",
  email: "ada@example.com",
  plan: "free",
  createdAt: Date.now()
});

const rows = await users.find({
  where: { plan: "free" },
  sort: { field: "createdAt", dir: "desc" }
});

console.log(rows);
await db.close();
```

## Browser Usage

Use the browser adapter to store data in IndexedDB:

```js
import { IndexedDBAdapter, openBlackwellDB } from "./src/browser.js";

const db = await openBlackwellDB({
  adapter: new IndexedDBAdapter({ name: "my-local-app" })
});

await db.ensureCollection("notes", { indexes: ["kind", "createdAt"] });
await db.collection("notes").put({
  kind: "local",
  body: "Saved without a backend server",
  createdAt: Date.now()
});
```

## Features

- Embedded database engine, no database server process.
- File-backed persistence for Node, Electron, Tauri, and desktop apps.
- IndexedDB-backed persistence for browser apps.
- Append-only write-ahead log with snapshot compaction.
- In-memory secondary indexes for fast local equality and range queries.
- Batched transactions for high write throughput.
- Local subscriptions for reactive UI updates.
- JSON export/import for backup or peer sync layers.
- Optional AES-GCM secure collections for encrypted private user payloads.
- Pluggable AI backend hub with per-backend input limits, timeout guards, and context sanitization.
- Optional 5FA enforcement for private payload access in secure collections.
- Company/admin control views for suspend, unsuspend, lock, unlock, flag, notes, deletion hold, and restore actions without exposing private payloads.

## Commands

```bash
npm test
npm run example:node
npm run example:secure
npm run bench
```

## Secure Collections

Secure collections split a record into two parts:

- `private`: encrypted with AES-GCM before it is written to the local database.
- `company/control`: non-sensitive operational metadata used for actions like suspend, unsuspend, lock, unlock, flag, admin notes, deletion hold, and restore.

```js
import {
  FileAdapter,
  deriveBlackwellSecret,
  openBlackwellDB,
  openSecureCollection
} from "./src/node.js";

const { key } = await deriveBlackwellSecret("user-or-company-held-secret");
const db = await openBlackwellDB({
  adapter: new FileAdapter("./secure-app.bwl")
});

const users = await openSecureCollection(db, "users", {
  encryptionKey: key
});

await users.put(
  "user-1",
  {
    email: "private-user@example.com",
    billingNotes: "encrypted at rest"
  },
  {
    companyMeta: {
      plan: "free",
      region: "us"
    }
  }
);

await users.suspend("user-1", {
  by: "trust-safety",
  reason: "policy-review"
});

const companyView = await users.getCompanyView("user-1");
const privateView = await users.getPrivate("user-1");
```

The company view advertises `companyAccessPercent: 7.5` and `companyAccessScope: "operations-only"`. It never includes `private`, `encryptedPrivate`, or plaintext private fields. The private payload can only be decrypted by code holding the encryption key.

Secure collections can also enforce 5-factor verification before private payload reads:

- Enable `fiveFA.enabled: true` with a custom async `fiveFA.verifier`.
- Exactly 5 unique factors are required.
- `beginFiveFA(id)` starts a challenge window.
- `verifyFiveFAFactor(id, factor, proof)` marks each verified factor.
- `getPrivate(id)` is blocked until all 5 factors are verified.

## AI Backends

Blackwell DB can optionally route AI calls through a pluggable backend hub:

```js
import { AIBackendHub, openBlackwellDB } from "./src/node.js";

const db = await openBlackwellDB();
db.registerAIBackend("local-ai", async ({ input }) => ({
  text: `local-response:${input}`
}));

const response = await db.aiGenerate({
  backend: "local-ai",
  input: "summarize this record"
});
```

Security defaults for AI requests:

- Input length limits to reduce prompt abuse and runaway payload size.
- Timeout controls with cancellation support.
- Context sanitization that rejects sensitive keys like `password`, `token`, and `secret`.
- HTTPS-only enforcement for HTTP backends unless explicitly overridden for local development.

## Current Boundary

Blackwell DB removes the backend requirement for local storage and compute. If an app later needs multi-device sync over the public internet, it still needs a way for peers to discover each other. That can be manual export/import, LAN, WebRTC rendezvous, or another optional sync layer. The database itself stays local and serverless.
