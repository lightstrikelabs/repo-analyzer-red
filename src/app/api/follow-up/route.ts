import { NextResponse } from "next/server";
import {
  answerSectionQuestion,
  buildRepositorySearchContext,
  type ChatTurn,
  type RepoReport,
  type ReportSection,
} from "@/lib/analyzer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      apiKey?: string;
      model?: string;
      messages?: ChatTurn[];
      question?: string;
      section?: ReportSection;
      report?: Pick<RepoReport, "repo" | "overview" | "findings">;
    };

    if (!body.apiKey?.trim()) {
      return NextResponse.json({ error: "OpenRouter API key is required." }, { status: 400 });
    }

    if (!body.question?.trim() || !body.section || !body.report) {
      return NextResponse.json({ error: "Question, section, and report context are required." }, { status: 400 });
    }

    const codeContext = await buildRepositorySearchContext({
      repoUrl: body.report.repo.url,
      query: body.question.trim(),
      section: body.section,
    }).catch((error) => {
      console.warn(
        "Repository search failed for follow-up",
        error instanceof Error ? error.message : "Unknown search error",
      );
      return "Repository search failed for this question. Answer from the report context and explain what code evidence is missing.";
    });

    const answer = await answerSectionQuestion({
      apiKey: body.apiKey.trim(),
      codeContext,
      model: body.model?.trim(),
      messages: body.messages,
      question: body.question.trim(),
      section: body.section,
      report: body.report,
    });

    return NextResponse.json({ answer });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to answer follow-up question.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
