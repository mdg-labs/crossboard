import { Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { toastManager } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar";
import { api } from "@/lib/api";
import { meQuery } from "@/lib/me";

export function UserMenu(): React.ReactElement {
  const me = useQuery(meQuery);
  const signOut = useMutation({
    mutationFn: async () => {
      const response = await api.auth.logout.$post(undefined, {
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) {
        throw new Error(`The server answered ${response.status}.`);
      }
    },
    onSuccess: () => window.location.assign("/auth/login"),
    onError: () =>
      toastManager.add({
        type: "error",
        title: "Could not sign out",
        description: "Check your connection and try again.",
      }),
  });
  const user = me.data?.user;

  return (
    <Menu>
      <MenuTrigger
        render={
          <ToolbarButton
            render={
              <Button aria-label="User menu" size="icon-sm" variant="ghost" />
            }
          />
        }
      >
        <Avatar className="size-6">
          {user ? <AvatarImage alt="" src={user.avatarUrl} /> : null}
          <AvatarFallback aria-hidden="true">
            {user ? user.login.slice(0, 1).toUpperCase() : "?"}
          </AvatarFallback>
        </Avatar>
      </MenuTrigger>
      <MenuPopup align="end">
        {user ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>
                Signed in as{" "}
                <span className="text-foreground">{user.login}</span>
              </MenuGroupLabel>
            </MenuGroup>
            <MenuSeparator />
          </>
        ) : null}
        <MenuLinkItem render={<Link to="/settings" />}>
          <SettingsIcon aria-hidden="true" />
          Settings
        </MenuLinkItem>
        <MenuItem disabled={signOut.isPending} onClick={() => signOut.mutate()}>
          <LogOutIcon aria-hidden="true" />
          Sign out
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
