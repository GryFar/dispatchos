import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, User as UserIcon, Mail, Phone, Save } from "lucide-react";
import type { UpdateDriverProfileInput, UserPublic } from "@shared/schema";
import { apiJson, ApiError } from "@/lib/queryClient";
import { useAuth, refreshAuth } from "@/lib/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/lib/i18n";

/**
 * Driver profile (`/d/profile`).
 *
 * Показывает email/role/fullName/phone из /api/me. Позволяет редактировать
 * fullName и phone через PATCH /api/me/profile. Email и role изменяются
 * только админом — поэтому здесь они read-only.
 *
 * Logout — POST /api/auth/logout, потом /api/me возвращает 401, useAuth
 * это видит, RoleGate выкидывает на /login.
 */
export default function DriverProfilePage() {
  const { t } = useT();
  const { user, isLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Local form state — initialised from server data once it loads. We don't
  // bind directly to the query result so the user can edit without their
  // change being clobbered by a background refetch.
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (user && !dirty) {
      setFullName(user.fullName);
      setPhone(user.phone ?? "");
    }
  }, [user, dirty]);

  const updateProfile = useMutation({
    mutationFn: (patch: UpdateDriverProfileInput) =>
      apiJson<UserPublic>("PATCH", "/api/me/profile", patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      queryClient.invalidateQueries({ queryKey: ["me", "dashboard"] });
      setDirty(false);
      toast({ title: t("driver.profile.saved") });
    },
    onError: (err) => {
      toast({
        title: t("driver.profile.save_error"),
        description: err instanceof ApiError ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  const logout = useMutation({
    mutationFn: () => apiJson<{ ok: true }>("POST", "/api/auth/logout"),
    onSuccess: async () => {
      await refreshAuth();
      setLocation("~/login");
    },
    onError: (err) => {
      toast({
        title: t("common.error"),
        description: err instanceof ApiError ? err.message : String(err),
        variant: "destructive",
      });
    },
  });

  if (isLoading || !user) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-32" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    );
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const patch: UpdateDriverProfileInput = {};
    if (fullName !== user.fullName) patch.fullName = fullName.trim();
    if ((phone || undefined) !== user.phone) {
      // empty string clears phone — backend accepts string >=3 chars, so we
      // skip the PATCH for now if cleared. Phase 1 enhancement: accept null.
      if (phone.trim().length === 0) {
        toast({
          title: t("common.error"),
          description: "Phone cannot be cleared in P0 — replace with a new number instead.",
        });
        return;
      }
      patch.phone = phone.trim();
    }
    if (Object.keys(patch).length === 0) {
      toast({ title: t("common.success") });
      return;
    }
    updateProfile.mutate(patch);
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">{t("driver.profile.title")}</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("driver.profile.header_sub")}
        </p>
      </header>

      <form onSubmit={onSubmit}>
        <Card className="p-4">
          <div className="flex items-center gap-3 pb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
              <UserIcon className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{user.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div>
              <Label htmlFor="fullName" className="text-xs">
                {t("driver.profile.full_name")}
              </Label>
              <Input
                id="fullName"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  setDirty(true);
                }}
                className="mt-1 h-11"
                autoComplete="name"
              />
            </div>

            <div>
              <Label htmlFor="phone" className="text-xs">
                {t("driver.profile.phone")}
              </Label>
              <div className="relative mt-1">
                <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="phone"
                  value={phone}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setDirty(true);
                  }}
                  className="h-11 pl-9"
                  inputMode="tel"
                  placeholder="+1 555 0100"
                  autoComplete="tel"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="email" className="text-xs">
                {t("common.email")}{" "}
                <span className="text-muted-foreground">(admin-only)</span>
              </Label>
              <div className="relative mt-1">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="email"
                  value={user.email}
                  readOnly
                  disabled
                  className="h-11 pl-9"
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Button
              type="submit"
              size="lg"
              disabled={!dirty || updateProfile.isPending}
            >
              <Save className="mr-2 h-4 w-4" />
              {updateProfile.isPending ? t("common.loading") : t("common.save")}
            </Button>
          </div>
        </Card>
      </form>

      <Card className="p-4">
        <Button
          variant="outline"
          size="lg"
          className="w-full justify-center"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {logout.isPending ? t("common.loading") : t("common.signOut")}
        </Button>
      </Card>
    </div>
  );
}
