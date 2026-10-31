import { decryptJSON, encryptJSON, isEncryptedEnvelope } from "./crypto.js";

export const COMPANY_ACCESS_LIMIT = 0.075;
export const COMPANY_ACCESS_PERCENT = 7.5;

const SECURE_VERSION = 1;
const DEFAULT_STATE = "active";
const DEFAULT_FIVE_FA_FACTORS = ["knowledge", "possession", "biometric", "location", "behavior"];
const CONTROL_INDEXES = [
  "ownerId",
  "state",
  "suspended",
  "locked",
  "markedForDeletion",
  "createdAt",
  "updatedAt"
];

const COMPANY_METADATA_BLOCKLIST = new Set([
  "password",
  "passphrase",
  "pin",
  "secret",
  "token",
  "ssn",
  "socialSecurityNumber",
  "creditCard",
  "cardNumber",
  "email",
  "phone",
  "address",
  "dateOfBirth",
  "dob",
  "private",
  "payload",
  "ciphertext"
]);

export async function openSecureCollection(db, name, options = {}) {
  const collection = new SecureCollection(db, name, options);
  await collection.ensure();
  return collection;
}

export class SecureCollection {
  constructor(db, name, options = {}) {
    if (!options.encryptionKey) {
      throw new TypeError("SecureCollection requires encryptionKey");
    }

    this.db = db;
    this.name = name;
    this.encryptionKey = options.encryptionKey;
    this.clock = options.clock ?? (() => Date.now());
    this.companyAccessLimit = options.companyAccessLimit ?? COMPANY_ACCESS_LIMIT;
    this.extraIndexes = options.indexes ?? [];
    this.fiveFA = createFiveFAConfig(options.fiveFA);
    this.fiveFASessions = new Map();
  }

  async ensure() {
    await this.db.ensureCollection(this.name, {
      indexes: Array.from(new Set([...CONTROL_INDEXES, ...this.extraIndexes]))
    });
    return this;
  }

  async put(id, privateData, options = {}) {
    await this.ensure();
    assertRecordId(id);
    assertPrivateData(privateData);
    const now = this.clock();
    const current = await this.raw(id);
    const companyMeta = sanitizeCompanyMeta(options.companyMeta ?? current?.companyMeta ?? {});
    const ownerId = String(options.ownerId ?? current?.ownerId ?? id);
    const encrypted = await encryptJSON(privateData, this.encryptionKey, {
      aad: {
        collection: this.name,
        id: String(id),
        ownerId
      }
    });

    const record = {
      id: String(id),
      _blackwellSecure: true,
      secureVersion: SECURE_VERSION,
      ownerId,
      state: current?.state ?? DEFAULT_STATE,
      suspended: current?.suspended ?? false,
      locked: current?.locked ?? false,
      markedForDeletion: current?.markedForDeletion ?? false,
      companyAccessLimit: this.companyAccessLimit,
      companyAccessPercent: COMPANY_ACCESS_PERCENT,
      companyAccessScope: "operations-only",
      companyMeta,
      controls: current?.controls ?? {},
      audit: current?.audit ?? [],
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
      encryptedPrivate: encrypted
    };

    await this.db.collection(this.name).put(record, id);
    return this.getCompanyView(id);
  }

  async getPrivate(id, options = {}) {
    const record = await this.raw(id);
    if (!record) return undefined;
    assertSecureRecord(record);
    assertFiveFAAccess(this, record.id, options);

    if (record.locked && options.enforceLocks !== false) {
      throw new Error(`Record ${id} is locked`);
    }

    const privateData = await decryptJSON(
      record.encryptedPrivate,
      options.encryptionKey ?? this.encryptionKey
    );

    return {
      id: record.id,
      ownerId: record.ownerId,
      state: record.state,
      suspended: record.suspended,
      locked: record.locked,
      markedForDeletion: record.markedForDeletion,
      companyMeta: clone(record.companyMeta),
      private: privateData
    };
  }

  beginFiveFA(id) {
    if (!this.fiveFA.enabled) {
      throw new Error("5FA is not enabled for this secure collection");
    }

    const recordId = String(id);
    const now = this.clock();
    const session = {
      verified: new Set(),
      expiresAt: now + this.fiveFA.windowMs
    };
    this.fiveFASessions.set(recordId, session);
    return this.getFiveFAStatus(recordId);
  }

  async verifyFiveFAFactor(id, factor, proof) {
    if (!this.fiveFA.enabled) {
      throw new Error("5FA is not enabled for this secure collection");
    }

    const record = await this.requireRecord(id);
    const factorName = String(factor ?? "").trim();
    if (!this.fiveFA.factors.includes(factorName)) {
      throw new Error(`Unknown 5FA factor "${factorName}"`);
    }

    const status = this.getFiveFAStatus(record.id);
    if (!status.active) {
      throw new Error("5FA challenge session is not active; call beginFiveFA first");
    }

    const allowed = await this.fiveFA.verifier({
      id: record.id,
      factor: factorName,
      proof,
      record: redactForCompany(record)
    });
    if (!allowed) {
      throw new Error(`5FA verification failed for factor "${factorName}"`);
    }

    const session = this.fiveFASessions.get(record.id);
    session.verified.add(factorName);
    return this.getFiveFAStatus(record.id);
  }

  getFiveFAStatus(id) {
    const recordId = String(id);
    const now = this.clock();
    const session = this.fiveFASessions.get(recordId);
    if (!session) {
      return {
        active: false,
        required: clone(this.fiveFA.factors),
        verified: [],
        remaining: clone(this.fiveFA.factors),
        complete: false,
        expiresAt: undefined
      };
    }

    if (session.expiresAt <= now) {
      this.fiveFASessions.delete(recordId);
      return {
        active: false,
        required: clone(this.fiveFA.factors),
        verified: [],
        remaining: clone(this.fiveFA.factors),
        complete: false,
        expiresAt: undefined
      };
    }

    const verified = this.fiveFA.factors.filter((factor) => session.verified.has(factor));
    const remaining = this.fiveFA.factors.filter((factor) => !session.verified.has(factor));
    return {
      active: true,
      required: clone(this.fiveFA.factors),
      verified,
      remaining,
      complete: remaining.length === 0,
      expiresAt: session.expiresAt
    };
  }

  async getCompanyView(id) {
    const record = await this.raw(id);
    if (!record) return undefined;
    return redactForCompany(record);
  }

  async findCompanyViews(query = {}) {
    await this.ensure();
    const rows = await this.db.collection(this.name).find(query);
    return rows.map(redactForCompany);
  }

  async raw(id) {
    await this.ensure();
    return this.db.collection(this.name).get(String(id));
  }

  async suspend(id, options = {}) {
    return this.applyAdminAction(id, "suspend", {
      state: "suspended",
      suspended: true,
      auditBy: options.by ?? "company",
      controls: {
        suspension: controlEntry(options, this.clock())
      }
    });
  }

  async unsuspend(id, options = {}) {
    const current = await this.requireRecord(id);
    return this.applyAdminAction(id, "unsuspend", {
      state: current.locked ? "locked" : DEFAULT_STATE,
      suspended: false,
      auditBy: options.by ?? "company",
      controls: {
        suspension: {
          ...current.controls?.suspension,
          clearedAt: this.clock(),
          clearedBy: options.by ?? "company"
        }
      }
    });
  }

  async lock(id, options = {}) {
    return this.applyAdminAction(id, "lock", {
      state: "locked",
      locked: true,
      auditBy: options.by ?? "company",
      controls: {
        lock: controlEntry(options, this.clock())
      }
    });
  }

  async unlock(id, options = {}) {
    const current = await this.requireRecord(id);
    return this.applyAdminAction(id, "unlock", {
      state: current.suspended ? "suspended" : DEFAULT_STATE,
      locked: false,
      auditBy: options.by ?? "company",
      controls: {
        lock: {
          ...current.controls?.lock,
          clearedAt: this.clock(),
          clearedBy: options.by ?? "company"
        }
      }
    });
  }

  async flag(id, flag, options = {}) {
    if (typeof flag !== "string" || flag.trim() === "") {
      throw new TypeError("flag must be a non-empty string");
    }

    const current = await this.requireRecord(id);
    const flags = new Set(current.controls?.flags ?? []);
    flags.add(flag.trim());
    return this.applyAdminAction(id, "flag", {
      auditBy: options.by ?? "company",
      controls: {
        flags: Array.from(flags),
        lastFlag: controlEntry({ ...options, reason: flag.trim() }, this.clock())
      }
    });
  }

  async unflag(id, flag, options = {}) {
    const current = await this.requireRecord(id);
    const flags = new Set(current.controls?.flags ?? []);
    flags.delete(flag);
    return this.applyAdminAction(id, "unflag", {
      auditBy: options.by ?? "company",
      controls: {
        flags: Array.from(flags),
        lastUnflag: controlEntry({ ...options, reason: flag }, this.clock())
      }
    });
  }

  async addAdminNote(id, note, options = {}) {
    if (typeof note !== "string" || note.trim() === "") {
      throw new TypeError("note must be a non-empty string");
    }

    const current = await this.requireRecord(id);
    const notes = current.controls?.notes ?? [];
    return this.applyAdminAction(id, "admin-note", {
      auditBy: options.by ?? "company",
      controls: {
        notes: [
          ...notes,
          {
            note: note.trim(),
            at: this.clock(),
            by: options.by ?? "company"
          }
        ]
      }
    });
  }

  async markForDeletion(id, options = {}) {
    return this.applyAdminAction(id, "mark-for-deletion", {
      state: "pending_deletion",
      markedForDeletion: true,
      auditBy: options.by ?? "company",
      controls: {
        deletion: controlEntry(options, this.clock())
      }
    });
  }

  async restore(id, options = {}) {
    const current = await this.requireRecord(id);
    return this.applyAdminAction(id, "restore", {
      state: current.locked ? "locked" : current.suspended ? "suspended" : DEFAULT_STATE,
      markedForDeletion: false,
      auditBy: options.by ?? "company",
      controls: {
        deletion: {
          ...current.controls?.deletion,
          clearedAt: this.clock(),
          clearedBy: options.by ?? "company"
        }
      }
    });
  }

  async setCompanyMeta(id, companyMeta, options = {}) {
    const safeCompanyMeta = sanitizeCompanyMeta(companyMeta);
    return this.applyAdminAction(id, "company-meta", {
      companyMeta: safeCompanyMeta,
      auditBy: options.by ?? "company",
      controls: {
        meta: controlEntry(options, this.clock())
      }
    });
  }

  async rotateKey(id, nextEncryptionKey) {
    const record = await this.requireRecord(id);
    const privateData = await decryptJSON(record.encryptedPrivate, this.encryptionKey);
    const encryptedPrivate = await encryptJSON(privateData, nextEncryptionKey, {
      aad: {
        collection: this.name,
        id: String(id),
        ownerId: record.ownerId
      }
    });

    await this.db.collection(this.name).update(id, {
      encryptedPrivate,
      updatedAt: this.clock()
    });
    this.encryptionKey = nextEncryptionKey;
    return this.getCompanyView(id);
  }

  async applyAdminAction(id, action, patch) {
    const current = await this.requireRecord(id);
    const now = this.clock();
    const { auditBy = "company", ...recordPatch } = patch;
    const nextControls = {
      ...current.controls,
      ...(recordPatch.controls ?? {})
    };
    const nextAudit = [
      ...(current.audit ?? []),
      {
        action,
        at: now,
        by: auditBy
      }
    ];

    await this.db.collection(this.name).update(id, {
      ...recordPatch,
      controls: nextControls,
      audit: nextAudit,
      updatedAt: now
    });

    return this.getCompanyView(id);
  }

  async requireRecord(id) {
    const record = await this.raw(id);
    if (!record) {
      throw new Error(`Secure record not found: ${id}`);
    }
    assertSecureRecord(record);
    return record;
  }
}

export function redactForCompany(record) {
  assertSecureRecord(record);
  return {
    id: record.id,
    ownerId: record.ownerId,
    state: record.state,
    suspended: record.suspended,
    locked: record.locked,
    markedForDeletion: record.markedForDeletion,
    companyAccessLimit: record.companyAccessLimit ?? COMPANY_ACCESS_LIMIT,
    companyAccessPercent: record.companyAccessPercent ?? COMPANY_ACCESS_PERCENT,
    companyAccessScope: record.companyAccessScope ?? "operations-only",
    companyMeta: clone(record.companyMeta ?? {}),
    controls: clone(record.controls ?? {}),
    audit: clone(record.audit ?? []),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    privateEncrypted: true
  };
}

function assertSecureRecord(record) {
  if (!record?._blackwellSecure || !isEncryptedEnvelope(record.encryptedPrivate)) {
    throw new Error("record is not a Blackwell secure record");
  }
}

function assertRecordId(id) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new TypeError("id must be a non-empty string");
  }
}

function assertPrivateData(privateData) {
  if (!privateData || typeof privateData !== "object" || Array.isArray(privateData)) {
    throw new TypeError("privateData must be a plain object");
  }
}

function sanitizeCompanyMeta(companyMeta) {
  if (!companyMeta || typeof companyMeta !== "object" || Array.isArray(companyMeta)) {
    throw new TypeError("companyMeta must be a plain object");
  }

  for (const key of Object.keys(flattenKeys(companyMeta))) {
    const leaf = key.split(".").at(-1);
    if (COMPANY_METADATA_BLOCKLIST.has(leaf)) {
      throw new Error(`companyMeta cannot contain private field "${leaf}"`);
    }
  }

  return clone(companyMeta);
}

function flattenKeys(value, prefix = "", output = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    output[prefix] = true;
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    flattenKeys(child, prefix ? `${prefix}.${key}` : key, output);
  }

  return output;
}

function controlEntry(options, at) {
  const entry = {
    at,
    by: options.by ?? "company",
    reason: options.reason ?? "operational-control"
  };

  if (options.until !== undefined) {
    entry.until = options.until;
  }

  return entry;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function createFiveFAConfig(config = {}) {
  if (!config) {
    return {
      enabled: false,
      factors: clone(DEFAULT_FIVE_FA_FACTORS),
      verifier: undefined,
      windowMs: 300_000
    };
  }

  const enabled = Boolean(config.enabled);
  const factors = normalizeFiveFAFactors(config.factors ?? DEFAULT_FIVE_FA_FACTORS);
  const windowMs = config.windowMs ?? 300_000;
  if (!Number.isFinite(windowMs) || windowMs < 1_000) {
    throw new TypeError("fiveFA.windowMs must be a number >= 1000");
  }

  if (enabled && typeof config.verifier !== "function") {
    throw new TypeError("fiveFA.verifier must be a function when fiveFA is enabled");
  }

  return {
    enabled,
    factors,
    verifier: config.verifier,
    windowMs
  };
}

function normalizeFiveFAFactors(factors) {
  if (!Array.isArray(factors)) {
    throw new TypeError("fiveFA.factors must be an array");
  }
  const normalized = Array.from(
    new Set(
      factors.map((factor) => {
        if (typeof factor !== "string" || factor.trim() === "") {
          throw new TypeError("5FA factors must be non-empty strings");
        }
        return factor.trim();
      })
    )
  );
  if (normalized.length !== 5) {
    throw new TypeError("5FA requires exactly 5 unique factors");
  }
  return normalized;
}

function assertFiveFAAccess(collection, id, options = {}) {
  if (!collection.fiveFA.enabled || options.bypassFiveFA === true) {
    return;
  }

  const status = collection.getFiveFAStatus(id);
  if (!status.complete) {
    throw new Error("5FA verification required before private data access");
  }

  collection.fiveFASessions.delete(String(id));
}
