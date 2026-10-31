import { z } from "zod";

/**
 * Where the plugin's panes sit, independent of any one workspace: "rest" stands for everything
 * else in the workspace (chat, terminals); "files" is the side pane new file tabs open in (the
 * better-chat-management plugin's file area); Explorer and pinned tree views are left out
 */
export type ArrangementSlot = "rest" | "tree" | "git" | "files";
export type ArrangementNode =
  | { kind: "slot"; slot: ArrangementSlot }
  | { kind: "group"; direction: "horizontal" | "vertical"; children: ArrangementNode[]; sizes: number[] };

export const ArrangementSchema: z.ZodType<ArrangementNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("slot"), slot: z.enum(["rest", "tree", "git", "files"]) }),
    z.object({
      kind: z.literal("group"),
      direction: z.enum(["horizontal", "vertical"]),
      children: z.array(ArrangementSchema),
      sizes: z.array(z.number()),
    }),
  ]),
);
