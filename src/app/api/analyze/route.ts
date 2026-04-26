import { NextResponse } from "next/server";
import { analyzeRepository } from "@/lib/analyzer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      repoUrl?: string;
      apiKey?: string;
      model?: string;
    };

    if (!body.repoUrl?.trim()) {
      return NextResponse.json({ error: "GitHub repository URL is required." }, { status: 400 });
    }

    const report = await analyzeRepository(body.repoUrl, body.apiKey?.trim(), body.model?.trim());
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to analyze repository.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
