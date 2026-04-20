import { brand } from "@bematist/ui/brand";
import Link from "next/link";
import { Wordmark } from "./Wordmark";

export function Nav() {
  return (
    <nav className="mk-nav" aria-label="Primary">
      <Wordmark />
      <div className="mk-nav-links">
        <Link href="/install" className="mk-nav-link">
          Install
        </Link>
        <a href={brand.github} className="mk-nav-link" rel="noreferrer" target="_blank">
          GitHub
        </a>
        <Link href={brand.ctaPrimary.href} className="mk-btn mk-btn-ghost">
          Sign in
        </Link>
      </div>
    </nav>
  );
}
