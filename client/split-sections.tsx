import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { resizeFractions } from "./git-model";
import { DIVIDER_SIZE, ResizeDivider } from "./resize-divider";
import type { DragHandlers } from "./web";

/** Vertical stack of sections with draggable dividers; fractions sum to 1 */
export function SplitSections({
  sections,
  fractions,
  theme,
  onFractionsChange,
}: {
  sections: readonly ReactNode[];
  fractions: readonly number[];
  theme: PluginTheme;
  onFractionsChange(fractions: number[]): void;
}) {
  const [dragFractions, setDragFractions] = useState<number[] | null>(null);
  const shown = dragFractions ?? fractions;
  // Space the sections share: total height minus the dividers
  const sectionsHeightRef = useRef(1);
  const fractionsRef = useRef(fractions);
  fractionsRef.current = fractions;
  const changeRef = useRef(onFractionsChange);
  changeRef.current = onFractionsChange;
  const dragRef = useRef<{ start: readonly number[]; latest: number[] | null } | null>(null);

  const dividerCallbacks = useMemo(
    () =>
      sections.slice(0, -1).map(
        (_, index): DragHandlers => ({
          onStart: () => {
            dragRef.current = { start: fractionsRef.current, latest: null };
          },
          onMove: (deltaY) => {
            const drag = dragRef.current;
            if (!drag) return;
            drag.latest = resizeFractions(drag.start, index, deltaY / sectionsHeightRef.current);
            setDragFractions(drag.latest);
          },
          onEnd: () => {
            const latest = dragRef.current?.latest;
            dragRef.current = null;
            if (latest) changeRef.current(latest);
            setDragFractions(null);
          },
        }),
      ),
    [sections.length],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const dividers = Math.max(0, sections.length - 1) * DIVIDER_SIZE;
    sectionsHeightRef.current = Math.max(1, event.nativeEvent.layout.height - dividers);
  };

  const children: ReactNode[] = [];
  sections.forEach((section, index) => {
    // flexBasis 0 makes heights follow the fractions exactly instead of content size
    children.push(
      <View
        key={`section-${index}`}
        style={{ flexGrow: shown[index] ?? 1, flexShrink: 1, flexBasis: 0, minHeight: 0, overflow: "hidden" }}
      >
        {section}
      </View>,
    );
    const callbacks = dividerCallbacks[index];
    if (callbacks) {
      children.push(
        <ResizeDivider key={`divider-${index}`} axis="y" theme={theme} accessibilityLabel="Resize sections" handlers={callbacks} />,
      );
    }
  });

  return (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={handleLayout}>
      {children}
    </View>
  );
}
