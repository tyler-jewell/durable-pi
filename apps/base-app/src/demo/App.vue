<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { AppShell, NavRail, type NavItem } from "../index";
import JobCard from "../left/JobCard.vue";
import StateEditor from "../left/StateEditor.vue";
import Transcript from "../left/Transcript.vue";
import SystemStream from "../stream/SystemStream.vue";
import { changeState, type AppState, type StateChange } from "@sdk/app-state";
import { emptySystemStream, reduceSystemStream, type SystemStreamView } from "@sdk/system-stream";
import type { TranscriptItem as TranscriptItemType } from "@sdk/transcript";
import type { JobDef, JobRun } from "@sdk/jobs";

// ---- nav rail: the objects this app manages -------
const objects: NavItem[] = [
  { id: "s1", label: "Session #1", kind: "session" },
  { id: "inc-1", label: "INC-0001", kind: "incident" },
  { id: "d7", label: "Deploy #7", kind: "deploy" },
];
const selectedObject = ref("s1");

// ---- left: the conversation transcript -------
const transcript = ref<TranscriptItemType[]>([
  { kind: "user", id: 1, text: "Deploy the release notes after review." },
  {
    kind: "assistant",
    id: 2,
    streaming: false,
    blocks: [
      { type: "text", text: "I'll run a **release check** — first gathering facts, then waiting for your approval." },
      {
        type: "tool",
        call: {
          callId: "c1",
          name: "run_durable_job",
          args: { job: "release-check", input: { commits: 5 } },
          status: "done",
          result: "Started release check run #3 as task #7",
        },
      },
    ],
    model: "llama-3.3",
  },
  { kind: "tool-result", id: 3, name: "run_durable_job", text: "Started release check run #3 as task #7", isError: false },
  { kind: "event", id: 4, entryKind: "demo.state-change", text: "App State: update /jobs/release-check" },
]);

// ---- left: generated view (editable App State) ----
const state = ref<AppState>({
  goal: "Explore durable agents",
  counter: 3,
  settings: { enabled: true, tags: ["a", "b"] },
});
function apply(change: StateChange) {
  try {
    state.value = changeState(state.value, change);
  } catch (e) {
    console.warn(e);
  }
}

// ---- left: approval flow (a durable job run) ----
const def: JobDef = {
  id: "release-check",
  title: "Release check",
  summary: "Plan a release review, let a subagent gather facts with read and bash, wait for your approval, then publish the notes.",
  phases: [
    { id: "plan", label: "Plan", summary: "Decide what the release notes must cover" },
    { id: "gather", label: "Gather", summary: "A subagent runs git and reads the README" },
    { id: "approve", label: "Approve", summary: "Wait for a person to approve publishing", kind: "approval" },
    { id: "publish", label: "Publish", summary: "Write the release notes to App State" },
    { id: "verify", label: "Verify", summary: "Read the notes back and confirm this run published them" },
  ],
  inputs: [{ name: "commits", type: "integer", description: "How many recent commits the subagent reviews", default: 5 }],
  approval: true,
  resultPath: "/jobs/release-check",
  seconds: 20,
};
const job = ref<JobRun>({
  id: 7,
  job: "release-check",
  title: "Release check",
  run: 3,
  input: { commits: 5 },
  startedBy: "you",
  background: false,
  status: "waiting",
  phase: "approve",
  phases: [
    { id: "plan", label: "Plan", status: "done", summary: "3 checks planned", steps: [] },
    { id: "gather", label: "Gather", status: "done", summary: "Gathered", steps: [] },
    { id: "approve", label: "Approve", status: "waiting", startedAt: Date.now() - 15000, steps: [] },
    { id: "publish", label: "Publish", status: "pending", steps: [] },
    { id: "verify", label: "Verify", status: "pending", steps: [] },
  ],
  approval: "pending",
  resumed: 0,
  startedAt: Date.now() - 20000,
  updatedAt: Date.now() - 5000,
});
const pendingJob = ref(false);
function decide(approved: boolean) {
  pendingJob.value = true;
  setTimeout(() => {
    const now = Date.now();
    const approve = job.value.phases.find((p) => p.id === "approve")!;
    job.value = {
      ...job.value,
      approval: approved ? "approved" : "declined",
      status: approved ? "running" : "declined",
      phase: approved ? "publish" : job.value.phase,
      updatedAt: now,
      phases: job.value.phases.map((p) =>
        p.id === "approve" ? { ...p, status: approved ? ("done" as const) : ("failed" as const), endedAt: now, summary: approved ? "Approved by you" : "Declined by you" } : p,
      ),
    };
    pendingJob.value = false;
  }, 400);
}
function stop() {
  job.value = { ...job.value, status: "aborted", approval: "cancelled", updatedAt: Date.now() };
}

// ---- right: system stream ----
const view = ref<SystemStreamView>(emptySystemStream());
view.value = reduceSystemStream(view.value, { type: "hello", source: "local", appId: "demo", startedAt: Date.now() });
let n = 0;
const tick = () => {
  n++;
  if (n % 5 === 0) {
    view.value = reduceSystemStream(view.value, {
      type: "event",
      at: Date.now(),
      kind: "job.phase",
      payload: { job: "release-check", phase: "approve" },
    });
  } else {
    view.value = reduceSystemStream(view.value, {
      type: "log",
      at: Date.now(),
      level: n % 17 === 0 ? "warn" : "info",
      message: `demo log line ${n}`,
    });
  }
};
const timer = setInterval(tick, 800);
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <AppShell title="Base app" app-id="demo" status="live" model="@cf/meta/llama-3.3">
    <template #nav>
      <NavRail :items="objects" :selected="selectedObject" @select="selectedObject = $event" />
    </template>
    <template #left>
      <Transcript :items="transcript" />
      <StateEditor :value="state" @change="apply" />
      <JobCard :run="job" :def="def" :pending="pendingJob" :now="Date.now()" @decide="decide" @stop="stop" />
    </template>
    <template #right>
      <SystemStream :view="view" />
    </template>
  </AppShell>
</template>
