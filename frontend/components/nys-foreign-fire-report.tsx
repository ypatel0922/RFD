"use client";

import {
  ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { supabase, taxFormsBucket } from "../lib/supabase";
import type { BankAccount, DepartmentMembership, ExpenseRecord } from "../lib/types";

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const TEMPLATE_PATH =
  "/forms/foreign-fire-insurance-premiums-annual-report.pdf";

const FONT_SIZE = 8;

/** PDF coordinate map — each value is the text baseline location.
 *  Y=0 is bottom-left (PDF coordinate system).
 *  Positions derived from pdfminer analysis of the official OSC form.
 */
type Coord = {
  x: number;
  y: number;
  maxW?: number;
  /** Right-align text to this x-coordinate */
  rightX?: number;
};

const COORDS: Record<string, Coord> = {
  // ── Row 1: Entity name / Fire District # / County ──
  entity_name:        { x: 86,  y: 604, maxW: 188 },
  fire_district:      { x: 385, y: 604, maxW: 63 },
  county:             { x: 478, y: 604, maxW: 80 },

  // ── Row 2: Address / City / ZIP ──────────────────────
  address:            { x: 63,  y: 590, maxW: 200 },
  city_town:          { x: 331, y: 590, maxW: 152 },
  zip:                { x: 499, y: 590, maxW: 64 },

  // ── Row 4: Town or City / Village ────────────────────
  town_or_city:       { x: 137, y: 562, maxW: 151 },
  village:            { x: 425, y: 562, maxW: 142 },

  // ── Row 5: Fire Protection District ──────────────────
  fire_prot_dist:     { x: 218, y: 549, maxW: 341 },

  // ── Row 6: Fire District Where Located ───────────────
  fire_dist_located:  { x: 178, y: 535, maxW: 389 },

  // ── Balance Jan 1 (total box) ─────────────────────────
  balance_jan1:       { x: 433, y: 494, maxW: 87, rightX: 520 },

  // ── Revenue source lines ──────────────────────────────
  rev_src1_desc:      { x: 108, y: 452, maxW: 187 },
  rev_src1_amt:       { x: 325, y: 452, maxW: 87,  rightX: 412 },
  rev_src2_desc:      { x: 108, y: 438, maxW: 187 },
  rev_src2_amt:       { x: 325, y: 438, maxW: 87,  rightX: 412 },
  rev_src3_desc:      { x: 108, y: 425, maxW: 187 },
  rev_src3_amt:       { x: 325, y: 425, maxW: 87,  rightX: 412 },
  rev_src4_desc:      { x: 104, y: 411, maxW: 197 },
  rev_src4_amt:       { x: 325, y: 411, maxW: 87,  rightX: 412 },

  // ── Interest lines ───────────────────────────────────
  interest_amt1:      { x: 325, y: 383, maxW: 87,  rightX: 412 },
  interest_amt2:      { x: 325, y: 370, maxW: 87,  rightX: 412 },

  // ── Summary totals ───────────────────────────────────
  total_revenues:     { x: 433, y: 356, maxW: 87,  rightX: 520 },
  total_bal_rev:      { x: 433, y: 333, maxW: 87,  rightX: 520 },

  // ── Expenditure lines ────────────────────────────────
  exp1_desc:          { x: 32,  y: 301, maxW: 262 },
  exp1_amt:           { x: 325, y: 301, maxW: 87,  rightX: 412 },
  exp2_desc:          { x: 32,  y: 278, maxW: 262 },
  exp2_amt:           { x: 325, y: 278, maxW: 87,  rightX: 412 },
  exp3_desc:          { x: 32,  y: 255, maxW: 263 },
  exp3_amt:           { x: 325, y: 255, maxW: 87,  rightX: 412 },

  // ── Expenditure + ending balance totals ──────────────
  total_expenditures: { x: 433, y: 237, maxW: 87,  rightX: 520 },
  balance_dec31:      { x: 433, y: 219, maxW: 87,  rightX: 520 },

  // ── Certification block ───────────────────────────────
  certifier_name:     { x: 37,  y: 191, maxW: 145 },
  signature:          { x: 73,  y: 163, maxW: 245 },
  title:              { x: 346, y: 163, maxW: 224 },
  print_name:         { x: 80,  y: 149, maxW: 142 },
  telephone:          { x: 348, y: 149, maxW: 57 },
  email:              { x: 430, y: 149, maxW: 145 },
};

// Entity type checkbox positions (draw "X" above the underline)
const TYPE_BOX: Record<string, { x: number; y: number }> = {
  "Fire Department":       { x: 68,  y: 576 },
  "Fire Company":          { x: 176, y: 576 },
  "Benevolent Association": { x: 284, y: 576 },
};

// Map from our entity_type values to the three form checkboxes
const ENTITY_TO_BOX: Record<string, string> = {
  "Fire Department":           "Fire Department",
  "Volunteer Fire Department": "Fire Department",
  "Paid Fire Department":      "Fire Department",
  "Combination Fire Department":"Fire Department",
  "Fire District":             "Fire Department",
  "Fire Company":              "Fire Company",
  "Volunteer Fire Company":    "Fire Company",
  "Benevolent Association":    "Benevolent Association",
};

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** A single extra revenue or expenditure line beyond the NYS form's built-in slots */
type ExtraLine = { desc: string; amt: string };

type EffectiveTotals = {
  revenueTotal: number;
  totalBalRev: number;
  expenseTotal: number;
  endingBalance: number;
};

type NysFormFields = {
  // Entity info
  entity_name: string;
  fire_district: string;
  county: string;
  address: string;
  city_town: string;
  zip: string;
  entity_type: string;
  town_or_city: string;
  village: string;
  fire_prot_dist: string;
  fire_dist_located: string;

  // Financial
  beginning_balance: string;
  rev_src1_desc: string;
  rev_src1_amt: string;
  rev_src2_desc: string;
  rev_src2_amt: string;
  rev_src3_desc: string;
  rev_src3_amt: string;
  rev_src4_desc: string;
  rev_src4_amt: string;
  interest_amt1: string;
  interest_amt2: string;
  revenue_total: string;
  total_bal_rev: string;
  exp1_desc: string;
  exp1_amt: string;
  exp2_desc: string;
  exp2_amt: string;
  exp3_desc: string;
  exp3_amt: string;
  expense_total: string;
  ending_balance: string;

  // Certification
  certifier_name: string;
  treasurer_name: string;
  title: string;
  treasurer_phone: string;
  treasurer_email: string;
};

const EMPTY_FIELDS: NysFormFields = {
  entity_name: "",
  fire_district: "",
  county: "",
  address: "",
  city_town: "",
  zip: "",
  entity_type: "Volunteer Fire Company",
  town_or_city: "",
  village: "",
  fire_prot_dist: "",
  fire_dist_located: "",
  beginning_balance: "0.00",
  rev_src1_desc: "Foreign Fire Insurance Premiums",
  rev_src1_amt: "",
  rev_src2_desc: "",
  rev_src2_amt: "",
  rev_src3_desc: "",
  rev_src3_amt: "",
  rev_src4_desc: "",
  rev_src4_amt: "",
  interest_amt1: "",
  interest_amt2: "",
  revenue_total: "0.00",
  total_bal_rev: "0.00",
  exp1_desc: "Operating Expenditures",
  exp1_amt: "",
  exp2_desc: "",
  exp2_amt: "",
  exp3_desc: "",
  exp3_amt: "",
  expense_total: "0.00",
  ending_balance: "0.00",
  certifier_name: "",
  treasurer_name: "",
  title: "Treasurer",
  treasurer_phone: "",
  treasurer_email: "",
};

const ENTITY_TYPE_OPTIONS = [
  "Volunteer Fire Company",
  "Volunteer Fire Department",
  "Paid Fire Department",
  "Combination Fire Department",
  "Fire District",
  "Benevolent Association",
];

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function parseNum(val: string): number {
  const n = parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  return Number.isNaN(n) ? 0 : n;
}

function fmtMoney(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function toMoneyStr(n: number): string {
  return n.toFixed(2);
}

function rawToNum(total: ExpenseRecord["total_amount"]): number {
  if (total == null) return 0;
  if (typeof total === "number") return Number.isNaN(total) ? 0 : total;
  const n = parseFloat(String(total).replace(/[$,]/g, "").trim());
  return Number.isNaN(n) ? 0 : n;
}

function expenseYear(exp: ExpenseRecord): string {
  return (
    String(exp.transaction_date ?? "").slice(0, 4) ||
    String(exp.created_at ?? "").slice(0, 4)
  );
}

/** Returns true for revenue / deposit entries (money IN to the fund) */
function isIncomeRecord(exp: ExpenseRecord): boolean {
  const amount = rawToNum(exp.total_amount);
  // Negative stored amount means money came in
  if (amount < 0) return true;
  const cat = (exp.category ?? "").toLowerCase();
  const desc = (exp.description ?? "").toLowerCase();
  const fund = (exp.fund ?? "").toLowerCase();
  // Explicit income/deposit patterns
  if (cat.includes("income") || cat.includes("deposit") || cat.includes("revenue")) return true;
  if (cat.includes("nys 2%") || cat.includes("foreign fire") || cat.includes("premium")) return true;
  if (desc.includes("foreign fire insurance") || desc.includes("state deposit") || desc.includes("nys deposit")) return true;
  if (fund.includes("2%") || fund.includes("deposit") || fund.includes("income")) return true;
  return false;
}

/**
 * Compute auto-populated financial fields from Firebook expenses.
 * Returns:
 *   - fields: patches for NysFormFields (top 3 exp categories, top 4 rev sources)
 *   - extraExpLines: any expenditure categories beyond the 3 form slots
 *   - extraRevLines: any revenue sources beyond the 4 form slots
 */
function computeAutoFields(
  expenses: ExpenseRecord[],
  bankAccounts: BankAccount[],
  taxYear: number,
): { fields: Partial<NysFormFields>; extraExpLines: ExtraLine[]; extraRevLines: ExtraLine[] } {
  const yearStr = String(taxYear);

  const twoPercentAccountNames = new Set(
    bankAccounts
      .filter((a) => a.is_two_percent_account)
      .map((a) => a.name.toLowerCase()),
  );

  const yearly = expenses.filter((exp) => expenseYear(exp) === yearStr);

  const twoPctYearly = twoPercentAccountNames.size > 0
    ? yearly.filter(
        (exp) =>
          exp.uses_two_percent_funds ||
          (exp.bank_account_name &&
            twoPercentAccountNames.has(exp.bank_account_name.toLowerCase())),
      )
    : [];

  const source = twoPctYearly.length > 0 ? twoPctYearly : yearly;

  const incomeExpenses = source.filter(isIncomeRecord);
  const outExpenses    = source.filter((e) => !isIncomeRecord(e));

  // Revenue — group non-interest by source/category, top 4 on form, rest as extras
  const revCatMap = new Map<string, number>();
  for (const e of incomeExpenses.filter((e) => !(e.category ?? "").toLowerCase().includes("interest"))) {
    const cat = e.category?.trim() || "Foreign Fire Insurance Premiums";
    revCatMap.set(cat, (revCatMap.get(cat) ?? 0) + Math.abs(rawToNum(e.total_amount)));
  }
  if (revCatMap.size === 0) {
    const totalIncome = incomeExpenses
      .filter((e) => !(e.category ?? "").toLowerCase().includes("interest"))
      .reduce((s, e) => s + Math.abs(rawToNum(e.total_amount)), 0);
    if (totalIncome > 0) revCatMap.set("Foreign Fire Insurance Premiums", totalIncome);
  }
  const allRevCats = [...revCatMap.entries()].sort((a, b) => b[1] - a[1]);

  const interestAmt = incomeExpenses
    .filter((e) => (e.category ?? "").toLowerCase().includes("interest"))
    .reduce((s, e) => s + Math.abs(rawToNum(e.total_amount)), 0);

  // Expenditures — group by category, top 3 on form, rest as extras
  const expCatMap = new Map<string, number>();
  for (const e of outExpenses) {
    const cat = e.category?.trim() || "Operating Expenditures";
    expCatMap.set(cat, (expCatMap.get(cat) ?? 0) + Math.abs(rawToNum(e.total_amount)));
  }
  const allExpCats = [...expCatMap.entries()].sort((a, b) => b[1] - a[1]);

  const formRevCats  = allRevCats.slice(0, 4);
  const extraRevCats = allRevCats.slice(4);
  const formExpCats  = allExpCats.slice(0, 3);
  const extraExpCats = allExpCats.slice(3);

  const result: Partial<NysFormFields> = {};

  if (formRevCats[0]) { result.rev_src1_desc = formRevCats[0][0]; result.rev_src1_amt = toMoneyStr(formRevCats[0][1]); }
  if (formRevCats[1]) { result.rev_src2_desc = formRevCats[1][0]; result.rev_src2_amt = toMoneyStr(formRevCats[1][1]); }
  if (formRevCats[2]) { result.rev_src3_desc = formRevCats[2][0]; result.rev_src3_amt = toMoneyStr(formRevCats[2][1]); }
  if (formRevCats[3]) { result.rev_src4_desc = formRevCats[3][0]; result.rev_src4_amt = toMoneyStr(formRevCats[3][1]); }
  if (interestAmt > 0) result.interest_amt1 = toMoneyStr(interestAmt);

  if (formExpCats[0]) { result.exp1_desc = formExpCats[0][0]; result.exp1_amt = toMoneyStr(formExpCats[0][1]); }
  if (formExpCats[1]) { result.exp2_desc = formExpCats[1][0]; result.exp2_amt = toMoneyStr(formExpCats[1][1]); }
  if (formExpCats[2]) { result.exp3_desc = formExpCats[2][0]; result.exp3_amt = toMoneyStr(formExpCats[2][1]); }

  return {
    fields: result,
    extraRevLines: extraRevCats.map(([desc, amt]) => ({ desc, amt: toMoneyStr(amt) })),
    extraExpLines: extraExpCats.map(([desc, amt]) => ({ desc, amt: toMoneyStr(amt) })),
  };
}

/** Recalculate all derived totals from current fields */
function recalcTotals(f: NysFormFields): NysFormFields {
  const beginning = parseNum(f.beginning_balance);

  const revenueTotal =
    parseNum(f.rev_src1_amt) +
    parseNum(f.rev_src2_amt) +
    parseNum(f.rev_src3_amt) +
    parseNum(f.rev_src4_amt) +
    parseNum(f.interest_amt1) +
    parseNum(f.interest_amt2);

  const expenseTotal =
    parseNum(f.exp1_amt) +
    parseNum(f.exp2_amt) +
    parseNum(f.exp3_amt);

  return {
    ...f,
    revenue_total: toMoneyStr(revenueTotal),
    total_bal_rev: toMoneyStr(beginning + revenueTotal),
    expense_total: toMoneyStr(expenseTotal),
    ending_balance: toMoneyStr(beginning + revenueTotal - expenseTotal),
  };
}

/** Compute totals that include both form-slot lines AND extra lines */
function computeEffectiveTotals(
  f: NysFormFields,
  extraRev: ExtraLine[],
  extraExp: ExtraLine[],
): EffectiveTotals {
  const beginning = parseNum(f.beginning_balance);
  const revFromForm =
    parseNum(f.rev_src1_amt) +
    parseNum(f.rev_src2_amt) +
    parseNum(f.rev_src3_amt) +
    parseNum(f.rev_src4_amt) +
    parseNum(f.interest_amt1) +
    parseNum(f.interest_amt2);
  const revFromExtra = extraRev.reduce((s, l) => s + parseNum(l.amt), 0);
  const revenueTotal = revFromForm + revFromExtra;

  const expFromForm =
    parseNum(f.exp1_amt) +
    parseNum(f.exp2_amt) +
    parseNum(f.exp3_amt);
  const expFromExtra = extraExp.reduce((s, l) => s + parseNum(l.amt), 0);
  const expenseTotal = expFromForm + expFromExtra;

  return {
    revenueTotal,
    totalBalRev:   beginning + revenueTotal,
    expenseTotal,
    endingBalance: beginning + revenueTotal - expenseTotal,
  };
}

// ─────────────────────────────────────────────────────────
// PDF generation (client-side, uses pdf-lib)
// ─────────────────────────────────────────────────────────

/** Convert a pdf-lib Uint8Array to a proper Blob (avoids SharedArrayBuffer TS issues) */
function pdfToBlob(bytes: Uint8Array): Blob {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([ab], { type: "application/pdf" });
}

async function fillNysPdf(
  templateBytes: ArrayBuffer,
  fields: NysFormFields,
  opts: {
    signElectronically?: boolean;
    effectiveTotals?: EffectiveTotals;
    extraRevLines?: ExtraLine[];
    extraExpLines?: ExtraLine[];
    taxYear?: number;
  } = {},
): Promise<Uint8Array> {
  const {
    signElectronically = false,
    effectiveTotals,
    extraRevLines = [],
    extraExpLines = [],
  taxYear,
  } = opts;

  const pdfDoc = await PDFDocument.load(templateBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const page = pdfDoc.getPage(0);
  const black = rgb(0, 0, 0);

  function trunc(text: string, maxW: number): string {
    let s = text;
    while (s.length > 0 && font.widthOfTextAtSize(s, FONT_SIZE) > maxW) {
      s = s.slice(0, -1);
    }
    return s;
  }

  function drawAt(key: string, text: string) {
    if (!text) return;
    const coord = COORDS[key];
    if (!coord) return;
    const maxW = coord.maxW ?? 200;
    const safe = trunc(text, maxW);
    let drawX = coord.x;
    if (coord.rightX !== undefined) {
      drawX = coord.rightX - font.widthOfTextAtSize(safe, FONT_SIZE);
    }
    page.drawText(safe, {
      x: drawX,
      y: coord.y,
      size: FONT_SIZE,
      font,
      color: black,
    });
  }

  // Format a number as money string (no $ sign — form already has it)
  function drawMoney(key: string, val: string) {
    const n = parseNum(val);
    if (n === 0 && val === "") return;
    drawAt(key, fmtMoney(n));
  }

  // ── Entity / location info ────────────────────────────
  drawAt("entity_name",       fields.entity_name);
  drawAt("fire_district",     fields.fire_district);
  drawAt("county",            fields.county);
  drawAt("address",           fields.address);
  drawAt("city_town",         fields.city_town);
  drawAt("zip",               fields.zip);
  drawAt("town_or_city",      fields.town_or_city);
  drawAt("village",           fields.village);
  drawAt("fire_prot_dist",    fields.fire_prot_dist);
  drawAt("fire_dist_located", fields.fire_dist_located);

  // ── Entity type checkbox ──────────────────────────────
  const boxKey = ENTITY_TO_BOX[fields.entity_type];
  if (boxKey) {
    const bc = TYPE_BOX[boxKey];
    page.drawText("X", {
      x: bc.x,
      y: bc.y,
      size: FONT_SIZE,
      font,
      color: black,
    });
  }

  // ── Financial ─────────────────────────────────────────
  drawMoney("balance_jan1",      fields.beginning_balance);

  drawAt("rev_src1_desc",  fields.rev_src1_desc);
  drawMoney("rev_src1_amt", fields.rev_src1_amt);
  drawAt("rev_src2_desc",  fields.rev_src2_desc);
  drawMoney("rev_src2_amt", fields.rev_src2_amt);
  drawAt("rev_src3_desc",  fields.rev_src3_desc);
  drawMoney("rev_src3_amt", fields.rev_src3_amt);
  drawAt("rev_src4_desc",  fields.rev_src4_desc);
  drawMoney("rev_src4_amt", fields.rev_src4_amt);

  drawMoney("interest_amt1", fields.interest_amt1);
  drawMoney("interest_amt2", fields.interest_amt2);

  // Use effective totals when available (they include extra lines)
  const et = effectiveTotals ?? computeEffectiveTotals(fields, extraRevLines, extraExpLines);
  drawMoney("total_revenues", toMoneyStr(et.revenueTotal));
  drawMoney("total_bal_rev",  toMoneyStr(et.totalBalRev));

  drawAt("exp1_desc",  fields.exp1_desc);
  drawMoney("exp1_amt", fields.exp1_amt);
  drawAt("exp2_desc",  fields.exp2_desc);
  drawMoney("exp2_amt", fields.exp2_amt);
  drawAt("exp3_desc",  fields.exp3_desc);
  drawMoney("exp3_amt", fields.exp3_amt);

  // Note on form if extra lines spill to attachment
  if (extraExpLines.length > 0 || extraRevLines.length > 0) {
    page.drawText("* See attached schedule for additional detail lines.", {
      x: 32, y: 242, size: 6, font, color: rgb(0.4, 0.4, 0.4),
    });
  }

  drawMoney("total_expenditures", toMoneyStr(et.expenseTotal));
  drawMoney("balance_dec31",      toMoneyStr(et.endingBalance));

  // ── Certification — signature blank unless user opts in ───────────────
  drawAt("certifier_name", fields.certifier_name || fields.treasurer_name);
  drawAt("print_name",     fields.treasurer_name);
  if (signElectronically && fields.treasurer_name) {
    drawAt("signature", fields.treasurer_name);
  }
  drawAt("title",     fields.title);
  drawAt("telephone", fields.treasurer_phone);
  drawAt("email",     fields.treasurer_email);

  // ── Attachment page — extra lines and full summary ─────────────────────
  const hasExtras = extraRevLines.length > 0 || extraExpLines.length > 0;
  if (hasExtras) {
    // taxYear is embedded in the "balance_jan1" label area; pass via opts
    await addAttachmentPage(pdfDoc, fields, et, extraRevLines, extraExpLines, opts.taxYear);
  }

  return pdfDoc.save();
}

async function addAttachmentPage(
  pdfDoc: PDFDocument,
  fields: NysFormFields,
  et: EffectiveTotals,
  extraRevLines: ExtraLine[],
  extraExpLines: ExtraLine[],
  taxYear?: number,
) {
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold      = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const page = pdfDoc.addPage([612, 792]);
  const black = rgb(0, 0, 0);
  const gray  = rgb(0.45, 0.45, 0.45);
  const L = 50, R = 562;
  let y = 742;

  function txt(s: string, x: number, yPos: number, sz: number, f = helvetica, c = black) {
    if (!s) return;
    page.drawText(s, { x, y: yPos, size: sz, font: f, color: c });
  }
  function rtxt(s: string, yPos: number, sz: number, f = helvetica) {
    const w = f.widthOfTextAtSize(s, sz);
    txt(s, R - w, yPos, sz, f);
  }
  function hline(yPos: number) {
    page.drawLine({ start: { x: L, y: yPos }, end: { x: R, y: yPos }, thickness: 0.5, color: gray });
  }
  function money(n: number) { return n === 0 ? "—" : `$${fmtMoney(n)}`; }

  // Title
  txt("SCHEDULE OF REVENUES AND EXPENDITURES", L, y, 11, bold);
  y -= 13;
  txt("Attachment to NYS Annual Report of Foreign Fire Insurance Premiums", L, y, 8, helvetica, gray);
  y -= 12;
  txt(fields.entity_name || "Department", L, y, 9);
  const yearLabel = taxYear ? `Tax Year: ${taxYear}` : "Tax Year: (see form)";
  const yw = bold.widthOfTextAtSize(yearLabel, 9);
  page.drawText(yearLabel, { x: R - yw, y, size: 9, font: bold, color: black });
  y -= 6;
  hline(y); y -= 16;

  // ── Revenues ──────────────────────────────────────────────────────────
  txt("REVENUES", L, y, 10, bold); y -= 14;

  type LineRow = { desc: string; amt: string; extra: boolean };
  const revRows: LineRow[] = [];
  if (fields.rev_src1_amt || fields.rev_src1_desc) revRows.push({ desc: fields.rev_src1_desc || "Revenue 1", amt: fields.rev_src1_amt, extra: false });
  if (fields.rev_src2_amt || fields.rev_src2_desc) revRows.push({ desc: fields.rev_src2_desc || "Revenue 2", amt: fields.rev_src2_amt, extra: false });
  if (fields.rev_src3_amt || fields.rev_src3_desc) revRows.push({ desc: fields.rev_src3_desc || "Revenue 3", amt: fields.rev_src3_amt, extra: false });
  if (fields.rev_src4_amt || fields.rev_src4_desc) revRows.push({ desc: fields.rev_src4_desc || "Revenue 4", amt: fields.rev_src4_amt, extra: false });
  for (const l of extraRevLines) revRows.push({ desc: l.desc || "Additional Revenue", amt: l.amt, extra: true });
  if (fields.interest_amt1) revRows.push({ desc: "Interest on Investment (1)", amt: fields.interest_amt1, extra: false });
  if (fields.interest_amt2) revRows.push({ desc: "Interest on Investment (2)", amt: fields.interest_amt2, extra: false });

  for (const row of revRows) {
    const label = row.extra ? `${row.desc} *` : row.desc;
    txt(label, L + 10, y, 9);
    rtxt(money(parseNum(row.amt)), y, 9);
    y -= 13;
  }
  hline(y + 4); y -= 4;
  txt("Total Revenues:", L + 10, y, 9, bold);
  rtxt(money(et.revenueTotal), y, 9, bold);
  y -= 20;

  // ── Expenditures ──────────────────────────────────────────────────────
  txt("EXPENDITURES", L, y, 10, bold); y -= 14;

  const expRows: LineRow[] = [];
  if (fields.exp1_amt || fields.exp1_desc) expRows.push({ desc: fields.exp1_desc || "Expenditure 1", amt: fields.exp1_amt, extra: false });
  if (fields.exp2_amt || fields.exp2_desc) expRows.push({ desc: fields.exp2_desc || "Expenditure 2", amt: fields.exp2_amt, extra: false });
  if (fields.exp3_amt || fields.exp3_desc) expRows.push({ desc: fields.exp3_desc || "Expenditure 3", amt: fields.exp3_amt, extra: false });
  for (const l of extraExpLines) expRows.push({ desc: l.desc || "Additional Expenditure", amt: l.amt, extra: true });

  for (const row of expRows) {
    const label = row.extra ? `${row.desc} *` : row.desc;
    txt(label, L + 10, y, 9);
    rtxt(money(parseNum(row.amt)), y, 9);
    y -= 13;
  }
  hline(y + 4); y -= 4;
  txt("Total Expenditures:", L + 10, y, 9, bold);
  rtxt(money(et.expenseTotal), y, 9, bold);
  y -= 24;

  // ── Summary ───────────────────────────────────────────────────────────
  hline(y + 8); y -= 4;
  txt("SUMMARY", L, y, 10, bold); y -= 14;
  const summaryRows = [
    { label: "Balance January 1 (Beginning):", val: money(parseNum(fields.beginning_balance)) },
    { label: "+ Total Revenues:", val: money(et.revenueTotal) },
    { label: "- Total Expenditures:", val: money(et.expenseTotal) },
  ];
  for (const r of summaryRows) {
    txt(r.label, L + 10, y, 9);
    rtxt(r.val, y, 9);
    y -= 13;
  }
  hline(y + 4); y -= 8;
  txt("= Balance December 31 (Ending):", L + 10, y, 9, bold);
  rtxt(money(et.endingBalance), y, 9, bold);
  y -= 28;

  // Footer note
  if (extraRevLines.length > 0 || extraExpLines.length > 0) {
    txt("* Lines marked with * are additional detail beyond NYS form space. They are included in the totals on the official form.", L, y, 7, helvetica, gray);
  }
}

// ─────────────────────────────────────────────────────────
// Main Page Component
// ─────────────────────────────────────────────────────────

export function NysFFReportPage({
  membership,
  expenses,
  bankAccounts,
  onBack,
}: {
  membership: DepartmentMembership;
  expenses: ExpenseRecord[];
  bankAccounts: BankAccount[];
  onBack: () => void;
}) {
  const currentYear = new Date().getFullYear();
  // Include current year and 5 prior years
  const yearOptions = Array.from({ length: 6 }, (_, i) => currentYear - i);

  // Default to current year since that's where active transactions live.
  // Falls back to prior year only if there are no current-year 2% transactions.
  const defaultTaxYear = useMemo(() => {
    const curYearStr = String(currentYear);
    const twoPercentAccountNames = new Set(
      bankAccounts.filter((a) => a.is_two_percent_account).map((a) => a.name.toLowerCase()),
    );
    const hasCurYear = expenses.some(
      (e) =>
        expenseYear(e) === curYearStr &&
        (e.uses_two_percent_funds ||
          (e.bank_account_name && twoPercentAccountNames.has(e.bank_account_name.toLowerCase()))),
    );
    return hasCurYear ? currentYear : currentYear - 1;
  }, []); // intentionally only on mount

  const [taxYear, setTaxYear] = useState(defaultTaxYear);
  const [fields, setFields] = useState<NysFormFields>({ ...EMPTY_FIELDS });
  const [formRunId, setFormRunId] = useState<string | null>(null);
  const [extraRevLines, setExtraRevLines] = useState<ExtraLine[]>([]);
  const [extraExpLines, setExtraExpLines] = useState<ExtraLine[]>([]);
  const [signElectronically, setSignElectronically] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>(TEMPLATE_PATH);
  const [isGenerating, setIsGenerating] = useState(false);

  const effectiveTotals = useMemo(
    () => computeEffectiveTotals(fields, extraRevLines, extraExpLines),
    [fields, extraRevLines, extraExpLines],
  );

  // Replace-confirmation state for prior-year uploads
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [replaceConfirmYear, setReplaceConfirmYear] = useState<number | null>(null);
  const [existingFilingId, setExistingFilingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateRef = useRef<ArrayBuffer | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const taxYearRef = useRef<number>(defaultTaxYear);

  const departmentId = membership.department_id;
  const departmentName = membership.departments?.name ?? "";

  // Keep taxYearRef current so the debounced preview can read it without stale closure
  useEffect(() => { taxYearRef.current = taxYear; }, [taxYear]);

  // ── Fetch and cache the template PDF ─────────────────
  useEffect(() => {
    fetch(TEMPLATE_PATH)
      .then((r) => r.arrayBuffer())
      .then((ab) => {
        templateRef.current = ab;
      })
      .catch(() => {});
  }, []);

  // ── Load profile on mount ─────────────────────────────
  useEffect(() => {
    let cancelled = false;
    supabase
      .from("department_tax_profiles")
      .select("*")
      .eq("department_id", departmentId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled || !data) return;
        setFields((prev) =>
          recalcTotals({
            ...prev,
            entity_name:    data.department_name || prev.entity_name || departmentName,
            address:        data.address || prev.address,
            city_town:      data.city || prev.city_town,
            county:         data.county || prev.county,
            zip:            data.zip || prev.zip,
            entity_type:    data.entity_type || prev.entity_type,
            treasurer_name: data.treasurer_name || prev.treasurer_name,
            certifier_name: data.treasurer_name || prev.certifier_name,
            treasurer_email:data.treasurer_email || prev.treasurer_email,
            treasurer_phone:data.treasurer_phone || prev.treasurer_phone,
          }),
        );
      });
    return () => { cancelled = true; };
  }, [departmentId, departmentName]);

  // ── Load form run + apply auto-calc (single effect avoids race) ──────────
  useEffect(() => {
    let cancelled = false;
    setSaveStatus(null);
    supabase
      .from("tax_form_runs")
      .select("id, starting_balance, form_data")
      .eq("department_id", departmentId)
      .eq("tax_year", taxYear)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;

        const auto = computeAutoFields(expenses, bankAccounts, taxYear);

        if (data) {
          setFormRunId(data.id as string);
          const saved = (data.form_data as Record<string, unknown>) ?? {};

          // Restore extra lines saved in the draft
          const savedExtraRev = (saved.extra_rev_lines as ExtraLine[] | undefined) ?? [];
          const savedExtraExp = (saved.extra_exp_lines as ExtraLine[] | undefined) ?? [];
          setExtraRevLines(savedExtraRev.length > 0 ? savedExtraRev : auto.extraRevLines);
          setExtraExpLines(savedExtraExp.length > 0 ? savedExtraExp : auto.extraExpLines);

          // Core form fields: auto-calc base, then non-blank saved values win
          const coreFields = Object.fromEntries(
            Object.entries(saved).filter(
              ([k, v]) => k !== "extra_rev_lines" && k !== "extra_exp_lines" && v !== "" && v !== null && v !== undefined,
            ),
          );
          setFields((prev) =>
            recalcTotals({ ...prev, ...auto.fields, ...coreFields, beginning_balance: String(data.starting_balance ?? "0.00") }),
          );
        } else {
          setFormRunId(null);
          setExtraRevLines(auto.extraRevLines);
          setExtraExpLines(auto.extraExpLines);
          setFields((prev) => recalcTotals({ ...prev, ...auto.fields, beginning_balance: "0.00" }));
        }
      });
    return () => { cancelled = true; };
  }, [taxYear, departmentId, expenses, bankAccounts]);

  // ── Debounced PDF preview generation ─────────────────
  const schedulePreview = useCallback((
    f: NysFormFields,
    extraRev: ExtraLine[],
    extraExp: ExtraLine[],
    sign: boolean,
  ) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      if (!templateRef.current) return;
      setIsGenerating(true);
      try {
        const et = computeEffectiveTotals(f, extraRev, extraExp);
        const bytes = await fillNysPdf(templateRef.current, f, {
          signElectronically: sign,
          effectiveTotals: et,
          extraRevLines: extraRev,
          extraExpLines: extraExp,
          taxYear: taxYearRef.current,
        });
        const blob = pdfToBlob(bytes);
        const url = URL.createObjectURL(blob);
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = url;
        setPreviewUrl(url);
      } catch {
        /* preview failed silently */
      } finally {
        setIsGenerating(false);
      }
    }, 450);
  }, []);

  // Re-generate preview whenever fields or extra lines change
  useEffect(() => {
    schedulePreview(fields, extraRevLines, extraExpLines, signElectronically);
  }, [fields, extraRevLines, extraExpLines, signElectronically, schedulePreview]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Field change handler ──────────────────────────────
  const handleFieldChange = useCallback(
    (key: keyof NysFormFields, value: string) => {
      setSaveStatus(null);
      setFields((prev) => recalcTotals({ ...prev, [key]: value }));
    },
    [],
  );

  // ── OCR upload — core logic ──────────────────────────
  const doUploadAndExtract = useCallback(
    async (file: File, replaceId: string | null) => {
      const priorYear = taxYear - 1;
      setIsUploading(true);
      setUploadError(null);
      try {
        // 1. OCR extraction
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/extract-tax-profile", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) throw new Error("Server error during extraction.");
        const extracted = (await res.json()) as Partial<{
          entity_name: string;
          address: string;
          city: string;
          county: string;
          zip: string;
          entity_type: string;
          treasurer_name: string;
          treasurer_email: string;
          treasurer_phone: string;
          beginning_balance: string;
        }>;

        // 2. Update form fields
        setFields((prev) =>
          recalcTotals({
            ...prev,
            entity_name:     extracted.entity_name     || prev.entity_name,
            address:         extracted.address         || prev.address,
            city_town:       extracted.city            || prev.city_town,
            county:          extracted.county          || prev.county,
            zip:             extracted.zip             || prev.zip,
            entity_type:     extracted.entity_type     || prev.entity_type,
            treasurer_name:  extracted.treasurer_name  || prev.treasurer_name,
            certifier_name:  extracted.treasurer_name  || prev.certifier_name,
            treasurer_email: extracted.treasurer_email || prev.treasurer_email,
            treasurer_phone: extracted.treasurer_phone || prev.treasurer_phone,
            beginning_balance:
              extracted.beginning_balance || prev.beginning_balance,
          }),
        );

        // 3. Upload file to storage
        const ext = file.name.split(".").pop()?.toLowerCase() || "pdf";
        const storagePath = `${departmentId}/nys-2-percent/${priorYear}/prior-upload.${ext}`;
        await supabase.storage.from(taxFormsBucket).upload(storagePath, file, {
          contentType: file.type || "application/octet-stream",
          upsert: true,
        });

        // 4. Save filing record
        const { data: authData } = await supabase.auth.getUser();
        const filingPayload = {
          department_id:   departmentId,
          tax_form_type:   "nys_foreign_fire_insurance",
          tax_year:        priorYear,
          source:          "uploaded_prior_filing",
          status:          "uploaded",
          file_path:       storagePath,
          file_name:       file.name,
          file_mime_type:  file.type || "application/octet-stream",
          extracted_data:  extracted as Record<string, unknown>,
          created_by:      authData.user?.id ?? null,
          updated_at:      new Date().toISOString(),
        };
        if (replaceId) {
          await supabase.from("tax_form_filings").update(filingPayload).eq("id", replaceId);
        } else {
          await supabase.from("tax_form_filings").upsert(filingPayload, {
            onConflict: "department_id,tax_year,tax_form_type,source",
          });
        }

        // 5. Persist profile to DB
        await supabase.from("department_tax_profiles").upsert(
          {
            department_id:   departmentId,
            department_name: extracted.entity_name || departmentName,
            address:         extracted.address      || null,
            city:            extracted.city         || null,
            county:          extracted.county       || null,
            zip:             extracted.zip          || null,
            entity_type:     extracted.entity_type     || null,
            treasurer_name:  extracted.treasurer_name  || null,
            treasurer_email: extracted.treasurer_email || null,
            treasurer_phone: extracted.treasurer_phone || null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "department_id" },
        );
      } catch {
        setUploadError("OCR extraction failed. Fields were not updated.");
      } finally {
        setIsUploading(false);
        setPendingFile(null);
        setReplaceConfirmYear(null);
        setExistingFilingId(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [departmentId, departmentName, taxYear],
  );

  // ── OCR upload — entry point with replace-confirm ─────
  const handleFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (fileInputRef.current) fileInputRef.current.value = "";

      const priorYear = taxYear - 1;
      // Check for an existing uploaded filing for the prior year
      const { data: existing } = await supabase
        .from("tax_form_filings")
        .select("id")
        .eq("department_id", departmentId)
        .eq("tax_year", priorYear)
        .eq("tax_form_type", "nys_foreign_fire_insurance")
        .eq("source", "uploaded_prior_filing")
        .maybeSingle();

      if (existing) {
        // Require confirmation before overwriting
        setPendingFile(file);
        setReplaceConfirmYear(priorYear);
        setExistingFilingId(existing.id as string);
        return;
      }

      await doUploadAndExtract(file, null);
    },
    [departmentId, taxYear, doUploadAndExtract],
  );

  // ── Save draft ────────────────────────────────────────
  const handleSaveDraft = useCallback(async () => {
    setIsSaving(true);
    setSaveStatus(null);
    try {
      await supabase.from("department_tax_profiles").upsert(
        {
          department_id:   departmentId,
          department_name: fields.entity_name || departmentName,
          address:  fields.address   || null,
          city:     fields.city_town || null,
          county:   fields.county    || null,
          zip:      fields.zip       || null,
          entity_type:    fields.entity_type    || null,
          treasurer_name: fields.treasurer_name || null,
          treasurer_email:fields.treasurer_email|| null,
          treasurer_phone:fields.treasurer_phone|| null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "department_id" },
      );

      const payload = {
        department_id:    departmentId,
        tax_year:         taxYear,
        starting_balance: parseNum(fields.beginning_balance),
        revenue_total:    effectiveTotals.revenueTotal,
        expense_total:    effectiveTotals.expenseTotal,
        ending_balance:   effectiveTotals.endingBalance,
        status:           "draft",
        form_data: {
          ...(fields as unknown as Record<string, unknown>),
          extra_rev_lines: extraRevLines,
          extra_exp_lines: extraExpLines,
        },
        updated_at: new Date().toISOString(),
      };
      if (formRunId) {
        await supabase.from("tax_form_runs").update(payload).eq("id", formRunId);
      } else {
        const { data } = await supabase
          .from("tax_form_runs")
          .insert(payload)
          .select("id")
          .single();
        if (data?.id) setFormRunId(data.id as string);
      }

      // Record a draft filing in history
      const { data: authData } = await supabase.auth.getUser();
      await supabase.from("tax_form_filings").upsert(
        {
          department_id:  departmentId,
          tax_form_type:  "nys_foreign_fire_insurance",
          tax_year:       taxYear,
          source:         "generated_firebook",
          status:         "draft",
          created_by:     authData.user?.id ?? null,
          updated_at:     new Date().toISOString(),
        },
        { onConflict: "department_id,tax_year,tax_form_type,source" },
      );

      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  }, [departmentId, departmentName, effectiveTotals, extraExpLines, extraRevLines, fields, formRunId, taxYear]);

  // ── Download filled PDF ───────────────────────────────
  const handleDownload = useCallback(async () => {
    if (!templateRef.current) return;
    try {
      const bytes = await fillNysPdf(templateRef.current, fields, {
        signElectronically,
        effectiveTotals,
        extraRevLines,
        extraExpLines,
        taxYear,
      });
      const blob = pdfToBlob(bytes);

      // Trigger browser download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `nys-foreign-fire-insurance-${taxYear}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      // Save to storage and record filing (fire-and-forget, non-blocking)
      const storagePath = `${departmentId}/nys-2-percent/${taxYear}/generated.pdf`;
      supabase.storage.from(taxFormsBucket).upload(storagePath, blob, {
        contentType: "application/pdf",
        upsert: true,
      }).then(async () => {
        const { data: authData } = await supabase.auth.getUser();
        await supabase.from("tax_form_filings").upsert(
          {
            department_id:  departmentId,
            tax_form_type:  "nys_foreign_fire_insurance",
            tax_year:       taxYear,
            source:         "generated_firebook",
            status:         "saved",
            file_path:      storagePath,
            file_name:      `nys-foreign-fire-insurance-${taxYear}.pdf`,
            file_mime_type: "application/pdf",
            created_by:     authData.user?.id ?? null,
            updated_at:     new Date().toISOString(),
          },
          { onConflict: "department_id,tax_year,tax_form_type,source" },
        );
      }).catch(() => { /* storage save failed silently */ });
    } catch {
      /* download failed silently */
    }
  }, [departmentId, effectiveTotals, extraExpLines, extraRevLines, fields, signElectronically, taxYear]);

  // ── Print filled PDF ──────────────────────────────────
  const handlePrint = useCallback(async () => {
    if (!templateRef.current) return;
    try {
      const bytes = await fillNysPdf(templateRef.current, fields, {
        signElectronically,
        effectiveTotals,
        extraRevLines,
        extraExpLines,
        taxYear,
      });
      const blob = pdfToBlob(bytes);
      const url = URL.createObjectURL(blob);
      const win = window.open(url, "_blank");
      if (win) {
        win.addEventListener("load", () => {
          win.print();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        });
      }
    } catch {
      /* print failed silently */
    }
  }, [effectiveTotals, extraExpLines, extraRevLines, fields, signElectronically]);

  return (
    <div className="fb-tab-stack nys-report-root">
      {/* ── Toolbar ── */}
      <div className="nys-toolbar">
        <button type="button" className="fb-secondary-btn nys-back-btn" onClick={onBack}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Tax Forms
        </button>

        <div className="nys-toolbar-right">
          <label className="nys-year-picker">
            <span className="eyebrow nys-year-picker-label">Tax Year</span>
            <select
              className="nys-year-select"
              value={taxYear}
              onChange={(e) => setTaxYear(Number(e.target.value))}
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>

          <label className={`fb-secondary-btn nys-upload-btn${isUploading ? " nys-upload-btn--busy" : ""}`}>
            {isUploading ? (
              <><NysSpinner /> Extracting&hellip;</>
            ) : (
              <>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
                </svg>
                Upload Prior Year Filing
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="nys-sr-only"
              onChange={handleFileChange}
              disabled={isUploading}
            />
          </label>
        </div>
      </div>

      {/* ── Replace-upload confirmation ── */}
      {replaceConfirmYear && pendingFile && (
        <div className="nys-replace-confirm">
          <span className="nys-replace-confirm-msg">
            A prior filing for <strong>{replaceConfirmYear}</strong> already
            exists. Replace it with &ldquo;{pendingFile.name}&rdquo;?
          </span>
          <div className="nys-replace-confirm-actions">
            <button
              type="button"
              className="fb-primary-btn nys-replace-btn"
              onClick={() => doUploadAndExtract(pendingFile, existingFilingId)}
              disabled={isUploading}
            >
              {isUploading ? "Replacing…" : "Yes, Replace"}
            </button>
            <button
              type="button"
              className="fb-secondary-btn"
              onClick={() => {
                setPendingFile(null);
                setReplaceConfirmYear(null);
                setExistingFilingId(null);
              }}
              disabled={isUploading}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {uploadError && (
        <div className="notice notice-error">{uploadError}</div>
      )}

      {/* ── Action bar ── */}
      <div className="nys-action-bar">
        <div>
          <h1 className="nys-report-heading">NYS Foreign Fire Insurance Report (2%)</h1>
          <p className="muted nys-report-subhead">
            Annual Report of Foreign Fire Insurance Premiums &mdash; Tax Year {taxYear}
          </p>
        </div>
        <div className="nys-actions">
          {saveStatus === "saved" && (
            <span className="nys-save-badge nys-save-badge--ok">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
              Saved
            </span>
          )}
          {saveStatus === "error" && (
            <span className="nys-save-badge nys-save-badge--err">Save failed</span>
          )}
          <button type="button" className="fb-secondary-btn" onClick={handleSaveDraft} disabled={isSaving}>
            {isSaving ? "Saving…" : "Save Draft"}
          </button>
          <button type="button" className="fb-secondary-btn nys-print-btn" onClick={handleDownload}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            Download PDF
          </button>
          <button type="button" className="fb-primary-btn nys-print-btn" onClick={handlePrint}>
            Print Form
          </button>
        </div>
      </div>

      {/* ── Split screen ── */}
      <div className="nys-split">
        {/* Left: official PDF preview */}
        <div className="nys-preview-col">
          <p className="eyebrow nys-col-label">
            Official Form Preview
            {isGenerating && <NysSpinner />}
          </p>
          <div className="nys-iframe-wrap">
            <iframe
              key={previewUrl}
              src={previewUrl}
              className="nys-pdf-iframe"
              title="NYS Foreign Fire Insurance Form Preview"
            />
          </div>
        </div>

        {/* Right: editable fields */}
        <div className="nys-fields-col">
          <p className="eyebrow nys-col-label">Edit Fields</p>
          <NysFieldsPanel
            fields={fields}
            onChange={handleFieldChange}
            extraRevLines={extraRevLines}
            extraExpLines={extraExpLines}
            onExtraRevChange={(i, key, val) =>
              setExtraRevLines((prev) => prev.map((l, idx) => idx === i ? { ...l, [key]: val } : l))
            }
            onExtraExpChange={(i, key, val) =>
              setExtraExpLines((prev) => prev.map((l, idx) => idx === i ? { ...l, [key]: val } : l))
            }
            onAddRevLine={() => setExtraRevLines((prev) => [...prev, { desc: "", amt: "" }])}
            onAddExpLine={() => setExtraExpLines((prev) => [...prev, { desc: "", amt: "" }])}
            onRemoveRevLine={(i) => setExtraRevLines((prev) => prev.filter((_, idx) => idx !== i))}
            onRemoveExpLine={(i) => setExtraExpLines((prev) => prev.filter((_, idx) => idx !== i))}
            signElectronically={signElectronically}
            onSignToggle={setSignElectronically}
            effectiveTotals={effectiveTotals}
          />
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Accordion section wrapper
// ─────────────────────────────────────────────────────────

function NysAccordion({
  title,
  open,
  onToggle,
  badge,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`nys-accordion${open ? " nys-accordion--open" : ""}`}>
      <button type="button" className="nys-accordion-header" onClick={onToggle}>
        <span className="nys-accordion-title">{title}</span>
        {badge && <span className="nys-accordion-badge">{badge}</span>}
        <svg
          className="nys-accordion-chevron"
          width="14" height="14"
          viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && <div className="nys-accordion-body">{children}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Fields Panel — 4 collapsible sections
// ─────────────────────────────────────────────────────────

function NysFieldsPanel({
  fields,
  onChange,
  extraRevLines,
  extraExpLines,
  onExtraRevChange,
  onExtraExpChange,
  onAddRevLine,
  onAddExpLine,
  onRemoveRevLine,
  onRemoveExpLine,
  signElectronically,
  onSignToggle,
  effectiveTotals,
}: {
  fields: NysFormFields;
  onChange: (key: keyof NysFormFields, value: string) => void;
  extraRevLines: ExtraLine[];
  extraExpLines: ExtraLine[];
  onExtraRevChange: (i: number, key: keyof ExtraLine, value: string) => void;
  onExtraExpChange: (i: number, key: keyof ExtraLine, value: string) => void;
  onAddRevLine: () => void;
  onAddExpLine: () => void;
  onRemoveRevLine: (i: number) => void;
  onRemoveExpLine: (i: number) => void;
  signElectronically: boolean;
  onSignToggle: (v: boolean) => void;
  effectiveTotals: EffectiveTotals;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setOpen((p) => ({ ...p, [id]: !p[id] }));

  const revBadge = extraRevLines.length > 0 ? `+${extraRevLines.length} extra` : undefined;
  const expBadge = extraExpLines.length > 0 ? `+${extraExpLines.length} extra` : undefined;

  return (
    <div className="nys-accordion-stack">

      {/* ── 1. Organization ─────────────────────────────── */}
      <NysAccordion title="Organization Information" open={!!open.org} onToggle={() => toggle("org")}>
        <NysField id="entity_name" label="Name of Entity" value={fields.entity_name} onChange={(v) => onChange("entity_name", v)} />
        <div className="nys-field-row">
          <NysField id="fire_district" label="Fire District #" value={fields.fire_district} onChange={(v) => onChange("fire_district", v)} />
          <NysField id="county"        label="County"          value={fields.county}        onChange={(v) => onChange("county", v)} />
        </div>
        <NysField id="address" label="Address" value={fields.address} onChange={(v) => onChange("address", v)} />
        <div className="nys-field-row">
          <NysField id="city_town" label="City / Town"  value={fields.city_town} onChange={(v) => onChange("city_town", v)} />
          <NysField id="zip"       label="ZIP"          value={fields.zip}       onChange={(v) => onChange("zip", v)} placeholder="00000" />
        </div>
        <div className="nys-field">
          <span className="nys-field-label">Entity Type</span>
          <div className="nys-type-picker">
            {["Fire Department", "Fire Company", "Benevolent Association"].map((t) => {
              const active = ENTITY_TO_BOX[fields.entity_type] === t;
              return (
                <button
                  key={t}
                  type="button"
                  className={`nys-type-btn${active ? " nys-type-btn--active" : ""}`}
                  onClick={() => {
                    const match = Object.keys(ENTITY_TO_BOX).find((k) => ENTITY_TO_BOX[k] === t);
                    if (match) onChange("entity_type", match);
                  }}
                >{t}</button>
              );
            })}
          </div>
        </div>
        <NysField id="town_or_city"      label="Town or City Where Located"                value={fields.town_or_city}      onChange={(v) => onChange("town_or_city", v)} />
        <NysField id="village"           label="Village (if applicable)"                   value={fields.village}           onChange={(v) => onChange("village", v)} />
        <NysField id="fire_prot_dist"    label="Fire Protection District (if applicable)"  value={fields.fire_prot_dist}    onChange={(v) => onChange("fire_prot_dist", v)} />
        <NysField id="fire_dist_located" label="Fire District Where Located (if applicable)" value={fields.fire_dist_located} onChange={(v) => onChange("fire_dist_located", v)} />
      </NysAccordion>

      {/* ── 2. Revenues ─────────────────────────────────── */}
      <NysAccordion title="Revenues" open={!!open.rev} onToggle={() => toggle("rev")} badge={revBadge}>
        <NysField
          id="beginning_balance"
          label="Balance as of Jan 1 (Beginning Balance)"
          value={fields.beginning_balance}
          onChange={(v) => onChange("beginning_balance", v)}
          type="money"
          hint="Prior year ending balance"
        />

        <div className="nys-fin-sub-title">Foreign Fire Insurance Premiums</div>
        <p className="nys-fin-sub-note muted">Up to 4 sources appear on the form. Additional sources print on the attachment.</p>
        <NysSourceRow
          descId="rev_src1_desc" descLabel="Source 1" amtId="rev_src1_amt" amtLabel="Amount"
          descVal={fields.rev_src1_desc} amtVal={fields.rev_src1_amt}
          onChangeDesc={(v) => onChange("rev_src1_desc", v)}
          onChangeAmt={(v)  => onChange("rev_src1_amt",  v)}
          autoHint="Auto-filled from Firebook"
        />
        <NysSourceRow
          descId="rev_src2_desc" descLabel="Source 2" amtId="rev_src2_amt" amtLabel="Amount"
          descVal={fields.rev_src2_desc} amtVal={fields.rev_src2_amt}
          onChangeDesc={(v) => onChange("rev_src2_desc", v)}
          onChangeAmt={(v)  => onChange("rev_src2_amt",  v)}
        />
        <NysSourceRow
          descId="rev_src3_desc" descLabel="Source 3" amtId="rev_src3_amt" amtLabel="Amount"
          descVal={fields.rev_src3_desc} amtVal={fields.rev_src3_amt}
          onChangeDesc={(v) => onChange("rev_src3_desc", v)}
          onChangeAmt={(v)  => onChange("rev_src3_amt",  v)}
        />
        <NysSourceRow
          descId="rev_src4_desc" descLabel="Source 4" amtId="rev_src4_amt" amtLabel="Amount"
          descVal={fields.rev_src4_desc} amtVal={fields.rev_src4_amt}
          onChangeDesc={(v) => onChange("rev_src4_desc", v)}
          onChangeAmt={(v)  => onChange("rev_src4_amt",  v)}
        />

        {/* Extra revenue lines — attachment only */}
        {extraRevLines.length > 0 && (
          <div className="nys-extra-lines">
            <p className="nys-extra-lines-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
              Additional sources — print on attachment
            </p>
            {extraRevLines.map((l, i) => (
              <NysExtraLineRow
                key={i}
                index={i}
                desc={l.desc}
                amt={l.amt}
                onChange={(key, val) => onExtraRevChange(i, key, val)}
                onRemove={() => onRemoveRevLine(i)}
              />
            ))}
          </div>
        )}
        <button type="button" className="nys-add-line-btn" onClick={onAddRevLine}>
          + Add revenue source
        </button>

        <div className="nys-fin-sub-title">Interest on Investment</div>
        <div className="nys-field-row">
          <NysField id="interest_amt1" label="Interest Line 1" value={fields.interest_amt1} onChange={(v) => onChange("interest_amt1", v)} type="money" />
          <NysField id="interest_amt2" label="Interest Line 2" value={fields.interest_amt2} onChange={(v) => onChange("interest_amt2", v)} type="money" />
        </div>

        <NysEffTotalRow label="Total Revenues" value={effectiveTotals.revenueTotal} />
        <NysEffTotalRow label="Balance + Revenues" value={effectiveTotals.totalBalRev} accent />
      </NysAccordion>

      {/* ── 3. Expenditures ─────────────────────────────── */}
      <NysAccordion title="Expenditures" open={!!open.exp} onToggle={() => toggle("exp")} badge={expBadge}>
        <p className="nys-fin-sub-note muted">Up to 3 lines appear on the form. Additional lines print on the attachment.</p>
        <NysSourceRow
          descId="exp1_desc" descLabel="Line 1" amtId="exp1_amt" amtLabel="Amount"
          descVal={fields.exp1_desc} amtVal={fields.exp1_amt}
          onChangeDesc={(v) => onChange("exp1_desc", v)}
          onChangeAmt={(v)  => onChange("exp1_amt",  v)}
          autoHint="Auto-filled from Firebook"
        />
        <NysSourceRow
          descId="exp2_desc" descLabel="Line 2" amtId="exp2_amt" amtLabel="Amount"
          descVal={fields.exp2_desc} amtVal={fields.exp2_amt}
          onChangeDesc={(v) => onChange("exp2_desc", v)}
          onChangeAmt={(v)  => onChange("exp2_amt",  v)}
        />
        <NysSourceRow
          descId="exp3_desc" descLabel="Line 3" amtId="exp3_amt" amtLabel="Amount"
          descVal={fields.exp3_desc} amtVal={fields.exp3_amt}
          onChangeDesc={(v) => onChange("exp3_desc", v)}
          onChangeAmt={(v)  => onChange("exp3_amt",  v)}
        />

        {/* Extra expenditure lines — attachment only */}
        {extraExpLines.length > 0 && (
          <div className="nys-extra-lines">
            <p className="nys-extra-lines-label">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
              Additional lines — print on attachment
            </p>
            {extraExpLines.map((l, i) => (
              <NysExtraLineRow
                key={i}
                index={i}
                desc={l.desc}
                amt={l.amt}
                onChange={(key, val) => onExtraExpChange(i, key, val)}
                onRemove={() => onRemoveExpLine(i)}
              />
            ))}
          </div>
        )}
        <button type="button" className="nys-add-line-btn" onClick={onAddExpLine}>
          + Add expenditure line
        </button>

        <NysEffTotalRow label="Total Expenditures" value={effectiveTotals.expenseTotal} />

        <div className="nys-ending-balance-display">
          <p className="eyebrow nys-ending-balance-label">Balance as of 12/31 (Ending)</p>
          <p className="nys-ending-balance-value">${fmtMoney(effectiveTotals.endingBalance)}</p>
          <p className="muted nys-ending-balance-formula">= Beginning + Revenues &minus; Expenditures</p>
        </div>
      </NysAccordion>

      {/* ── 4. Certification & Contact ───────────────────── */}
      <NysAccordion title="Certification &amp; Contact" open={!!open.cert} onToggle={() => toggle("cert")}>
        <NysField
          id="treasurer_name"
          label="Print Name (Certifying Officer)"
          value={fields.treasurer_name}
          onChange={(v) => { onChange("treasurer_name", v); onChange("certifier_name", v); }}
        />
        <NysField id="title"           label="Title"     value={fields.title}           onChange={(v) => onChange("title", v)} />
        <NysField id="treasurer_phone" label="Telephone" value={fields.treasurer_phone} onChange={(v) => onChange("treasurer_phone", v)} type="tel" />
        <NysField id="treasurer_email" label="E-mail"    value={fields.treasurer_email} onChange={(v) => onChange("treasurer_email", v)} type="email" />

        <div className="nys-sign-toggle-row">
          <label className="nys-sign-toggle">
            <input
              type="checkbox"
              checked={signElectronically}
              onChange={(e) => onSignToggle(e.target.checked)}
            />
            <span>
              Print name as electronic signature
              <span className="nys-sign-toggle-hint">
                When checked, your printed name appears in the signature line on the PDF.
                Leave unchecked to sign by hand after printing.
              </span>
            </span>
          </label>
          {signElectronically && (
            <p className="nys-sign-preview muted">
              Signature will read: <strong>{fields.treasurer_name || "(name not set)"}</strong>
            </p>
          )}
          {!signElectronically && (
            <p className="nys-sign-preview muted">Signature line left blank — sign by hand after printing.</p>
          )}
        </div>
      </NysAccordion>

    </div>
  );
}

function NysExtraLineRow({
  index, desc, amt, onChange, onRemove,
}: {
  index: number;
  desc: string;
  amt: string;
  onChange: (key: keyof ExtraLine, val: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="nys-extra-line-row">
      <div className="nys-field nys-source-desc">
        <label htmlFor={`extra-desc-${index}`} className="nys-field-label sr-only">Description</label>
        <input
          id={`extra-desc-${index}`}
          type="text"
          value={desc}
          placeholder="Description"
          onChange={(e) => onChange("desc", e.target.value)}
          className="nys-field-input"
        />
      </div>
      <div className="nys-field nys-source-amt">
        <label htmlFor={`extra-amt-${index}`} className="nys-field-label sr-only">Amount</label>
        <input
          id={`extra-amt-${index}`}
          type="text"
          inputMode="decimal"
          value={amt}
          placeholder="0.00"
          onChange={(e) => onChange("amt", e.target.value)}
          className="nys-field-input nys-field-input--amount"
        />
      </div>
      <button type="button" className="nys-remove-line-btn" onClick={onRemove} title="Remove line">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

function NysSourceRow({
  descId, descLabel, amtId, amtLabel,
  descVal, amtVal,
  onChangeDesc, onChangeAmt,
  autoHint,
}: {
  descId: string; descLabel: string;
  amtId:  string; amtLabel:  string;
  descVal: string; amtVal: string;
  onChangeDesc: (v: string) => void;
  onChangeAmt:  (v: string) => void;
  autoHint?: string;
}) {
  return (
    <div className="nys-source-row">
      <div className="nys-field nys-source-desc">
        <label htmlFor={descId} className="nys-field-label">{descLabel}</label>
        <input id={descId} type="text" value={descVal} onChange={(e) => onChangeDesc(e.target.value)} className="nys-field-input" />
        {autoHint && <p className="nys-field-hint muted">{autoHint}</p>}
      </div>
      <div className="nys-field nys-source-amt">
        <label htmlFor={amtId} className="nys-field-label">{amtLabel}</label>
        <input id={amtId} type="text" inputMode="decimal" value={amtVal} onChange={(e) => onChangeAmt(e.target.value)} className="nys-field-input nys-field-input--amount" />
      </div>
    </div>
  );
}

/** Displays an effective (all-lines-included) calculated total */
function NysEffTotalRow({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={`nys-total-row${accent ? " nys-total-row--accent" : ""}`}>
      <span className="nys-total-label">{label}</span>
      <span className="nys-total-value">${fmtMoney(value)}</span>
    </div>
  );
}

function NysField({
  id, label, value, onChange, type = "text", hint, placeholder,
}: {
  id: string; label: string; value: string;
  onChange: (v: string) => void;
  type?: "text" | "email" | "tel" | "money";
  hint?: string; placeholder?: string;
}) {
  return (
    <div className="nys-field">
      <label htmlFor={id} className="nys-field-label">{label}</label>
      <input
        id={id}
        type={type === "money" ? "text" : type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="nys-field-input"
        inputMode={type === "money" ? "decimal" : undefined}
        placeholder={placeholder}
      />
      {hint && <p className="nys-field-hint muted">{hint}</p>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Spinner
// ─────────────────────────────────────────────────────────

function NysSpinner() {
  return (
    <svg className="nys-spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
