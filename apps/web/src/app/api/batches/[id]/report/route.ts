import { NextResponse } from "next/server";
import { buildBatchReport, findingsOf } from "@/lib/qa-report";
import { listBatchTasks } from "@/lib/store";

// One report for a whole batch: every run's QA findings merged into distinct issues, ranked by
// severity and by how many runs (personas) hit each one.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tasks = await listBatchTasks(id);
  if (tasks.length === 0) return NextResponse.json({ error: "No tasks in this batch" }, { status: 404 });
  const report = buildBatchReport(
    tasks.map((t) => ({
      id: t.id,
      label: t.dedupeKey || t.prompt.slice(0, 60),
      status: t.status,
      cost: t.cost,
      findings: findingsOf(t.resultJson),
    })),
  );
  return NextResponse.json(report);
}
