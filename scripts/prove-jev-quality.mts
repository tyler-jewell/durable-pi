// Prove the jev-quality reviewer gate with the Studio's real Clef-Flash decision model.
// A "clean" state should approve (ship), a "broken" one should fail the gate.
import { askJev } from "../apps/dpi-backend/src/jev.js";
import { reviewVerdict } from "../apps/dpi-backend/src/jobs.js";

const QUESTIONS = {
  verdict: {
    type: "choice" as const,
    instructions: "Should this app ship as built?",
    criteria: {
      approve: "The work matches the plan and its checks passed; ship it",
      revise: "Small, specific fixes are needed; loop back to the builder",
      reject: "Broken, unsafe, or not what the plan asked for; block the run",
    },
  },
};

const cases = [
  { name: "clean", state: { plan: "build a todo app", facts: "typecheck and build pass; routes work", review: "approve: matches the plan, tests pass" }, model: "approve: looks good" },
  { name: "broken", state: { plan: "build a todo app", facts: "build fails with 12 errors", review: "reject: does not compile" }, model: "reject: does not compile" },
];

for (const c of cases) {
  const answers = await askJev(c.state, QUESTIONS);
  const v = reviewVerdict(answers, c.model);
  console.log(`${c.name.padEnd(7)} → ${v.ok ? "APPROVE (ships)" : "GATE FAILS"} | ${v.reason}`);
}
