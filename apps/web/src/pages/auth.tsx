import { loginSchema, PASSWORD_MIN_LENGTH, registerSchema } from "@pulsewatch/shared";
import { useState, type SyntheticEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { ApiError, describeError } from "../api/client";
import { useLogin, useRegister } from "../api/hooks";
import { Logo } from "../components/layout";
import { Button, Field, FormError, Input } from "../components/ui";

type Mode = "login" | "register";

/** Login and registration share one form; only the copy and the endpoint differ. */
function AuthForm({ mode }: { mode: Mode }) {
  const login = useLogin();
  const register = useRegister();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();

  const mutation = mode === "login" ? login : register;
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const schema = mode === "login" ? loginSchema : registerSchema;
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
        ),
      );
      return;
    }
    setErrors({});
    try {
      await mutation.mutateAsync(parsed.data);
      void navigate(from, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.details.length > 0) {
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.path, detail.message])));
      }
      setFormError(describeError(error));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold tracking-tight">
            {mode === "login" ? "Log in" : "Create an account"}
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            {mode === "login"
              ? "Monitor the availability and latency of your APIs."
              : "Start monitoring your endpoints in a minute."}
          </p>
          <form
            onSubmit={(event) => void handleSubmit(event)}
            noValidate
            className="mt-6 space-y-4"
          >
            <FormError message={formError} />
            <Field label="Email" error={errors["email"]}>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field
              label="Password"
              error={errors["password"]}
              hint={mode === "register" ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
              )}
            </Field>
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Please wait…" : mode === "login" ? "Log in" : "Create account"}
            </Button>
          </form>
        </div>
        <p className="mt-4 text-center text-sm text-ink-2">
          {mode === "login" ? (
            <>
              No account?{" "}
              <Link to="/register" className="font-medium text-ink hover:underline">
                Create one
              </Link>
            </>
          ) : (
            <>
              Already registered?{" "}
              <Link to="/login" className="font-medium text-ink hover:underline">
                Log in
              </Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function LoginPage() {
  return <AuthForm mode="login" />;
}

export function RegisterPage() {
  return <AuthForm mode="register" />;
}
