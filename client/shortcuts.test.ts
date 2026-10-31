import assert from "node:assert/strict";
import { test } from "node:test";
import { CHORD_TIMEOUT_MS, createShortcutMatcher, type KeyStroke, shortcutLabel } from "./shortcuts.ts";

function stroke(key: string, modifiers: Partial<KeyStroke> = {}): KeyStroke {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key;
  return { key, code, ctrl: false, meta: false, shift: false, alt: false, ...modifiers };
}

test("single presses need exactly their modifiers", () => {
  const match = createShortcutMatcher(false);
  assert.equal(match(stroke("x", { ctrl: true }), 0), "cut");
  assert.equal(match(stroke("C", { shift: true, alt: true }), 0), "copyPath");
  assert.equal(match(stroke("C", { ctrl: true, shift: true, alt: true }), 0), null);
  assert.equal(match(stroke("x"), 0), null);
  assert.equal(match(stroke("F2"), 0), "rename");
  assert.equal(match(stroke("Delete"), 0), "delete");
});

test("letters match by physical key, so other keyboard layouts and Alt symbols still work", () => {
  const match = createShortcutMatcher(false);
  assert.equal(match({ ...stroke("Ç", { shift: true, alt: true }), code: "KeyC" }, 0), "copyPath");
});

test("a chord matches when its second press follows in time, across modifier presses", () => {
  const match = createShortcutMatcher(false);
  assert.equal(match(stroke("k", { ctrl: true }), 0), "pending");
  assert.equal(match(stroke("Shift", { ctrl: true, shift: true }), 100), "pending");
  assert.equal(match(stroke("C", { ctrl: true, shift: true }), 200), "copyRelativePath");
  // The chord is spent: a second Ctrl+Shift+C alone does nothing
  assert.equal(match(stroke("C", { ctrl: true, shift: true }), 300), null);
});

test("a chord expires, and another key breaks it", () => {
  const match = createShortcutMatcher(false);
  match(stroke("k", { ctrl: true }), 0);
  assert.equal(match(stroke("C", { ctrl: true, shift: true }), CHORD_TIMEOUT_MS + 1), null);
  match(stroke("k", { ctrl: true }), 0);
  assert.equal(match(stroke("x", { ctrl: true }), 10), "cut");
  assert.equal(match(stroke("C", { ctrl: true, shift: true }), 20), null);
});

test("macOS uses Cmd and refuses Ctrl in its place", () => {
  const match = createShortcutMatcher(true);
  assert.equal(match(stroke("c", { meta: true }), 0), "copy");
  assert.equal(match(stroke("c", { ctrl: true }), 0), null);
  assert.equal(match(stroke("Backspace", { meta: true }), 0), "delete");
});

test("labels follow the platform", () => {
  assert.equal(shortcutLabel("copyRelativePath", false), "Ctrl+K Ctrl+Shift+C");
  assert.equal(shortcutLabel("copyPath", false), "Shift+Alt+C");
  assert.equal(shortcutLabel("delete", false), "Del");
  assert.equal(shortcutLabel("copyPath", true), "Cmd+Option+C");
});
