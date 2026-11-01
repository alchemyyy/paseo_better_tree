import assert from "node:assert/strict";
import { test } from "node:test";
import { BatchOutput, type GitObject, type PendingRead } from "./object-reader.ts";

/** Parses `output` fed in chunks of `chunkSize` bytes, for `reads` reads limited to `maxBytes` each */
function parse(output: Buffer, reads: number, maxBytes: number, chunkSize: number): string[] {
  const answers: string[] = [];
  const queue: PendingRead[] = Array.from({ length: reads }, () => ({
    maxBytes,
    resolve: (object: GitObject) =>
      answers.push(object.found ? `${object.type} ${object.size} ${object.content?.toString("utf8") ?? "(over limit)"}` : "missing"),
  }));
  const parser = new BatchOutput(() => queue.shift());
  for (let offset = 0; offset < output.length; offset += chunkSize) parser.push(output.subarray(offset, offset + chunkSize));
  return answers;
}

test("BatchOutput reads found, missing, and over-limit objects wherever the chunks break", () => {
  const output = Buffer.from(
    "a1 blob 6\nhéllo\n" +
      "b2^:dir/my file.txt missing\n" +
      "c3 blob 12\nline1\nline2\n\n" +
      "d4 blob 0\n\n" +
      "e5 commit 3\nabc\n",
    "utf8",
  );
  const expected = ["blob 6 héllo", "missing", "blob 12 (over limit)", "blob 0 ", "commit 3 abc"];
  for (let chunkSize = 1; chunkSize <= output.length; chunkSize++) {
    assert.deepEqual(parse(output, expected.length, 8, chunkSize), expected, `chunks of ${chunkSize} bytes`);
  }
});

test("BatchOutput refuses an answer nothing asked for", () => {
  assert.throws(() => parse(Buffer.from("a1 blob 1\nx\n"), 0, 8, 64), /nobody asked for/);
});
