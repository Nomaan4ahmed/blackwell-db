import { performance } from "node:perf_hooks";
import { MemoryAdapter, openBlackwellDB } from "../src/index.js";

const rows = Number(process.argv[2] ?? 50000);
const db = await openBlackwellDB({ adapter: new MemoryAdapter() });
await db.ensureCollection("events", { indexes: ["accountId", "score"] });
const events = db.collection("events");

let start = performance.now();
await db.transaction((tx) => {
  for (let i = 0; i < rows; i += 1) {
    tx.put("events", {
      id: `evt-${i}`,
      accountId: `acct-${i % 1000}`,
      score: i % 100,
      payload: `local-compute-${i}`
    });
  }
});
let elapsed = performance.now() - start;
console.log(`Inserted ${rows.toLocaleString()} rows in ${elapsed.toFixed(1)} ms`);
console.log(`${Math.round(rows / (elapsed / 1000)).toLocaleString()} rows/sec`);

start = performance.now();
const matches = await events.find({
  where: { accountId: "acct-42" },
  limit: 1000
});
elapsed = performance.now() - start;
console.log(`Indexed query returned ${matches.length} rows in ${elapsed.toFixed(3)} ms`);

await db.close();
