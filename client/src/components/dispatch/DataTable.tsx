import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { densityClass, type Density } from "@/lib/density";
import { EmptyState } from "./EmptyState";
import { useT } from "@/lib/i18n";

/**
 * DataTable — лёгкая обёртка над <table> с поддержкой density,
 * loading skeleton, empty state. Без virtualization, без sorting под капотом —
 * это в Phase 2 не нужно; добавим в Phase 5 если упрёмся в производительность.
 *
 * Колонки описываются как массив объектов, что проще и типизированнее, чем
 * children с TableRow. Это — паттерн админок.
 */

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  /** Render the cell. Receives the row and the row index. */
  cell: (row: T, index: number) => ReactNode;
  /** Right-align (useful for numbers). */
  align?: "left" | "right" | "center";
  /** Fixed width hint (CSS, e.g. "120px" or "12rem"). */
  width?: string;
  /** Use mono font in this column (e.g. $/PPM/MC). */
  mono?: boolean;
  /** Hide on mobile (< sm breakpoint). */
  hideOnMobile?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  loading?: boolean;
  density?: Density;
  /** Row click handler. Adds cursor-pointer + hover. */
  onRowClick?: (row: T) => void;
  /** Key extractor. Defaults to row.id or index. */
  rowKey?: (row: T, index: number) => string | number;
  /** Empty state shown when rows is empty and not loading. */
  empty?: ReactNode;
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  loading,
  density = "comfortable",
  onRowClick,
  rowKey,
  empty,
  className,
}: DataTableProps<T>) {
  const { t } = useT();
  const cellPad = densityClass(density, {
    compact: "py-2 px-3",
    comfortable: "py-3 px-4",
  });
  const headerPad = densityClass(density, {
    compact: "py-2 px-3 text-xs",
    comfortable: "py-2.5 px-4 text-xs",
  });
  const textSize = densityClass(density, {
    compact: "text-xs",
    comfortable: "text-sm",
  });

  if (loading) {
    return (
      <div className={cn("overflow-hidden rounded-lg border border-border bg-card shadow-card", className)}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead className="bg-muted/60">
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn(
                      headerPad,
                      "border-b border-border font-medium uppercase tracking-wider text-muted-foreground",
                      (!c.align || c.align === "left") && "text-left",
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      c.hideOnMobile && "hidden sm:table-cell",
                    )}
                    style={c.width ? { width: c.width } : undefined}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(cellPad, c.hideOnMobile && "hidden sm:table-cell")}
                    >
                      <div className="h-3 w-3/4 animate-skeleton" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return empty ? (
      <>{empty}</>
    ) : (
      <EmptyState title={t("dispatch.DataTable.emptyTitle")} description={t("dispatch.DataTable.emptyDescription")} />
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card shadow-card", className)}>
      <div className="overflow-x-auto">
        <table className={cn("w-full border-collapse", textSize)}>
          <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(
                    headerPad,
                    "border-b border-border font-medium uppercase tracking-wider text-muted-foreground",
                    (!c.align || c.align === "left") && "text-left",
                    c.align === "right" && "text-right",
                    c.align === "center" && "text-center",
                    c.hideOnMobile && "hidden sm:table-cell",
                  )}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="animate-stagger">
            {rows.map((row, i) => (
              <tr
                key={rowKey ? rowKey(row, i) : (row as { id?: string | number }).id ?? i}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  "border-b border-border transition-colors last:border-0",
                  onRowClick && "cursor-pointer hover:bg-muted/40",
                )}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      cellPad,
                      "align-middle text-foreground",
                      c.align === "right" && "text-right",
                      c.align === "center" && "text-center",
                      c.mono && "font-mono tabular-nums",
                      c.hideOnMobile && "hidden sm:table-cell",
                    )}
                  >
                    {c.cell(row, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
