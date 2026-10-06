"use client";

import "./marketing.css";

import { MarketingHeader } from "../components/marketing/header";
import {
  FeaturesSection,
  FinalCta,
  FounderTrust,
  HowItWorks,
  MarketingFooter,
  MarketingHero,
  ProductDemoSection,
  SecurityAndPricing,
  TextReceiptWorkflow,
  TrustStrip,
} from "../components/marketing/sections";

export default function HomePage() {
  return (
    <div className="hallix-mkt">
      <MarketingHeader />
      <main>
        <MarketingHero />
        <TrustStrip />
        <FeaturesSection />
        <TextReceiptWorkflow />
        <HowItWorks />
        <ProductDemoSection />
        <FounderTrust />
        <SecurityAndPricing />
        <FinalCta />
      </main>
      <MarketingFooter />
    </div>
  );
}
