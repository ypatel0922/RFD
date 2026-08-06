/**
 * Money and date primitives.
 *
 * Everything downstream trusts these: a wrong parse here silently becomes a
 * wrong reconciliation, so the printed shapes banks actually use are pinned.
 */

import { describe, expect, it } from "vitest";

import { absDaysBetween, addDays, daysBetween, normalizeStatementDate, periodsOverlap } from "./dates";
import { centsToNumeric, formatCents, formatSignedCents, parseCents, sumCents } from "./money";

describe("parsing printed money", () => {
  it("reads the shapes that appear on statements", () => {
    expect(parseCents("1,234.56")).toBe(123_456);
    expect(parseCents("$1,234.56")).toBe(123_456);
    expect(parseCents("(45.00)")).toBe(-4_500);
    expect(parseCents("45.00-")).toBe(-4_500);
    expect(parseCents("-45")).toBe(-4_500);
    expect(parseCents("45.5")).toBe(4_550);
    expect(parseCents(".75")).toBe(75);
    expect(parseCents("1234")).toBe(123_400);
  });

  it("honors CR and DR markers", () => {
    expect(parseCents("250.00 CR")).toBe(25_000);
    expect(parseCents("250.00 DR")).toBe(-25_000);
  });

  it("reads Postgres numeric strings and JavaScript numbers alike", () => {
    expect(parseCents("1250.50")).toBe(125_050);
    expect(parseCents(1250.5)).toBe(125_050);
  });

  it("returns null rather than guessing at unreadable text", () => {
    expect(parseCents(null)).toBeNull();
    expect(parseCents("")).toBeNull();
    expect(parseCents("—")).toBeNull();
    expect(parseCents("see reverse")).toBeNull();
    expect(parseCents("12.3456")).toBeNull();
    expect(parseCents(Number.NaN)).toBeNull();
  });

  it("treats zero as a real amount, not as missing", () => {
    expect(parseCents("0.00")).toBe(0);
  });
});

describe("integer arithmetic instead of floats", () => {
  it("sums a long column without drifting", () => {
    // The classic float failure: 0.1 + 0.2 !== 0.3.
    expect(sumCents([parseCents("0.10"), parseCents("0.20")])).toBe(parseCents("0.30"));

    const hundredDimes = Array.from({ length: 100 }, () => parseCents("0.10"));
    expect(sumCents(hundredDimes)).toBe(1_000);
  });

  it("skips missing values rather than poisoning the total", () => {
    expect(sumCents([1_000, null, undefined, 500])).toBe(1_500);
  });

  it("round-trips through the numeric column Postgres stores", () => {
    expect(centsToNumeric(125_050)).toBe(1250.5);
    expect(parseCents(centsToNumeric(-4_567))).toBe(-4_567);
    expect(centsToNumeric(null)).toBeNull();
  });
});

describe("display formatting", () => {
  it("formats amounts and the empty case", () => {
    expect(formatCents(125_050)).toBe("$1,250.50");
    expect(formatCents(-4_500)).toBe("-$45.00");
    expect(formatCents(null)).toBe("—");
  });

  it("always shows the direction of a signed amount", () => {
    expect(formatSignedCents(4_500)).toBe("+$45.00");
    expect(formatSignedCents(-4_500)).toBe("-$45.00");
  });
});

describe("statement dates", () => {
  it("reads the date formats statements print", () => {
    expect(normalizeStatementDate("03/14/2025")).toBe("2025-03-14");
    expect(normalizeStatementDate("3/4/25")).toBe("2025-03-04");
    expect(normalizeStatementDate("2025-03-14")).toBe("2025-03-14");
    expect(normalizeStatementDate("March 14, 2025")).toBe("2025-03-14");
    expect(normalizeStatementDate("14 Mar 2025")).toBe("2025-03-14");
  });

  it("resolves a bare MM/DD row against the statement year", () => {
    expect(normalizeStatementDate("03/14", 2025)).toBe("2025-03-14");
    // A December row on a January statement belongs to the prior year.
    expect(normalizeStatementDate("12/28", 2025)).toBe("2025-12-28");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(normalizeStatementDate("13/45/2025")).toBeNull();
    expect(normalizeStatementDate("02/30/2025")).toBeNull();
    expect(normalizeStatementDate("not a date")).toBeNull();
    expect(normalizeStatementDate(null)).toBeNull();
  });

  it("measures day gaps in UTC so a timezone cannot shift a match", () => {
    // Positive means the first date is the later one: a bank posting date three
    // days after the date the treasurer recorded.
    expect(daysBetween("2025-03-04", "2025-03-01")).toBe(3);
    expect(daysBetween("2025-03-01", "2025-03-04")).toBe(-3);
    expect(absDaysBetween("2025-03-01", "2025-03-04")).toBe(3);
    // Across a daylight-saving change in US timezones.
    expect(absDaysBetween("2025-03-08", "2025-03-10")).toBe(2);
  });

  it("adds days across month and year boundaries", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2025-12-28", 7)).toBe("2026-01-04");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("detects overlapping statement periods", () => {
    expect(periodsOverlap("2025-03-01", "2025-03-31", "2025-03-15", "2025-04-14")).toBe(true);
    expect(periodsOverlap("2025-03-01", "2025-03-31", "2025-04-01", "2025-04-30")).toBe(false);
    // Touching endpoints do overlap: the same day cannot be reconciled twice.
    expect(periodsOverlap("2025-03-01", "2025-03-31", "2025-03-31", "2025-04-30")).toBe(true);
  });
});
