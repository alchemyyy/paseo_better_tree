import assert from "node:assert/strict";
import { test } from "node:test";
import { chainSome, wrapStoreAction } from "./layout-wrap.ts";

type Open = (value: string) => string;

function createStore(open: Open) {
  let state: Record<string, unknown> = { open };
  return {
    getState: () => state,
    setState: (partial: object) => {
      state = { ...state, ...partial };
    },
    call: (value: string) => (state.open as Open)(value),
  };
}

const tagging = (tag: string) => (next: Open) => (value: string) => `${tag}(${next(value)})`;

test("wrappers from two owners compose, and reinstalling one keeps the other", () => {
  const store = createStore((value) => value);
  wrapStoreAction(store, "open", "tree", tagging("tree1"));
  wrapStoreAction(store, "open", "chat", tagging("chat"));
  assert.equal(store.call("x"), "chat(tree1(x))");
  // A reload of the tree plugin replaces its buried wrapper and goes on top
  wrapStoreAction(store, "open", "tree", tagging("tree2"));
  assert.equal(store.call("x"), "tree2(chat(x))");
});

test("removing a wrapper splices it out wherever it sits", () => {
  const store = createStore((value) => value);
  const removeTree = wrapStoreAction(store, "open", "tree", tagging("tree"));
  const removeChat = wrapStoreAction(store, "open", "chat", tagging("chat"));
  removeTree();
  assert.equal(store.call("x"), "chat(x)");
  removeChat();
  assert.equal(store.call("x"), "x");
});

test("an owner's pre-protocol wrapper is unwrapped through its legacy original", () => {
  const native: Open = (value) => value;
  const legacy = Object.assign((value: string) => `legacy(${native(value)})`, { original: native });
  const store = createStore(legacy);
  const legacyOriginal = (fn: object) => ("original" in fn ? (fn.original as Open) : undefined);
  wrapStoreAction(store, "open", "chat", tagging("chat"), { legacyOriginal });
  assert.equal(store.call("x"), "chat(x)");
});

test("chainSome finds a marked wrapper under another plugin's wrapper", () => {
  const store = createStore((value) => value);
  wrapStoreAction(store, "open", "chat", tagging("chat"), { props: { mark: true } });
  wrapStoreAction(store, "open", "tree", tagging("tree"));
  assert.equal(chainSome(store.getState().open, (fn) => "mark" in fn), true);
  assert.equal(chainSome((value: string) => value, (fn) => "mark" in fn), false);
});
