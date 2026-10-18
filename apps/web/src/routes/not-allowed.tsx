import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";

export function NotAllowedRoute(): React.ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>This account is not allowed</EmptyTitle>
          <EmptyDescription>
            The GitHub account you signed in with is not allowed on this
            instance. Ask the person who runs it to add your account or your
            organization, or sign in with a different account.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button render={<a href="/auth/login" />}>
            Sign in with another account
          </Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}
