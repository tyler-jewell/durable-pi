// Artifacts inventory: namespaces, jurisdictions, and repo counts on the account. Read-only.
//
//   npm run artifacts:inventory
//
// Repo charges start later than operations and storage (see the Artifacts pricing page). This prints counts only, so
// the account's exposure is visible without a price table in code.

import { inventory } from "./artifacts-api.mts";

const rows = await inventory();
let repos = 0;
for (const ns of rows) {
  repos += ns.repos.length;
  console.log(`${ns.namespace.padEnd(24)} jurisdiction=${ns.jurisdiction ?? "unrestricted"}  repos=${ns.repos.length}`);
}
console.log(`${rows.length} namespace(s), ${repos} repo(s) in total`);
