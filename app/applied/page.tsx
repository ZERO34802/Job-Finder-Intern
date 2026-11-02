import { AppliedTable } from "@/components/AppliedTable";
import { AddApplication, ImportApplications } from "@/components/ImportApplications";
import { getStore } from "@/lib/store";
import { APPLICATION_STATUSES, type ApplicationStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AppliedPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  // listApplications is newest first by when the application last changed.
  const applications = await getStore().listApplications();
  const filter = APPLICATION_STATUSES.includes(status as ApplicationStatus) ? (status as ApplicationStatus) : "all";
  return (
    <main>
      <p className="lede">
        Every application you track, most recently updated first. Change a status or referral and it saves right away.
        Set a role back to saved to return it to the Jobs page (its notes are kept).
      </p>
      <ImportApplications />
      <AddApplication />
      <AppliedTable applications={applications} initialFilter={filter} />
    </main>
  );
}
