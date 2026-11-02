import { applyImport, parseSheetRows, planImport, type SheetRow } from "@/lib/importApplications";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Rows pasted from the tracking sheet (text) or one row from the add form (rows).
// Without commit it only returns what would happen.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?: string; rows?: SheetRow[]; commit?: boolean };
    const rows = body.rows ?? parseSheetRows(body.text ?? "");
    if (rows.length === 0) return Response.json({ error: "Nothing to import" }, { status: 400 });
    if (rows.length > 1000) return Response.json({ error: "Import at most 1000 rows at a time" }, { status: 400 });
    const store = getStore();
    const plan = await planImport(store, rows);
    if (!body.commit) return Response.json({ plan });
    const result = await applyImport(store, plan);
    return Response.json({ plan, result });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not import" }, { status: 400 });
  }
}
