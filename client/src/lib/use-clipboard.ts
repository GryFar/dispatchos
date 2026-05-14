import { useCallback, useState } from "react";

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

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetMs);
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
        setCopied(true);
        setTimeout(() => setCopied(false), resetMs);
        return true;
      } catch {
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [resetMs]);

  return { copied, copy };
}
