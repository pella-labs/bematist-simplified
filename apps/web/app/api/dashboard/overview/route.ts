import { NextResponse } from "next/server";
import { getOverviewCounts } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";

export async function GET() {
  const session = await requireSession();
  const counts = await getOverviewCounts(session.org.id);
  return NextResponse.json({
    ok: true,
    orgSlug: session.org.slug,
    role: session.role,
    counts,
  });
}
