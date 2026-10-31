import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, PanResponder, View, type ViewStyle } from "react-native";
import { resizeFractions } from "./git-model";
import { attachVerticalDrag } from "./web";

const HANDLE_HEIGHT = 8;
// RN's ViewStyle cursor type only lists auto/pointer; react-native-web accepts any CSS cursor
const RESIZE_CURSOR = { cursor: "row-resize" } as unknown as ViewStyle;

interface DragCallbacks {
  onStart(): void;
  onMove(deltaY: number): void;
  onEnd(): void;
}

/** Divider that reports vertical drags: DOM pointer capture on web, PanResponder on native */
function Divider({ theme, callbacks }: { theme: PluginTheme; callbacks: DragCallbacks }) {
  const nodeRef = useRef<View>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [webAttached, setWebAttached] = useState(false);
  useEffect(() => {
    const detach = attachVerticalDrag(nodeRef.current, {
      onStart: () => callbacksRef.current.onStart(),
      onMove: (deltaY) => callbacksRef.current.onMove(deltaY),
      onEnd: () => callbacksRef.current.onEnd(),
    });
    setWebAttached(detach !== null);
    return detach ?? undefined;
  }, []);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => callbacksRef.current.onStart(),
        onPanResponderMove: (_event, gesture) => callbacksRef.current.onMove(gesture.dy),
        onPanResponderRelease: () => callbacksRef.current.onEnd(),
        onPanResponderTerminate: () => callbacksRef.current.onEnd(),
      }),
    [],
  );
  return (
    <View
      ref={nodeRef}
      {...(webAttached ? {} : responder.panHandlers)}
      accessibilityRole="adjustable"
      accessibilityLabel="Resize sections"
      style={[
        { height: HANDLE_HEIGHT, justifyContent: "center", backgroundColor: theme.colors.surface0 },
        RESIZE_CURSOR,
      ]}
    >
      <View style={{ height: 1, backgroundColor: theme.colors.border }} />
    </View>
  );
}

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
        (_, index): DragCallbacks => ({
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
    const dividers = Math.max(0, sections.length - 1) * HANDLE_HEIGHT;
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
    if (callbacks) children.push(<Divider key={`divider-${index}`} theme={theme} callbacks={callbacks} />);
  });

  return (
    <View style={{ flex: 1, minHeight: 0 }} onLayout={handleLayout}>
      {children}
    </View>
  );
}
