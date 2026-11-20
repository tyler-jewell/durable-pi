// The read-only shell for subagents that must not change files (planner, scout, reviewer, triager). The shell is
// the only write path a read-only role has, so the rule is strict: one program from a short list, no shell syntax
// that chains, redirects, substitutes or expands, and no flag that writes or runs another program.
import { defineExtension } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool, type BashToolInput } from "@earendil-works/pi-durable/tools";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

/** Programs that only read. `sed`, `awk`, `sort`, `rg` and `tee` are left out: each can write or run commands. */
const READ_PROGRAMS = new Set(["ls", "cat", "head", "tail", "wc", "file", "stat", "pwd", "grep", "find", "diff", "du", "df", "which", "basename", "dirname", "readlink", "tree", "echo", "git"]);
/** The git subcommands that only read. */
const GIT_READS = new Set(["status", "log", "diff", "show", "ls-files", "rev-parse", "branch"]);
/** Shell syntax that chains, redirects, substitutes, expands, or continues a line. None of it is needed to read. */
const SHELL_SYNTAX = /[;|&<>`$(){}\\\n\r]/;
/** find flags that run a program or write a file. */
const FIND_WRITES = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);

/** Why a command may not run in the read-only shell, or undefined when it may. */
export function readOnlyRefusal(command: string): string | undefined {
  const text = command.trim();
  if (!text) return "the command is empty";
  if (SHELL_SYNTAX.test(text)) return "shell syntax (redirection, chaining, pipes, substitution, or expansion) is not allowed; read one file or list with one command";
  const words = text.split(/\s+/);
  const program = words[0];
  if (!READ_PROGRAMS.has(program)) return `${program} is not a read-only program (allowed: ${[...READ_PROGRAMS].join(", ")})`;
  if (program === "git" && !GIT_READS.has(words[1] ?? "")) return `git ${words[1] ?? ""} changes the repository; allowed: ${[...GIT_READS].join(", ")}`;
  if (program === "git" && words.includes("-C")) return "git -C is not needed; run from the folder";
  if (program === "find" && words.some((w) => FIND_WRITES.has(w))) return "find may not run a program or write a file";
  if (program === "echo" && words.length > 1 && /^-/.test(words[1]) && words[1].includes("e")) return "echo -e is not allowed";
  return undefined;
}

/** The read-only bash tool: the same tool, with every command checked before it runs. A refused command comes back
 *  as an error result the model reads, so the subagent can choose another command. Nothing is spawned. */
export function readOnlyBashTool() {
  const shell = createBashTool();
  return {
    ...shell,
    execute: (args: BashToolInput, api: ToolExecutionApi, context: Context) => {
      const why = readOnlyRefusal(args.command);
      if (why) {
        return Promise.resolve({
          isError: true,
          output: [{ type: "text" as const, text: `The read-only shell refused this command: ${why}. Read files with read, or run one listing or search command.` }],
        });
      }
      return shell.execute(args, api, context);
    },
  };
}

/** Read-only roles (planner, scout, reviewer, triager): read, and the read-only shell. Selected as an extension, so the
 *  shell a role gets is this one and not the coding extension's full shell. */
export const ReadOnlyTools = defineExtension({ name: "read-only-tools", tools: [createReadTool(), readOnlyBashTool()] });

/** The documenter: reads, writes and edits files, and has the read-only shell only. */
export const DocumentTools = defineExtension({ name: "document-tools", tools: [createReadTool(), readOnlyBashTool(), createWriteTool(), createEditTool()] });
