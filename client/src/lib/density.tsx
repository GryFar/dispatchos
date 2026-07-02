/**
 * Density modes — compact for tables, comfortable for the rest.
 *
 * Usage:
 *   const cls = densityClass(density, { compact: "h-8", comfortable: "h-9" });
 *
 * Wrap a subtree in <DensityProvider value="compact"> to advertise the active
 * density to descendants via context.
 */

import { createContext, type ReactNode } from "react";

export type Density = "compact" | "comfortable";

const DensityContext = createContext<Density>("comfortable");

export function DensityProvider({
  value,
  children,
}: {
  value: Density;
  children: ReactNode;
}) {
  return <DensityContext.Provider value={value}>{children}</DensityContext.Provider>;
}

export function densityClass(
  density: Density,
  variants: { compact: string; comfortable: string },
): string {
  return density === "compact" ? variants.compact : variants.comfortable;
}
