import { redirect } from "next/navigation";

// Applications were merged into the Applied page; old links still land there.
export default function ApplicationsPage() {
  redirect("/applied");
}
