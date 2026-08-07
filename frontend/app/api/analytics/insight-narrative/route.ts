/**
 * Rewrites already-computed analytics insights into plainer English.
 *
 * This route is deliberately narrow. It receives findings that Hallix has
 * already calculated, along with the exact figures behind them, and returns the
 * same findings worded more naturally. It never receives the ledger, never
 * computes anything, and cannot introduce a number that was not already
 * verified client-side.
 *
 * Anything unexpected — no API key, a malformed response, an unknown id, a
 * rewrite containing a figure that was not supplied — is dropped. The caller
 * already has correct deterministic wording on screen, so the safe failure is
 * to change nothing.
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";

export const runtime = "nodejs";

const MAX_INSIGHTS = 12;
const MAX_SUMMARY_LENGTH = 400;

const insightSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(["action_needed", "watch", "positive", "informational"]),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
  facts: z.array(z.string().max(200)).max(12),
});

const requestSchema = z.object({
  insights: z.array(insightSchema).min(1).max(MAX_INSIGHTS),
});

const PROMPT = `You rewrite pre-calculated findings for a volunteer fire department treasurer.

You will receive findings that have ALREADY been calculated from the department's
records, each with the exact supporting figures.

Rules, in order of importance:
1. Never invent, infer, adjust, or recalculate any number, date, percentage or count.
   Only use figures that appear verbatim in that finding's "facts" or "summary".
2. Never add a conclusion, cause, recommendation or comparison that is not already stated.
3. Never state or imply a legal requirement, a deadline imposed by law, an audit
   result, or a compliance determination.
4. Keep each rewrite to one or two short sentences of plain English. Avoid
   accounting jargon. Write for someone who is not an accountant.
5. Keep the same meaning and the same severity. Do not soften a problem or
   dramatise a normal situation.
6. If a finding is already clear, return it essentially unchanged.

Return ONLY valid JSON of the form:
{"summaries":[{"id":"<the finding id>","summary":"<rewritten text>"}]}

Include every id you were given, and no others.`;

const responseSchema = z.object({
  summaries: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().min(1).max(MAX_SUMMARY_LENGTH),
      }),
    )
    .max(MAX_INSIGHTS),
});

export async function POST(request: NextRequest) {
  let parsedBody: z.infer<typeof requestSchema>;
  try {
    parsedBody = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ summaries: [] }, { status: 400 });
  }

  // Narration is an enhancement. Without a key the deterministic wording stands.
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ summaries: [] });
  }

  const { insights } = parsedBody;
  const allowedIds = new Set(insights.map((insight) => insight.id));

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_INSIGHT_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: PROMPT },
        { role: "user", content: JSON.stringify({ findings: insights }) },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return NextResponse.json({ summaries: [] });

    const parsed = responseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return NextResponse.json({ summaries: [] });

    const summaries = parsed.data.summaries.filter((entry) => {
      if (!allowedIds.has(entry.id)) return false;
      const source = insights.find((insight) => insight.id === entry.id);
      return source != null && onlyUsesSuppliedNumbers(entry.summary, source);
    });

    return NextResponse.json({ summaries });
  } catch (error) {
    console.error("[analytics] insight narration failed", error);
    return NextResponse.json({ summaries: [] });
  }
}

/**
 * The last line of defence against a fabricated figure.
 *
 * Every number in the rewrite must already appear in the finding it came from.
 * A model that invents "spending rose 40%" when no 40 was supplied fails here
 * and the deterministic wording is kept instead.
 */
function onlyUsesSuppliedNumbers(
  summary: string,
  source: z.infer<typeof insightSchema>,
): boolean {
  const supplied = new Set(extractNumbers([source.summary, source.title, ...source.facts].join(" ")));
  return extractNumbers(summary).every((value) => supplied.has(value));
}

function extractNumbers(text: string): string[] {
  // Commas are stripped so "1,200" and "1200" are treated as the same figure.
  return (text.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map((value) =>
    String(Number(value)),
  );
}
