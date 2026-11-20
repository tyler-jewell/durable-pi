// Prove the review phase's real MCP decision and the resulting gate for clean and broken work.
import { requestReviewDecision, reviewVerdict } from "../apps/dpi-backend/src/jobs.js";

const plan = "Build a todo app";
const cases = [
  { name: "clean", facts: "Typecheck and build pass; routes work", review: "approve: matches the plan, tests pass", ok: true },
  { name: "broken", facts: "Build fails with 12 errors", review: "reject: does not compile", ok: false },
];

for (const c of cases) {
  const { tool, answer } = await requestReviewDecision(plan, c.facts, c.review);
  const verdict = reviewVerdict({ verdict: answer }, c.review);
  // Use the opposite reviewer verdict to rule out an approval or block that came only from fallback.
  const control = reviewVerdict({ verdict: answer }, c.ok ? "reject" : "approve");
  const pass = verdict.ok === c.ok && control.ok === c.ok;
  console.log(`${pass ? "PASS" : "FAIL"} ${c.name}: ${verdict.reason} [${tool}]`);
  if (!pass) process.exitCode = 1;
}
