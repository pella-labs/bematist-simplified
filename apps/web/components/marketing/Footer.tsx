import { brand } from "@bematist/ui/brand";
import Link from "next/link";

export function Footer() {
  return (
    <footer className="mk-footer">
      <div className="mk-footer-copy">
        <span className="mk-footer-line">{brand.tagline}</span>
        <span>{brand.footerTagline}</span>
      </div>
      <div className="mk-footer-links">
        <Link href="/install">Install</Link>
        <Link href={brand.ctaPrimary.href}>Sign in</Link>
        <a href={brand.github} rel="noreferrer" target="_blank">
          GitHub
        </a>
      </div>
    </footer>
  );
}
