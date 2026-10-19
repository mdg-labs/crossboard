import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardPanel,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

const TOKEN_REJECTED =
  "That setup token is not valid. Check the setup-token file in the data directory.";
const SESSION_EXPIRED =
  "The setup session has expired. Enter the setup token again.";
const UNREACHABLE = "The server could not be reached. Try again.";

class SetupRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<SetupRequestError> {
  let message = `The server answered ${response.status}.`;
  try {
    const body: unknown = await response.json();
    const text = (body as { error?: { message?: unknown } }).error?.message;
    if (typeof text === "string" && text !== "") message = text;
  } catch {
    // The status line above is all there is to show.
  }
  return new SetupRequestError(message, response.status);
}

const messageOf = (error: Error) =>
  error instanceof SetupRequestError ? error.message : UNREACHABLE;

interface ManifestSubmission {
  manifest: unknown;
  url: string;
  state: string;
}

function TokenStep({
  expired,
  onVerified,
}: {
  expired: boolean;
  onVerified: () => void;
}) {
  const verify = useMutation({
    mutationFn: async (token: string) => {
      const response = await api.api.setup.token.$post({ json: { token } });
      if (!response.ok) throw await failure(response);
    },
    onSuccess: onVerified,
  });
  const error = verify.error
    ? verify.error instanceof SetupRequestError && verify.error.status === 401
      ? TOKEN_REJECTED
      : messageOf(verify.error)
    : expired
      ? SESSION_EXPIRED
      : null;

  return (
    <Card>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          const token = new FormData(event.currentTarget).get("token");
          verify.mutate(typeof token === "string" ? token.trim() : "");
        }}
      >
        <CardHeader>
          <CardTitle>Set up Crossboard</CardTitle>
          <CardDescription>
            This instance has no GitHub App yet. Enter the setup token from the
            setup-token file in the data directory (
            {"docker exec <container> cat /data/setup-token"}).
          </CardDescription>
        </CardHeader>
        <CardPanel>
          <Field invalid={error !== null} name="token">
            <FieldLabel>Setup token</FieldLabel>
            <Input
              autoComplete="off"
              autoFocus
              required
              spellCheck={false}
              type="password"
            />
            <FieldError match={error !== null}>{error}</FieldError>
          </Field>
        </CardPanel>
        <CardFooter>
          <Button loading={verify.isPending} type="submit">
            Continue
          </Button>
        </CardFooter>
      </Form>
    </Card>
  );
}

function AppStep({ onExpired }: { onExpired: () => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  const create = useMutation({
    mutationFn: async (input: { organization?: string; name: string }) => {
      const response = await api.api.setup.manifest.$post({ json: input });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as ManifestSubmission;
    },
    onError: (error) => {
      if (error instanceof SetupRequestError && error.status === 401) {
        onExpired();
      }
    },
  });
  const submission = create.data;
  const { reset } = create;

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) reset();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [reset]);

  useEffect(() => {
    if (submission !== undefined) formRef.current?.submit();
  }, [submission]);

  return (
    <Card>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const organization = String(data.get("organization") ?? "").trim();
          create.mutate({
            ...(organization === "" ? {} : { organization }),
            name: String(data.get("name") ?? "").trim(),
          });
        }}
      >
        <CardHeader>
          <CardTitle>Create the GitHub App</CardTitle>
          <CardDescription>
            GitHub shows the App with all settings filled in. Confirm the name
            there and click Create.
          </CardDescription>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          <Field name="organization">
            <FieldLabel>Owning organization</FieldLabel>
            <Input autoComplete="off" spellCheck={false} />
            <FieldDescription>
              The GitHub organization login that should own the App. Leave empty
              to use your personal account.
            </FieldDescription>
          </Field>
          <Field name="name">
            <FieldLabel>App name</FieldLabel>
            <Input
              defaultValue={`Crossboard (${window.location.host})`}
              required
            />
          </Field>
          {create.isError && !create.isPending && (
            <Field invalid>
              <FieldError match>{messageOf(create.error)}</FieldError>
            </Field>
          )}
        </CardPanel>
        <CardFooter>
          <Button
            loading={create.isPending || submission !== undefined}
            type="submit"
          >
            Continue to GitHub
          </Button>
        </CardFooter>
      </Form>
      {submission !== undefined && (
        <form
          action={`${submission.url}?state=${encodeURIComponent(submission.state)}`}
          hidden
          method="post"
          ref={formRef}
        >
          <input
            name="manifest"
            type="hidden"
            value={JSON.stringify(submission.manifest)}
          />
        </form>
      )}
    </Card>
  );
}

export function SetupRoute(): React.ReactElement {
  const [step, setStep] = useState<"token" | "app" | "expired">("token");
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4 py-8">
      {step === "app" ? (
        <AppStep onExpired={() => setStep("expired")} />
      ) : (
        <TokenStep
          expired={step === "expired"}
          onVerified={() => setStep("app")}
        />
      )}
    </main>
  );
}
