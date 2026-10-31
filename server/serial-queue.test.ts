import assert from "node:assert/strict";
import { test } from "node:test";
import { createSerialQueue } from "./serial-queue.ts";

test("createSerialQueue: one key runs in arrival order, past failures, while other keys run alongside", async () => {
  const queue = createSerialQueue();
  const events: string[] = [];
  // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
  let releaseStage = () => {};
  const stageGate = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });
  const first = queue("repo", async () => {
    events.push("start stage");
    await stageGate;
    events.push("end stage");
    throw new Error("stage failed");
  });
  const second = queue("repo", async () => {
    events.push("start commit");
    return "commit";
  });
  const other = queue("other-repo", async () => {
    events.push("start other");
    return "other";
  });
  assert.equal(await other, "other");
  // The other key ran while the first write still holds its key; the second write waits for it
  assert.deepEqual(events, ["start stage", "start other"]);
  releaseStage();
  await assert.rejects(first, /stage failed/);
  assert.equal(await second, "commit");
  assert.deepEqual(events, ["start stage", "start other", "end stage", "start commit"]);
});
