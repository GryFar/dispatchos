import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useClipboard — copy text to clipboard with success feedback.
 *
 *   const { copied, copy } = useClipboard();
 *   <Button onClick={() => copy("DOS-XXXX-XXXX-XXXX")}>
 *     {copied ? "Скопировано" : "Копировать"}
 *   </Button>
 */
export function useClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mark as copied and schedule a reset, cancelling any pending reset first so
  // overlapping copy() calls don't flip `copied` back to false prematurely.
  const markCopied = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, resetMs);
  }, [resetMs]);

  // Clear any pending timer on unmount to avoid a state update on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      markCopied();
      return true;
    } catch {
      // Fallback for older browsers / non-https contexts.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        markCopied();
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [markCopied]);

  return { copied, copy };
}
