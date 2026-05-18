import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const revalidate = 3600;

const REPO = "64envy64/tracebase";
const FALLBACK_STARS = 48;

type GitHubRepoResponse = {
  stargazers_count?: unknown;
};

export async function GET() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate },
    });

    if (!res.ok) {
      throw new Error(`github ${res.status}`);
    }

    const data = (await res.json()) as GitHubRepoResponse;
    const stars =
      typeof data.stargazers_count === "number" && Number.isFinite(data.stargazers_count)
        ? data.stargazers_count
        : FALLBACK_STARS;

    return NextResponse.json(
      { repo: REPO, stars },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch {
    return NextResponse.json(
      { repo: REPO, stars: FALLBACK_STARS, fallback: true },
      {
        headers: {
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
        },
      },
    );
  }
}
