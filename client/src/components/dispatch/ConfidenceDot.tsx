import { cn } from "@/lib/utils";

/**
 * ConfidenceDot — маленькая цветная точка 8x8px для location confidence
 * в таблицах. Без текста — подпись рядом.
 */
export function ConfidenceDot({
  level,
  className,
}: {
  level: "high" | "medium" | "low";
  className?: string;
}) {
  return (
    <span
      aria-label={`Confidence: ${level}`}
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        level === "high" && "bg-confidence-high",
        level === "medium" && "bg-confidence-medium",
        level === "low" && "bg-confidence-low",
        className,
      )}
    />
  );
}
