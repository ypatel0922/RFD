"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { BrandLogo } from "../brand-logo";

const NAV_LINKS = [
  { href: "#product", label: "Product" },
  { href: "#features", label: "Features" },
  { href: "#security", label: "Security" },
  { href: "#pricing", label: "Pricing" },
  { href: "#about", label: "About" },
] as const;

export function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    function onResize() {
      if (window.innerWidth >= 1024) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function onScroll() {
      setScrolled(window.scrollY > 8);
    }
    onScroll();
    window.addEventListener("resize", onResize);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <header className={`mkt-header${open ? " is-menu-open" : ""}${scrolled ? " is-scrolled" : ""}`}>
      <div className="mkt-container">
        <div className="mkt-header-inner">
          <button
            type="button"
            className="mkt-menu-btn"
            aria-expanded={open}
            aria-controls="mkt-mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={24} aria-hidden /> : <Menu size={24} aria-hidden />}
          </button>

          <Link href="/" className="mkt-header-logo" aria-label="Hallix home">
            <BrandLogo tone="light" priority />
          </Link>

          <nav className="mkt-nav" aria-label="Primary">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>

          <div className="mkt-header-actions">
            <a href="#demo" className="mkt-btn mkt-btn-primary">
              Request Demo
            </a>
            <Link href="/login" className="mkt-signin">
              Sign In
            </Link>
          </div>
        </div>

        <nav
          id="mkt-mobile-nav"
          className={`mkt-mobile-nav${open ? " is-open" : ""}`}
          aria-label="Mobile"
          aria-hidden={!open}
        >
          <div className="mkt-mobile-nav-panel">
            {NAV_LINKS.map((link, index) => (
              <a
                key={link.href}
                href={link.href}
                tabIndex={open ? 0 : -1}
                style={{ "--i": index } as CSSProperties}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </a>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
