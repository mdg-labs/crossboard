import { ExternalLink, userUrl } from "@/components/detail/issue-link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export function Person({
  login,
  avatarUrl,
  origin,
}: {
  login: string;
  avatarUrl: string | null;
  origin: string;
}): React.ReactElement {
  return (
    <ExternalLink
      className="inline-flex items-center gap-1.5 hover:underline"
      href={userUrl(origin, login)}
    >
      <Avatar className="size-5">
        {avatarUrl === null ? null : <AvatarImage alt="" src={avatarUrl} />}
        <AvatarFallback>{login.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      {login}
    </ExternalLink>
  );
}
