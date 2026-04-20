import { brand } from "@bematist/ui/brand";
import Link from "next/link";

export function Wordmark() {
  return (
    <Link href="/" className="mk-wordmark" aria-label={`${brand.name} home`}>
      <span className="mk-wordmark-dot" aria-hidden />
      {brand.wordmark}
    </Link>
  );
}
