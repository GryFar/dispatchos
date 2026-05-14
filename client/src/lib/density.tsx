/**
 * Density modes — compact for tables, comfortable for the rest.
 *
 * Usage:
 *   const cls = densityClass(density, { compact: "h-8", comfortable: "h-9" });
 *
 * Or with the React context if you wrap a subtree in <DensityProvider>:
 *   const density = useDensity();
 */

import { createContext, useContext, type ReactNode } from "react";

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

export function useDensity(): Density {
  return useContext(DensityContext);
}

export function densityClass(
  density: Density,
  variants: { compact: string; comfortable: string },
): string {
  return density === "compact" ? variants.compact : variants.comfortable;
}
