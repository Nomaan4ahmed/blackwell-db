const ENVELOPE_VERSION = 1;
const DEFAULT_ITERATIONS = 210000;

export async function generateBlackwellSecret(options = {}) {
  const subtle = requireSubtleCrypto();
  return subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256
    },
    options.extractable ?? false,
    ["encrypt", "decrypt"]
  );
}

export async function deriveBlackwellSecret(passphrase, options = {}) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new TypeError("passphrase must be a non-empty string");
  }

  const crypto = requireCrypto();
  const subtle = requireSubtleCrypto();
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const saltBytes = options.salt
    ? base64ToBytes(options.salt)
    : crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations
    },
    baseKey,
    {
      name: "AES-GCM",
      length: 256
    },
    options.extractable ?? false,
    ["encrypt", "decrypt"]
  );

  return {
    key,
    salt: bytesToBase64(saltBytes),
    iterations,
    algorithm: "PBKDF2-SHA256/AES-GCM-256"
  };
}

export async function encryptJSON(value, key, options = {}) {
  assertAesKey(key);

  const crypto = requireCrypto();
  const subtle = requireSubtleCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = options.aad ?? {};
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encodeAAD(aad)
    },
    key,
    plaintext
  );

  return {
    v: ENVELOPE_VERSION,
    alg: "AES-GCM-256",
    iv: bytesToBase64(iv),
    aad,
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptJSON(envelope, key) {
  assertAesKey(key);
  assertEnvelope(envelope);

  const subtle = requireSubtleCrypto();
  const plaintext = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(envelope.iv),
      additionalData: encodeAAD(envelope.aad ?? {})
    },
    key,
    base64ToBytes(envelope.ciphertext)
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function isEncryptedEnvelope(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.v === ENVELOPE_VERSION &&
      value.alg === "AES-GCM-256" &&
      typeof value.iv === "string" &&
      typeof value.ciphertext === "string"
  );
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== "string") {
    throw new TypeError("base64 value must be a string");
  }

  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function assertAesKey(key) {
  if (!key || typeof key !== "object" || key.type !== "secret") {
    throw new TypeError("encryptionKey must be a Web Crypto AES-GCM CryptoKey");
  }
}

function assertEnvelope(envelope) {
  if (!isEncryptedEnvelope(envelope)) {
    throw new TypeError("value is not a Blackwell encrypted envelope");
  }
}

function encodeAAD(value) {
  return new TextEncoder().encode(stableStringify(value));
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function requireCrypto() {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto getRandomValues is required for Blackwell encryption");
  }
  return globalThis.crypto;
}

function requireSubtleCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto subtle is required for Blackwell encryption");
  }
  return globalThis.crypto.subtle;
}
