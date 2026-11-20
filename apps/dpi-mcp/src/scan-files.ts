// Categorize tracked files with a decision judge. The caller supplies the file list and the judge, so a test
// never contacts a model. An unjudged file is an error, not an answer.

export interface ScanJudgement {
  answer: string;
  confidence: number;
  probabilities: Record<string, number>;
  tool: string;
}

export interface ScanHit extends ScanJudgement {
  path: string;
}

export interface ScanError {
  path: string;
  error: string;
}

/** `*` is one path segment. `**` is any number of segments. */
export function matchesGlob(path: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
  return re.test(path);
}

export function selectFiles(files: string[], include: string[] = [], exclude: string[] = [], limit?: number): string[] {
  const wanted = include.length ? include : ["**"];
  const matched = files.filter((file) => wanted.some((pattern) => matchesGlob(file, pattern)) && !exclude.some((pattern) => matchesGlob(file, pattern)));
  return limit === undefined ? matched : matched.slice(0, limit);
}

export async function scanFiles(
  files: string[],
  judge: (path: string) => Promise<ScanJudgement>,
  concurrency = 4,
): Promise<{ results: ScanHit[]; errors: ScanError[] }> {
  const results: ScanHit[] = [];
  const errors: ScanError[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const path = files[index];
      if (!path) return;
      try {
        const judgement = await judge(path);
        if (!judgement.answer || !judgement.tool) {
          errors.push({ path, error: "the file was not judged" });
          continue;
        }
        results.push({ path, ...judgement });
      } catch (error) {
        errors.push({ path, error: error instanceof Error ? error.message : "the file was not judged" });
      }
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.path.localeCompare(b.path));
  errors.sort((a, b) => a.path.localeCompare(b.path));
  return { results, errors };
}
