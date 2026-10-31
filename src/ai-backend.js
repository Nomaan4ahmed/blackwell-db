const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INPUT_CHARS = 12_000;
const SENSITIVE_CONTEXT_KEYS = new Set([
  "password",
  "passphrase",
  "token",
  "apiKey",
  "secret",
  "privateKey",
  "creditCard",
  "ssn"
]);

export class AIBackendHub {
  constructor(options = {}) {
    this.backends = new Map();
    this.defaultBackend = options.defaultBackend;
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    for (const [name, backend] of Object.entries(options.backends ?? {})) {
      this.register(name, backend);
    }
  }

  register(name, backend, options = {}) {
    assertBackendName(name);
    const normalized = normalizeBackend(backend);
    this.backends.set(name, {
      ...normalized,
      maxInputChars: options.maxInputChars ?? this.maxInputChars,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs
    });
    if (!this.defaultBackend) this.defaultBackend = name;
    return this;
  }

  unregister(name) {
    this.backends.delete(String(name));
    if (this.defaultBackend === name) {
      this.defaultBackend = this.backends.keys().next().value;
    }
    return this;
  }

  async generate(request = {}) {
    const backendName = request.backend ?? this.defaultBackend;
    if (!backendName || !this.backends.has(backendName)) {
      throw new Error("AI backend not found");
    }

    const backend = this.backends.get(backendName);
    const input = assertInput(request.input, backend.maxInputChars);
    const context = sanitizeContext(request.context ?? {});
    const signal = request.signal;
    const timeoutMs = request.timeoutMs ?? backend.timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("AI request timed out")), timeoutMs);
    const abort = () => controller.abort(signal.reason);

    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else if (signal) {
      signal.addEventListener("abort", abort, { once: true });
    }

    try {
      const response = await backend.generate({
        input,
        context,
        signal: controller.signal
      });
      return normalizeResponse(response, backendName);
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener("abort", abort);
    }
  }
}

export function createHTTPAIBackend(options = {}) {
  if (!globalThis.fetch) {
    throw new Error("global fetch is required for HTTP AI backends");
  }

  const url = assertSafeEndpoint(options.url, options.allowInsecureHttp ?? false);
  const model = options.model ?? "default";
  const headers = sanitizeHeaders(options.headers ?? {});
  const mapResponse = options.mapResponse ?? defaultMapHTTPResponse;

  return {
    async generate({ input, context, signal }) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers
        },
        body: JSON.stringify({
          model,
          input,
          context
        }),
        signal
      });

      if (!response.ok) {
        throw new Error(`AI backend request failed (${response.status})`);
      }

      const body = await response.json();
      return mapResponse(body);
    }
  };
}

function defaultMapHTTPResponse(body) {
  return {
    text: String(body?.text ?? body?.output ?? ""),
    raw: body
  };
}

function normalizeBackend(backend) {
  if (typeof backend === "function") {
    return { generate: backend };
  }
  if (!backend || typeof backend.generate !== "function") {
    throw new TypeError("AI backend must be a function or an object with generate()");
  }
  return backend;
}

function normalizeResponse(response, backend) {
  if (typeof response === "string") {
    return { backend, text: response };
  }
  if (!response || typeof response !== "object") {
    throw new TypeError("AI backend response must be a string or object");
  }
  if (typeof response.text !== "string") {
    throw new TypeError("AI backend response.text must be a string");
  }
  return {
    backend,
    text: response.text,
    usage: response.usage ? clone(response.usage) : undefined,
    raw: response.raw ?? undefined
  };
}

function sanitizeHeaders(headers) {
  const sanitized = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof name !== "string" || typeof value !== "string") {
      throw new TypeError("HTTP AI backend headers must be string key/value pairs");
    }
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error("HTTP AI backend headers cannot contain new lines");
    }
    sanitized[name] = value;
  }
  return sanitized;
}

function sanitizeContext(context) {
  assertPlainObject(context, "context");

  for (const key of Object.keys(flattenKeys(context))) {
    const leaf = key.split(".").at(-1);
    if (SENSITIVE_CONTEXT_KEYS.has(leaf)) {
      throw new Error(`AI context cannot include sensitive key "${leaf}"`);
    }
  }

  return clone(context);
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

function assertSafeEndpoint(value, allowInsecureHttp) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("HTTP AI backend url must be a non-empty string");
  }
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" && !(allowInsecureHttp && endpoint.protocol === "http:")) {
    throw new Error("HTTP AI backend url must use https");
  }
  return endpoint.toString();
}

function assertBackendName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.:-]+$/.test(name)) {
    throw new TypeError("AI backend name must contain only letters, numbers, _, ., :, or -");
  }
}

function assertInput(input, maxInputChars) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("AI input must be a non-empty string");
  }
  if (input.length > maxInputChars) {
    throw new Error(`AI input exceeds limit of ${maxInputChars} characters`);
  }
  return input;
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
