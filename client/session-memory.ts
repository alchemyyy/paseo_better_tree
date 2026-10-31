// `paseo plugin reload` re-evaluates this bundle, so module-level state resets. The app's global
// object lives for the whole app session, so "done once this session" survives plugin reloads.

type SessionKind = "tree-opened" | "arranged" | "git-opened";

interface SessionMemory {
  done: Map<SessionKind, Set<string>>;
}

const GLOBAL_KEY = "__paseoBetterTreeSession";

function memory(): SessionMemory {
  const holder = globalThis as unknown as Record<string, SessionMemory | undefined>;
  const existing = holder[GLOBAL_KEY];
  if (existing) return existing;
  const created: SessionMemory = { done: new Map() };
  holder[GLOBAL_KEY] = created;
  return created;
}

/** Records `workspaceId` for `kind`; returns false when it was already recorded this session */
export function markOncePerSession(kind: SessionKind, workspaceId: string): boolean {
  const { done } = memory();
  let workspaces = done.get(kind);
  if (!workspaces) {
    workspaces = new Set();
    done.set(kind, workspaces);
  }
  if (workspaces.has(workspaceId)) return false;
  workspaces.add(workspaceId);
  return true;
}
