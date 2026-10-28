import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-muted-foreground text-sm">
          Login form is wired in Phase 5. This page exists in Phase 1 so the auth redirect
          + route protection have a real target.
        </p>
        <Link
          href="/signup"
          className="text-primary text-sm underline underline-offset-4"
        >
          Need an account? Sign up
        </Link>
      </div>
    </main>
  );
}
