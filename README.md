# Better tree

Paseo plugin that adds a VS Code-style file tree, a Git panel, diff views, and commit views to Paseo workspaces.

## Install

Requires [Paseo](https://paseo.sh) 0.13.0 or later with plugins turned on (Settings > Plugins > Enable plugins).

```sh
paseo plugin install https://github.com/alchemyyy/paseo_better_tree
```

`paseo plugin update better-tree` updates it, and `paseo plugin remove better-tree` removes it. The [Plugin manager](https://github.com/alchemyyy/paseo_plugin_manager) plugin checks and updates installed plugins from the sidebar.

The `paseo` command comes with the desktop app: Settings > Integrations > Command line puts it on `PATH`, or run `paseo.cmd` from the app's `resources\bin` folder.

To work on the plugin, clone this repository and install the folder instead (`paseo plugin install <folder>`), then run `paseo plugin reload better-tree` after editing it.

## Features

### File tree

- **File tree** panel, available in Explorer and as a workspace pane, with a header button in every workspace. Directories list first, then natural name order, with Material Icon Theme file icons. Git repository and worktree folders (those holding `.git`) show their names in violet (`#c4b5fd`, the color better-chat-management gives branch names in the sidebar), ahead of any Git change color.
- Row buttons on hover: attach to chat; for folders, open in a new tree view (pinned folder); for Git repository folders, focus git repo. Pinned folders open as extra **Pinned folder** tree views in their own panes; the button or menu entry unpins them.
- Toolbar: go up one folder, back to the workspace folder, color Git changes in the tree, open the Git panel.
- The tree refreshes the folders it shows every 4 seconds; folders inside a closed folder wait until it opens. Resting the pointer on a closed folder loads its contents, so it opens at once.
- **Filter** field at the bottom of the tree searches the tree's whole folder, not just the open folders. Every space-separated term must appear, ignoring case, in an entry's name or the names of the folders above it, at least one in its own name (`comp tree` finds tree files inside components folders); a term with a slash matches the path instead (`src/comp`). Matches show inside their folders with the matched text marked. Clicking a file opens it; clicking a matching folder with no matches inside it, or Reveal in tree in the menu, ends the filter and shows the entry in the full tree. Enter opens the first match, Escape clears the field. The view keeps its filter when Paseo rebuilds its pane and across restarts. In a Git repository (and in each one inside a plain folder) gitignored files are skipped, and node_modules folders are found by name but not searched through. At most 1,000 matches are listed, nearest the top first.
- Selecting several rows: Ctrl+click (Cmd+click on macOS) adds or removes a row, Shift+click selects the run of rows from the last Ctrl+clicked or plainly clicked row, and Ctrl+Shift+click adds that run. These clicks never open files or open and close folders. A plain click selects one row and opens it; clicking blank space in the tree clears the selection. Keyboard shortcuts and the context menu's other items act on the row clicked last.
- Drag and drop moves entries between folders (never overwriting or moving into themselves); dropping onto a chat composer attaches the entry. Dragging a selected row takes the whole selection: onto a folder it moves them all, onto a composer it attaches them all.
- **Attach to chat** inserts the entry's quoted path, relative to the agent's or draft's working folder, into the last focused composer; on a selected row in the context menu it attaches the whole selection (**Attach N items to chat**). Without a composer it copies the paths and shows a toast.
- Context menu (long-press/right-click; blank space acts on the root): New file, New folder, Open, Open to the side, Open in Default Text Editor, Open with default app, Open in file browser, Open terminal, Set as root folder, Open in new tree view / Unpin tree view, Focus git repo (on Git repository folders), Attach to chat, Cut, Copy, Paste, Copy path, Copy relative path, Rename, Delete; while filtering, Reveal in tree.
- **Set as root folder** re-roots the tree view at that folder, keeping the folders open inside it open; the toolbar's up and back buttons leave it. On a Git repository folder it also brings up the Git panel on that repository: the main tree's Git panel follows its root folder, and a pinned view focuses the repository there.
- Paste copies or moves; a taken name becomes `<name> copy`, `<name> copy 2`, ... Create and rename never overwrite and reject names Windows refuses. Delete asks for confirmation and moves to the Recycle Bin or Trash.
- Keyboard shortcuts (macOS in parentheses): Cut Ctrl+X, Copy Ctrl+C, Paste Ctrl+V, Copy path Shift+Alt+C (Cmd+Option+C), Copy relative path Ctrl+K Ctrl+Shift+C (Cmd+Shift+Option+C), Rename F2 (Enter), Delete Del (Cmd+Backspace), Open in file browser Shift+Alt+R (Cmd+Option+R), Filter Ctrl+F (Cmd+F).
- Display: Ctrl+scroll changes row spacing (0-16px, default 3), Shift+scroll text weight (100-900, default 400), Alt+scroll text size (9-24px, default 13); the same modifier with middle-click resets.
- Host actions run on the daemon host: default text editor from the registry (Windows) or `xdg-open`; Windows Terminal or cmd, Terminal.app, or the first available Linux terminal; Explorer, Finder, or a freedesktop file manager with the file selected. On Windows, a folder already open in Explorer on the current virtual desktop (in a window or a tab) comes to the front, switched to that tab and with the file selected, instead of a second window opening.

### Git panel

- **Git** pane (header button in every workspace) with resizable sections: Branches and worktrees, changes, commit, History. The sections show as soon as git lists the worktrees; the changes, history, and each worktree's line totals then fill in on their own.
- Follows the main file tree's root folder: it shows the repository holding that folder, so setting a repository as the root folder, or going up or back to the workspace folder, switches it. A root folder outside Git lists the repositories inside it instead: the outermost ones at any depth, in tree order, with their branches (node_modules folders are not searched, and a very large folder may be searched only in part). The search runs only for such a folder, and the list fills in once it finishes. Clicking one shows it.
- Changes list with line totals, stage/unstage checkboxes per file, folder, and category, a Tracked/Untracked filter, and Group and Folders toggles. Clicking a file opens its diff; resting the pointer on a file first loads it, so the diff opens at once. Its context menu (right-click/long-press on a file or folder): **Go to file** / **Go to folder**, Show in file explorer, Add to .gitignore, Revert.
- **Go to file** selects the file in the main file tree and gives the tree the keyboard: the folders above it open, the tree scrolls to it, and the tree comes into view, opening if it is closed. A deleted file leaves the folder it was in selected, with a note; a file outside the tree's root folder only gets a note.
- Commit editor: Commit (staged), Commit Tracked, or Amend; Ctrl+Enter (Cmd+Enter) commits; full-screen message editor; Fetch, Pull, Push.
- History: relative commit times and branch labels, uncommit (keeps changes staged), and check out a commit: switch to a branch at it, detached HEAD, or a new worktree beside the current one. Clicking a commit opens it in a Commit tab (below).
- Refreshes live: the daemon watches each worktree and its git directory and answers a long-poll on change. A change refreshes only that worktree's changes, totals, and open diffs, and its history and branch names when HEAD or a branch moved. Other worktrees' totals refresh every minute, and a root folder's repository list every five minutes.
- Trees, Git panels, and diff tabs of other workspaces or in background tabs stay mounted in Paseo but stop refreshing until they show again; then anything out of date reloads at once.
- Git runs off the plugin's main thread, a few polling reads at a time behind anything the user asked for, and a polling read gives up after 30 seconds. Diffs read HEAD's copy of a file through a running `git cat-file` instead of starting git each time.
- **Focus git repo** in the tree's menu shows that repository in the Git panel, opening the panel if it is closed, and selects the folder's own worktree. A bar at the top of the panel names a repository focused this way or picked from the list; its X goes back to the root folder's repository or list. Changing the main tree's root folder drops the focus; otherwise the panel keeps it across restarts.
- Stands in for Paseo's own Changes view: the composer's Changes pill and every other way Paseo opens Changes (keyboard shortcuts, the command palette, the new-tab menu) open the Git panel instead, and Explorer's Changes tab is closed whenever the dock is on screen. Phones keep Paseo's Changes.

### Diffs

- **Diff** tabs show a file against HEAD as Unified, Changes only, or Split (original side in a pane to the right, scroll-synced). Tabs are labeled with the file name, colored by change.
- Paseo's own file editor gets a view selector beside "Ln, Col": Source, Unified diff, Changes only, Split diff. The last choice per file is remembered.

### Commits

- Clicking a commit in History opens it in a **Commit** tab where files open (better-chat-management's file area when that plugin runs), labeled with the commit's subject, with its id in the tooltip. Clicking the commit again reveals its tab. Up to six commits stay open at once; opening another reuses the tab whose commit was opened longest ago. Commit tabs move, split, close, and reopen across restarts like file tabs.
- The tab shows the commit's subject, id (with a copy button), author, date, file count, line totals, and message, then splits like editor-enhancements' Markdown Split: the files the commit changed, as a tree of folders, beside an editor view of the selected file. Drag the divider to resize (10-90%, kept for every Commit tab); on phones the tree sits above the editor view.
- The tree uses the file tree's file icons, row spacing, text weight, and text size. Each file is colored by its change (new green, edited amber, deleted red and struck through), shows its old name when renamed, its line totals, and its change letter (A, M, D, R, C, T). A chain of folders holding one folder each shows as one row; clicking a folder opens or closes it. Clicking a file shows it, and the tab remembers the file and view.
- The editor view compares the file with the commit's first parent (the header says so for a merge; a first commit compares with nothing): **Unified**, **Changes only**, **Split** (parent on the left, commit on the right, scroll-synced), or **File** (the file at the commit, or for a deletion the text it deleted, changed lines marked). Binary files and files over 4 MB show a note instead.
- Everything comes from the local repository, never a remote. File texts are read through one `git cat-file --batch` kept running per worktree while you browse (it exits after a minute unused), since starting git for every file takes tens to hundreds of milliseconds on Windows.

### Settings and layout

Settings > Better tree (stored per host):

- **Pin the file tree** (on): opens the tree in Explorer when a workspace opens.
- **Move the file tree beside the chat** (on): moves the tree out of Explorer into a workspace pane, once per workspace per session; Explorer is then hidden if only Paseo's Files is left in it.
- **Open the Git panel** (on): opens Git below the file tree in every workspace, once per workspace per session.
- Reset buttons for row spacing, text weight, and text size.

Pane arrangement and sizes of the tree and Git panes, Explorer width, Git section heights, and the changes tree's share of Commit tabs are saved and applied to every workspace. Dragging a divider of the tree, Git, or file-area pane resizes it in every workspace at once, not just when you next switch to one. The tree and Git panes keep the same widths everywhere: in a workspace without a Git pane or without the better-chat-management plugin's file area, the chat side takes up the missing pane's space, and a drag there leaves the missing pane's saved place and size alone.

## Limitations

- Paseo's plugin SDK cannot open file tabs, split panes, or relabel tabs, so the plugin reads Paseo's internal pane context and layout store and patches its tab strip and file toolbar DOM. A Paseo update can break these parts.
- The CodeMirror diff view, toolbar selector, tab labels, and keyboard shortcuts work on web/desktop only; native clients get a plain line diff in Diff and Commit tabs.
- The tree polls the folders it shows rather than watching them.

## Development

- `npm run vendor` (`scripts/vendor.mjs`) bundles CodeMirror into `client/vendor/` and copies Material Icon Theme icons into `server/vendor/`, since an installed plugin has no `node_modules`. Run it after changing those devDependencies.
- `npm run typecheck`, `npm test`.
