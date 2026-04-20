import { brand } from "@bematist/ui/brand";
import type { Metadata } from "next";
import { CtaBand } from "@/components/marketing/CtaBand";
import { FeatureGrid } from "@/components/marketing/FeatureGrid";
import { Hero } from "@/components/marketing/Hero";

const TITLE = `${brand.name} — ${brand.tagline}`;
const DESCRIPTION = brand.subtitle;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    title: TITLE,
    description: DESCRIPTION,
  },
};

export default function MarketingHome() {
  return (
    <>
      <Hero />
      <FeatureGrid />
      <CtaBand />
    </>
  );
}
