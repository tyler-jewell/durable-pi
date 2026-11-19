// Checks the official Artifacts pricing page for a date on repository charges. On demand only: nothing runs on a schedule,
// and no price is stored here. Prints what the page says, so the decision is made from the source.
//
//   npm run artifacts:billing          exit 0: no date yet. exit 3: the page now dates repository charges (act on it).
//
// Source: https://developers.cloudflare.com/artifacts/platform/pricing/ (fetched as Markdown).

const URL = "https://developers.cloudflare.com/artifacts/platform/pricing/";

const res = await fetch(URL, { headers: { accept: "text/markdown" }, redirect: "follow" });
if (!res.ok) {
  console.error(`pricing page HTTP ${res.status}`);
  process.exit(1);
}
const text = (await res.text()).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

const repoLines = text
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /repositor/i.test(l) && /(charge|bill|pric)/i.test(l));
// A dated repository charge names a month and day, and says when the charge begins. "Not part of", "coming soon" and
// "will notify" describe what is not dated, so those lines never count.
const NOT_DATED = /not part of|coming soon|notify you|will notify|no date/i;
const dated = repoLines.find((l) => !NOT_DATED.test(l) && /(begin|start|from|effective)/i.test(l) && /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b\s+\d{1,2},?\s+\d{4}/i.test(l));
const comingSoon = /repository pricing \(coming soon\)/i.test(text) || /repository charges are not part of/i.test(text);

console.log(`source: ${URL}`);
for (const l of repoLines.slice(0, 6)) console.log(`  | ${l.slice(0, 220)}`);
if (dated) {
  console.log(`\nDATED: ${dated.slice(0, 220)}`);
  console.log("Act: read the repo rate on the page, then update docs/latest-changes and the e2e README.");
  process.exit(3);
}
console.log(`\n${comingSoon ? "no date yet: repository charges are still 'coming soon'" : "no date found on the page (check the page by hand)"}`);
process.exit(0);
