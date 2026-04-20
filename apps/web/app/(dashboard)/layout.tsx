import "../(marketing)/marketing.css";
import "./dashboard.css";
import { brand } from "@bematist/ui/brand";
import Link from "next/link";
import type { ReactNode } from "react";
import { DashNav } from "@/components/dashboard/DashNav";
import { findDeveloperForUser } from "@/components/dashboard/queries";
import { requireSession } from "@/lib/session";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const linkedDev = await findDeveloperForUser(session.org.id, session.user.id, session.user.email);
  const hasMe = linkedDev !== null;

  return (
    <div className="bematist-marketing">
      <div className="dash-shell">
        <aside className="dash-aside">
          <Link href="/" className="mk-wordmark" aria-label={`${brand.name} home`}>
            <span className="mk-wordmark-dot" aria-hidden />
            {brand.wordmark}
          </Link>
          <div className="dash-org">
            <span className="dash-org-name">{session.org.name}</span>
            <span className="dash-org-role">{session.role}</span>
          </div>
          <DashNav role={session.role} hasMe={hasMe} />
          <div className="dash-user">
            <span className="dash-user-name">{session.user.name ?? session.user.email}</span>
            <span className="dash-user-email">{session.user.email}</span>
            <Link
              href="/auth/sign-out"
              className="dash-btn"
              style={{ marginTop: 10, alignSelf: "flex-start" }}
            >
              Sign out
            </Link>
          </div>
        </aside>
        <main className="dash-main">{children}</main>
      </div>
    </div>
  );
}
