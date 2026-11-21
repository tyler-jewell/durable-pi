// What an Artifacts update says on the phone: the changelog (one line per commit) and the push notification text.
// Pure: no I/O, so the notification and the changelog view read the same data.

export interface Commit {
  sha: string;
  subject: string;
}

const SHA = /^[0-9a-f]{7,40}$/;

export const isSha = (value: string): boolean => SHA.test(value);

/** Parse `git log --format=%H%x09%s` output. Lines that are not a sha and a subject are skipped. */
export function parseLog(out: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab).trim();
    const subject = line.slice(tab + 1).trim();
    if (isSha(sha) && subject) commits.push({ sha, subject });
  }
  return commits;
}

/** The notification: a title, a short body that names the changes, and the URL the tap opens. */
export function updateNotice(repo: string, commits: Commit[], from: string, to: string): { title: string; body: string; url: string } {
  const count = commits.length;
  const named = clip(commits.slice(0, 3).map((c) => c.subject).join("; "), 150);
  const more = count > 3 ? ` and ${count - 3} more` : "";
  const body = count ? `${count} change${count === 1 ? "" : "s"}: ${named}${more}` : "Update made";
  const params = new URLSearchParams({ changelog: to });
  if (isSha(from)) params.set("from", from);
  return { title: `${repo} update made`, body, url: `/?${params.toString()}` };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
