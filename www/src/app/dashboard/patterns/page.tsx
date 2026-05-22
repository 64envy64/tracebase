import type { Metadata } from "next";
import { PatternsView } from "@/components/dashboard/PatternsView";
import { getDataInfraFixture } from "@/lib/demo/data-infra-fixture";
import { isDemoMode } from "@/lib/demo/demo-mode";

export const metadata: Metadata = {
  title: "Patterns — TraceBase",
  description: "Reusable patterns and standing rules distilled from past agent runs.",
};

export default async function PatternsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const demo = isDemoMode({ searchParams: sp });
  const fixture = demo ? getDataInfraFixture() : null;
  return (
    <PatternsView
      patterns={fixture?.patterns ?? []}
      codebases={fixture?.codebases ?? []}
      demo={demo}
    />
  );
}
