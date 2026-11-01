import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, View, type ViewStyle } from "react-native";
import { attachDrag, type DragAxis, type DragHandlers } from "./web";

/** Thickness across the divider, in points */
export const DIVIDER_SIZE = 8;
// RN's ViewStyle cursor type only lists auto/pointer; react-native-web accepts any CSS cursor
const RESIZE_CURSORS: Record<DragAxis, ViewStyle> = {
  x: { cursor: "col-resize" } as unknown as ViewStyle,
  y: { cursor: "row-resize" } as unknown as ViewStyle,
};

/**
 * A divider with a hairline down its middle that reports drags along `axis`: DOM pointer capture
 * on web, PanResponder on native
 */
export function ResizeDivider({
  axis,
  theme,
  accessibilityLabel,
  handlers,
}: {
  axis: DragAxis;
  theme: PluginTheme;
  accessibilityLabel: string;
  handlers: DragHandlers;
}) {
  const nodeRef = useRef<View>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [webAttached, setWebAttached] = useState(false);
  useEffect(() => {
    const detach = attachDrag(nodeRef.current, axis, {
      onStart: () => handlersRef.current.onStart(),
      onMove: (delta) => handlersRef.current.onMove(delta),
      onEnd: () => handlersRef.current.onEnd(),
    });
    setWebAttached(detach !== null);
    return detach ?? undefined;
  }, [axis]);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => handlersRef.current.onStart(),
        onPanResponderMove: (_event, gesture) => handlersRef.current.onMove(axis === "x" ? gesture.dx : gesture.dy),
        onPanResponderRelease: () => handlersRef.current.onEnd(),
        onPanResponderTerminate: () => handlersRef.current.onEnd(),
      }),
    [axis],
  );
  const across = axis === "x";
  return (
    <View
      ref={nodeRef}
      {...(webAttached ? {} : responder.panHandlers)}
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      style={[
        across
          ? { width: DIVIDER_SIZE, alignItems: "center" }
          : { height: DIVIDER_SIZE, justifyContent: "center" },
        { backgroundColor: theme.colors.surface0 },
        RESIZE_CURSORS[axis],
      ]}
    >
      <View style={[across ? { width: 1, flex: 1 } : { height: 1 }, { backgroundColor: theme.colors.border }]} />
    </View>
  );
}
