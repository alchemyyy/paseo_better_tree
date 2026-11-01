import assert from "node:assert/strict";
import { test } from "node:test";
import { createCoalescer } from "./coalesce.ts";

test("createCoalescer: callers during a run share one queued run that starts after it", async () => {
  const coalesce = createCoalescer();
  // NOTE: executor form, since tsconfig's ES2023 lib has no Promise.withResolvers
  const releases: ((value: string) => void)[] = [];
  const run = () =>
    new Promise<string>((resolve) => {
      releases.push(resolve);
    });
  const first = coalesce("repo", run);
  const late = [coalesce("repo", run), coalesce("repo", run), coalesce("repo", run)];
  assert.equal(releases.length, 1);
  releases[0]("first");
  assert.equal(await first, "first");
  // The queued run started once the first settled
  assert.equal(releases.length, 2);
  releases[1]("second");
  assert.deepEqual(await Promise.all(late), ["second", "second", "second"]);
  assert.equal(releases.length, 2);

  // Everything settled: the next call starts a fresh run at once
  const fresh = coalesce("repo", run);
  assert.equal(releases.length, 3);
  releases[2]("third");
  assert.equal(await fresh, "third");
});

test("createCoalescer: keys run independently", async () => {
  const coalesce = createCoalescer();
  let releaseRepo = (_value: string) => {};
  const repo = coalesce(
    "repo",
    () =>
      new Promise<string>((resolve) => {
        releaseRepo = resolve;
      }),
  );
  assert.equal(await coalesce("other-repo", async () => "other"), "other");
  releaseRepo("repo");
  assert.equal(await repo, "repo");
});

test("createCoalescer: a failed run rejects only its callers, and the next call still runs", async () => {
  const coalesce = createCoalescer();
  let rejectFirst = (_error: Error) => {};
  const first = coalesce(
    "repo",
    () =>
      new Promise<string>((_resolve, reject) => {
        rejectFirst = reject;
      }),
  );
  const firstJoined = coalesce("repo", async () => "joined");
  let queuedRuns = 0;
  const queued = coalesce("repo", async () => {
    queuedRuns++;
    return "queued";
  });
  rejectFirst(new Error("status failed"));
  await assert.rejects(first, /status failed/);
  // The queued run belongs to the first caller that joined it
  assert.equal(await firstJoined, "joined");
  assert.equal(await queued, "joined");
  assert.equal(queuedRuns, 0);
  assert.equal(await coalesce("repo", async () => "after"), "after");
  await assert.rejects(coalesce("repo", async () => Promise.reject(new Error("again"))), /again/);
  assert.equal(await coalesce("repo", async () => "recovered"), "recovered");
});
