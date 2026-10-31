// Panels cannot reach the client context, so the entry registers how to open the Git panel
let openGit: ((workspaceId: string) => void) | null = null;

export function setGitPanelOpener(opener: ((workspaceId: string) => void) | null): void {
  openGit = opener;
}

export function openGitPanel(workspaceId: string): void {
  try {
    openGit?.(workspaceId);
  } catch (error) {
    console.warn("[better-tree] Could not open the Git panel", error);
  }
}
