import type { NextRequest } from "next/server";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { requireUser } from "@/modules/auth/requireUser";
import { getSessionForUser } from "@/modules/auth/session";
import { shapeSession } from "@/modules/auth/shape";
import { NotFoundError } from "@/lib/errors";

/**
 * GET /api/auth/sessions/[id]
 * Fetch a single auth session. Returns 404 for another user's session (NOT 403)
 * so we never leak its existence — the ownership filter lives in the repository
 * (getSessionForUser), not in ad-hoc route checks.
 */
export const GET = withAsyncHandler(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const { id } = await params;

    const session = await getSessionForUser(user._id.toString(), id);
    if (!session) throw new NotFoundError("Not found");

    return Response.json({ session: shapeSession(session) });
  },
);
