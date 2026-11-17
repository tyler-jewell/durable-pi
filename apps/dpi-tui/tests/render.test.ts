import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentModel } from "../../dpi-sdk/src/models.ts";
import type { Frame } from "../../dpi-sdk/src/api.ts";
import type { ToolCallView, TranscriptItem } from "../../dpi-sdk/src/transcript.ts";
import { itemComponent, TranscriptView } from "../src/render.ts";

const long = "x".repeat(500);
const wide = "漢字とかなの混在テキスト🙂🚀✨ ".repeat(20);
const items: TranscriptItem[] = [
  { kind: "user", id: 1, text: `hello ${wide}\nsecond line ${long}` },
  {
    kind: "assistant",
    id: 2,
    streaming: false,
    model: "m",
    blocks: [
      { type: "thinking", text: `planning ${wide}` },
      { type: "text", text: `# Title\n\nSome **bold** text, \`code\`, and a list:\n\n- one ${wide}\n- two\n\n\`\`\`ts\nconst x = "${long}";\n\`\`\`` },
      {
        type: "tool",
        call: { callId: "a", name: "bash", args: { command: `echo ${long}` }, status: "done", result: `${wide}\n`.repeat(12), resultEntryId: 3 },
      },
      { type: "tool", call: { callId: "b", name: "write", args: { path: `/very/${long}/file.ts`, content: long }, status: "running", output: "partial\noutput" } },
      { type: "tool", call: { callId: "c", name: "edit", args: { edits: [{ old: long, new: wide }] }, status: "error", result: `failed ${wide}` } },
    ],
    error: `Provider request failed ${long}`,
  },
  { kind: "assistant", id: "live", streaming: true, blocks: [] },
  { kind: "tool-result", id: 4, name: "read", text: `${wide}\n${long}`, isError: true },
  { kind: "tool", id: "d", call: { callId: "d", name: "grep", args: { pattern: wide }, status: "pending" } },
  { kind: "event", id: 5, entryKind: "pi.compaction", text: `Context compacted ${wide}` },
];

for (const width of [40, 80, 200])
  for (const expand of [false, true])
    test(`every item kind fits width ${width}${expand ? " (expanded)" : ""}`, () => {
      for (const item of items) {
        const lines = itemComponent(item, expand).render(width);
        assert.ok(lines.length > 0, `${item.kind} renders`);
        for (const line of lines)
          assert.ok(visibleWidth(line) <= width, `${item.kind} line is ${visibleWidth(line)} > ${width}: ${JSON.stringify(line).slice(0, 120)}`);
      }
    });

test("collapsed tool output shows the last 6 lines and a count; expanded shows all", () => {
  const call: ToolCallView = {
    callId: "a",
    name: "bash",
    args: { command: "echo rows" },
    status: "done",
    result: Array.from({ length: 12 }, (_, i) => `row-${String(i + 1).padStart(2, "0")}`).join("\n"),
    resultEntryId: 3,
  };
  const collapsed = itemComponent({ kind: "tool", id: "a", call }, false).render(200);
  assert.ok(collapsed.some((l) => l.includes("6 earlier lines")), "counts the hidden lines");
  assert.ok(collapsed.some((l) => l.includes("row-12")), "shows the last line");
  assert.ok(!collapsed.some((l) => l.includes("row-01")), "hides the first line");
  const expanded = itemComponent({ kind: "tool", id: "a", call }, true).render(200);
  assert.ok(expanded.some((l) => l.includes("row-01")) && expanded.some((l) => l.includes("row-12")), "shows every line");
  assert.ok(!expanded.some((l) => l.includes("earlier lines")), "no hidden-lines count when expanded");
});

test("TranscriptView reuses components for unchanged items and renders a recorded tool turn", () => {
  const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../dpi-sdk/tests/fixtures/agent-tool-turn.json"), "utf8")) as { frames: Frame[] };
  const model = new AgentModel();
  const view = new TranscriptView();
  for (const frame of fixture.frames) {
    model.apply(frame);
    view.update(model.state.items);
  }
  const first = [...view.children];
  view.update(model.state.items);
  assert.deepEqual(view.children, first, "same components when nothing changed");
  const text = view.render(100).join("\n");
  assert.match(text, /bash/);
  for (const line of view.render(60)) assert.ok(visibleWidth(line) <= 60);
});
