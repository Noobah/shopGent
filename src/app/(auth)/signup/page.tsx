import Link from "next/link";

export default function SignupPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Create account</h1>
        <p className="text-muted-foreground text-sm">
          Signup form is wired in Phase 5. This page exists in Phase 1 so the auth
          redirect + route protection have a real target.
        </p>
        <Link href="/login" className="text-primary text-sm underline underline-offset-4">
          Already have an account? Sign in
        </Link>
      </div>
    </main>
  );
}
