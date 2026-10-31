import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { fileIconRpc } from "../shared/contracts";

// Relative luminance above which a background counts as light
const LIGHT_LUMINANCE = 0.5;

/** Whether a CSS color (#rgb, #rrggbb, rgb(), rgba()) is light; anything unparsed counts as dark */
export function isLightColor(color: string): boolean {
  const value = color.trim().toLowerCase();
  let channels: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit) : hex[1].match(/../g)!;
    channels = digits.map((pair) => parseInt(pair, 16));
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
    if (rgb) channels = rgb.slice(1, 4).map(Number);
  }
  if (!channels) return false;
  const [red, green, blue] = channels.map((channel) => channel / 255);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue > LIGHT_LUMINANCE;
}

/** A listed file's colored type icon; the plain file icon until it loads or without one */
export function FileIcon({ icon, size, theme }: { icon: string | undefined; size: number; theme: PluginTheme }) {
  const loadIcon = useRpc(fileIconRpc);
  const light = isLightColor(theme.colors.surface0);
  // Icons never change while the plugin runs, so each one is fetched once per theme brightness
  const { data } = useQuery({
    queryKey: ["better-tree", "file-icon", icon, light],
    queryFn: () => loadIcon({ icon: icon ?? "", light }),
    enabled: icon !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (!data) return <Icon name="File" size={size} color={theme.colors.foregroundMuted} />;
  return <Icon icon={data} size={size} color={theme.colors.foregroundMuted} />;
}
