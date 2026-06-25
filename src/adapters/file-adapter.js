import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export class FileAdapter {
  constructor(path) {
    if (!path) throw new TypeError("FileAdapter requires a path");
    this.path = String(path);
    this.ready = false;
  }

  async open() {
    if (this.ready) return;
    await fs.mkdir(dirname(this.path), { recursive: true });
    try {
      await fs.access(this.path);
    } catch {
      await fs.writeFile(this.path, "", { flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
    this.ready = true;
  }

  async readLog() {
    await this.open();
    const text = await fs.readFile(this.path, "utf8");
    const entries = [];
    const lines = text.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;

      try {
        entries.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid Blackwell DB log entry at line ${index + 1}: ${error.message}`);
      }
    }

    return entries;
  }

  async append(entry) {
    await this.open();
    await fs.appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  async appendMany(entries) {
    await this.open();
    if (entries.length === 0) return;
    await fs.appendFile(
      this.path,
      `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8"
    );
  }

  async replace(entries) {
    await this.open();
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const payload = entries.length
      ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "";

    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, this.path);
  }

  async close() {}
}
