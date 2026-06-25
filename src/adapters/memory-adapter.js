export class MemoryAdapter {
  constructor(entries = []) {
    this.entries = entries.slice();
  }

  async open() {}

  async readLog() {
    return this.entries.map((entry) => structuredClone(entry));
  }

  async append(entry) {
    this.entries.push(structuredClone(entry));
  }

  async appendMany(entries) {
    for (const entry of entries) {
      this.entries.push(structuredClone(entry));
    }
  }

  async replace(entries) {
    this.entries = entries.map((entry) => structuredClone(entry));
  }

  async close() {}
}
