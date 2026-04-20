"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface DashNavProps {
  role: "admin" | "member";
  hasMe: boolean;
}

interface LinkDef {
  href: string;
  label: string;
  role?: "admin";
  condition?: "hasMe";
}

const MAIN: LinkDef[] = [
  { href: "/overview", label: "Overview" },
  { href: "/me", label: "My dashboard", condition: "hasMe" },
  { href: "/sessions", label: "Sessions" },
  { href: "/prompts", label: "Prompts" },
  { href: "/compare", label: "Compare" },
  { href: "/developers", label: "Developers", role: "admin" },
];

const ADMIN: LinkDef[] = [
  { href: "/admin/github", label: "GitHub", role: "admin" },
  { href: "/admin/developers", label: "Developers", role: "admin" },
  { href: "/admin/keys", label: "Ingest keys", role: "admin" },
];

function matches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function filterLinks(links: LinkDef[], role: "admin" | "member", hasMe: boolean): LinkDef[] {
  return links.filter((l) => {
    if (l.role === "admin" && role !== "admin") return false;
    if (l.condition === "hasMe" && !hasMe) return false;
    return true;
  });
}

export function DashNav({ role, hasMe }: DashNavProps) {
  const pathname = usePathname() ?? "/";
  const mainLinks = filterLinks(MAIN, role, hasMe);
  const adminLinks = role === "admin" ? filterLinks(ADMIN, role, hasMe) : [];
  return (
    <nav className="dash-nav" aria-label="Primary">
      {mainLinks.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="dash-nav-link"
          aria-current={matches(pathname, l.href) ? "page" : undefined}
        >
          <span className="dash-nav-link-icon" aria-hidden />
          {l.label}
        </Link>
      ))}
      {adminLinks.length > 0 ? (
        <div className="dash-nav-group">
          <span className="dash-nav-group-label">Admin</span>
          {adminLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="dash-nav-link"
              aria-current={matches(pathname, l.href) ? "page" : undefined}
            >
              <span className="dash-nav-link-icon" aria-hidden />
              {l.label}
            </Link>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
