import type { ReactNode } from "react";
import { Footer } from "@/components/marketing/Footer";
import { Nav } from "@/components/marketing/Nav";
import "./marketing.css";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="bematist-marketing">
      <div className="mk-container">
        <Nav />
        {children}
        <Footer />
      </div>
    </div>
  );
}
