import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAdapter, openBlackwellDB } from "../src/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const db = await openBlackwellDB({
  adapter: new FileAdapter(join(here, "blackwell-demo.bwl"))
});

await db.ensureCollection("users", {
  indexes: ["email", "plan", "createdAt"]
});

const users = db.collection("users");

await users.put({
  id: "user-1",
  email: "ada@example.com",
  plan: "free",
  createdAt: 1
});

await users.put({
  id: "user-2",
  email: "grace@example.com",
  plan: "pro",
  createdAt: 2
});

const freeUsers = await users.find({
  where: { plan: "free" },
  sortBy: "createdAt"
});

console.log("Blackwell DB local query result:");
console.log(freeUsers);

await db.compact();
await db.close();
