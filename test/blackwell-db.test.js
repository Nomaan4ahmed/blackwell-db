import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AIBackendHub,
  FileAdapter,
  MemoryAdapter,
  createHTTPAIBackend,
  generateBlackwellSecret,
  openBlackwellDB,
  openSecureCollection
} from "../src/node.js";

test("stores and queries documents with secondary indexes", async () => {
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  await db.ensureCollection("users", { indexes: ["email", "age", "profile.city"] });

  const users = db.collection("users");
  await users.put({ id: "u1", email: "a@example.com", age: 30, profile: { city: "LA" } });
  await users.put({ id: "u2", email: "b@example.com", age: 41, profile: { city: "NYC" } });
  await users.put({ id: "u3", email: "c@example.com", age: 44, profile: { city: "LA" } });

  const byEmail = await users.find({ where: { email: "b@example.com" } });
  assert.equal(byEmail.length, 1);
  assert.equal(byEmail[0].id, "u2");

  const inLosAngeles = await users.find({
    where: { "profile.city": "LA" },
    sort: { field: "age", dir: "desc" }
  });
  assert.deepEqual(inLosAngeles.map((user) => user.id), ["u3", "u1"]);

  const ages = await users.range("age", { gte: 35, lte: 45 });
  assert.deepEqual(ages.map((user) => user.id), ["u2", "u3"]);
});

test("persists to a local file and replays without a server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blackwell-db-"));
  const path = join(dir, "app.bwl");

  try {
    const first = await openBlackwellDB({ adapter: new FileAdapter(path) });
    await first.ensureCollection("tasks", { indexes: ["status"] });
    await first.collection("tasks").put({ id: "t1", title: "Run locally", status: "open" });
    await first.close();

    const second = await openBlackwellDB({ adapter: new FileAdapter(path) });
    const task = await second.collection("tasks").get("t1");
    assert.equal(task.title, "Run locally");

    await second.collection("tasks").update("t1", { status: "done" });
    assert.equal((await second.collection("tasks").find({ where: { status: "done" } })).length, 1);

    const before = (await stat(path)).size;
    await second.compact();
    const after = (await stat(path)).size;
    assert.ok(after <= before);
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commits transaction batches atomically", async () => {
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  await db.ensureCollection("events", { indexes: ["type"] });

  await db.transaction((tx) => {
    tx.put("events", { id: "e1", type: "click" });
    tx.put("events", { id: "e2", type: "click" });
    tx.put("events", { id: "e3", type: "view" });
  });

  const events = db.collection("events");
  assert.equal(await events.count({ where: { type: "click" } }), 2);
  assert.equal(await events.count({ where: { type: "view" } }), 1);
});

test("notifies local subscribers after writes", async () => {
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  await db.ensureCollection("messages");

  const seen = [];
  const unsubscribe = db.collection("messages").subscribe((change) => seen.push(change));
  await db.collection("messages").put({ id: "m1", body: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  unsubscribe();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "put");
  assert.equal(seen[0].id, "m1");
});

test("secure collections encrypt private user data and expose company controls only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blackwell-secure-"));
  const path = join(dir, "secure.bwl");

  try {
    const key = await generateBlackwellSecret();
    const db = await openBlackwellDB({ adapter: new FileAdapter(path) });
    const profiles = await openSecureCollection(db, "profiles", { encryptionKey: key });

    await profiles.put(
      "user-1",
      {
        email: "private-user@example.com",
        ssn: "123-45-6789",
        notes: "fully encrypted user payload"
      },
      {
        ownerId: "user-1",
        companyMeta: {
          plan: "free",
          region: "us"
        }
      }
    );

    const raw = await db.collection("profiles").get("user-1");
    const rawJson = JSON.stringify(raw);
    assert.equal(raw.encryptedPrivate.alg, "AES-GCM-256");
    assert.equal(rawJson.includes("private-user@example.com"), false);
    assert.equal(rawJson.includes("123-45-6789"), false);

    const suspended = await profiles.suspend("user-1", {
      by: "trust-safety",
      reason: "policy-review"
    });
    assert.equal(suspended.suspended, true);
    assert.equal(suspended.audit.at(-1).by, "trust-safety");
    assert.equal(suspended.privateEncrypted, true);
    assert.equal(suspended.encryptedPrivate, undefined);
    assert.equal(suspended.private, undefined);
    assert.equal(suspended.companyAccessPercent, 7.5);

    await profiles.lock("user-1", {
      by: "trust-safety",
      reason: "account-protection"
    });
    await assert.rejects(() => profiles.getPrivate("user-1"), /locked/);

    const privateView = await profiles.getPrivate("user-1", { enforceLocks: false });
    assert.equal(privateView.private.email, "private-user@example.com");
    assert.equal(privateView.private.ssn, "123-45-6789");

    const wrongKey = await generateBlackwellSecret();
    await assert.rejects(
      () =>
        profiles.getPrivate("user-1", {
          encryptionKey: wrongKey,
          enforceLocks: false
        }),
      /operation failed|decrypt/i
    );

    await db.close();

    const fileText = await readFile(path, "utf8");
    assert.equal(fileText.includes("private-user@example.com"), false);
    assert.equal(fileText.includes("123-45-6789"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secure collection rejects private-looking company metadata", async () => {
  const key = await generateBlackwellSecret();
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  const profiles = await openSecureCollection(db, "profiles", { encryptionKey: key });

  await assert.rejects(
    () =>
      profiles.put(
        "user-2",
        { email: "private@example.com" },
        {
          companyMeta: {
            plan: "free",
            token: "do-not-store-here"
          }
        }
      ),
    /companyMeta cannot contain private field/
  );
});

test("routes AI generation through registered backend with sanitized context", async () => {
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  db.registerAIBackend("echo", async ({ input, context }) => ({
    text: `${input}:${context.intent}`
  }));

  const result = await db.aiGenerate({
    backend: "echo",
    input: "hello",
    context: { intent: "test" }
  });

  assert.equal(result.backend, "echo");
  assert.equal(result.text, "hello:test");
});

test("rejects AI context keys that look sensitive", async () => {
  const hub = new AIBackendHub({
    backends: {
      local: async ({ input }) => ({ text: input })
    }
  });

  await assert.rejects(
    () =>
      hub.generate({
        backend: "local",
        input: "hello",
        context: {
          token: "should-not-pass"
        }
      }),
    /sensitive key/
  );
});

test("enforces HTTPS for HTTP AI backend by default", async () => {
  assert.throws(
    () =>
      createHTTPAIBackend({
        url: "http://localhost:9999/ai"
      }),
    /must use https/
  );
});

test("enforces 5FA before private payload access when enabled", async () => {
  const key = await generateBlackwellSecret();
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
  const users = await openSecureCollection(db, "fivefa-users", {
    encryptionKey: key,
    fiveFA: {
      enabled: true,
      verifier: async ({ factor, proof }) => proof === `ok-${factor}`
    }
  });

  await users.put("user-5fa", { email: "fivefa@example.com" }, { ownerId: "user-5fa" });

  await assert.rejects(() => users.getPrivate("user-5fa"), /5FA verification required/);

  const started = users.beginFiveFA("user-5fa");
  assert.equal(started.required.length, 5);

  for (const factor of started.required.slice(0, 4)) {
    await users.verifyFiveFAFactor("user-5fa", factor, `ok-${factor}`);
  }

  await assert.rejects(() => users.getPrivate("user-5fa"), /5FA verification required/);

  const lastFactor = started.required[4];
  await users.verifyFiveFAFactor("user-5fa", lastFactor, `ok-${lastFactor}`);
  const privateView = await users.getPrivate("user-5fa");
  assert.equal(privateView.private.email, "fivefa@example.com");
  await assert.rejects(() => users.getPrivate("user-5fa"), /5FA verification required/);
});

test("5FA configuration requires exactly five unique factors", async () => {
  const key = await generateBlackwellSecret();
  const db = await openBlackwellDB({ adapter: new MemoryAdapter() });

  await assert.rejects(
    () =>
      openSecureCollection(db, "invalid-fivefa", {
        encryptionKey: key,
        fiveFA: {
          enabled: true,
          factors: ["one", "two", "three", "four"],
          verifier: async () => true
        }
      }),
    /exactly 5 unique factors/
  );
});
