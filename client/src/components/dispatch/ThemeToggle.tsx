import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * ThemeToggle — переключатель темы (light/dark/system).
 * Использует next-themes (уже в deps). storage key = "dispatchos-theme".
 *
 * Сама ThemeProvider обёртка должна сидеть в App.tsx — см. `_theme-provider.tsx`.
 */
export function ThemeToggle() {
  const { t } = useT();
  const { setTheme, theme } = useTheme();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9" aria-label={t("dispatch.ThemeToggle.changeTheme")}>
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 h-4 w-4" /> {t("dispatch.ThemeToggle.light")} {theme === "light" && "·"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 h-4 w-4" /> {t("dispatch.ThemeToggle.dark")} {theme === "dark" && "·"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor className="mr-2 h-4 w-4" /> {t("dispatch.ThemeToggle.system")} {theme === "system" && "·"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
