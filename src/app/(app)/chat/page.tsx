import { requireUser } from "@/modules/auth/requireUser";

// This page reads the session via cookies(), so it renders per-request and
// cannot be part of the static shell. `instant = false` opts it out of
// Cache Components' instant-navigation/static-shell validation.
export const instant = false;

/**
 * Protected page. The proxy redirect is only a convenience — the REAL
 * authorization boundary is requireUser() here (and in every API route/action).
 * Unauthenticated requests never reach the DB-backed render.
 */
export default async function ChatPage() {
  const user = await requireUser();

  return (
    <main className="flex flex-1 flex-col p-6">
      <h1 className="text-2xl font-semibold">Chat</h1>
      <p className="text-muted-foreground mt-2 text-sm">
        Signed in as {user.displayName} ({user.email}). The assistant UI arrives in Phase
        5.
      </p>
    </main>
  );
}
