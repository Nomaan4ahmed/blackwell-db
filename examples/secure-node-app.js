import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileAdapter,
  deriveBlackwellSecret,
  openBlackwellDB,
  openSecureCollection
} from "../src/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const { key } = await deriveBlackwellSecret("replace-with-user-or-company-held-secret", {
  salt: "YmxhY2t3ZWxsLWRlbW8tc2FsdA==",
  iterations: 100000
});

const db = await openBlackwellDB({
  adapter: new FileAdapter(join(here, "blackwell-secure-demo.bwl"))
});

const users = await openSecureCollection(db, "secureUsers", {
  encryptionKey: key
});

await db.collection("secureUsers").clear();

await users.put(
  "user-1",
  {
    email: "private-user@example.com",
    recoveryCodes: ["one-time-code"],
    healthOrBillingNotes: "This stays encrypted at rest."
  },
  {
    ownerId: "user-1",
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

console.log("Company view:");
console.log(await users.getCompanyView("user-1"));

console.log("Private view with key:");
console.log(await users.getPrivate("user-1"));

await db.close();
