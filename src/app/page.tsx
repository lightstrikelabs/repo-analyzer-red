"use client";

import {
  BarChart3,
  Boxes,
  ChevronDown,
  FileText,
  GitBranch,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  Send,
  ShieldCheck,
  TestTube2,
  Wrench,
  X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { RepoReport, ReportSection, SectionId } from "@/lib/analyzer";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  section: ReportSection;
  messages: ChatMessage[];
  loading: boolean;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

const loadingPhases = [
  {
    title: "Cloning repository",
    detail: "Start by checking whether the project shape matches the README and package scripts.",
    focus: "Follow up on setup friction, missing env docs, and whether the repo can be run from scratch.",
    progress: 14,
  },
  {
    title: "Mapping files",
    detail: "The scanner is separating source, tests, docs, configs, and generated output.",
    focus: "Look for oversized files, unclear ownership boundaries, and duplicated utility code.",
    progress: 31,
  },
  {
    title: "Scoring maintainability",
    detail: "File size, branch density, deferred-work markers, and type usage are being weighed.",
    focus: "Ask which modules should be split before new product work lands.",
    progress: 48,
  },
  {
    title: "Checking tests and release gates",
    detail: "The report is looking for test files, test scripts, build scripts, and CI workflow signals.",
    focus: "Follow up on the riskiest untested flow and the fastest meaningful test to add.",
    progress: 64,
  },
  {
    title: "Reviewing security and docs",
    detail: "Dependency lockfiles, secret-like hints, README coverage, and env examples are being checked.",
    focus: "Ask about exposed config, manual auth review points, and onboarding gaps.",
    progress: 78,
  },
  {
    title: "Preparing reviewer notes",
    detail: "Scores, charts, section summaries, and follow-up prompts are being assembled.",
    focus: "Use the lowest-scoring section as the first follow-up target.",
    progress: 88,
  },
  {
    title: "Enriching with OpenRouter",
    detail: "If a key was provided, the selected model is tightening the summaries without changing the scores.",
    focus: "Ask for prioritized fixes, confidence level, and what deserves human review.",
    progress: 94,
  },
];

const sectionIcons: Record<SectionId, typeof Wrench> = {
  maintainability: Wrench,
  testing: TestTube2,
  security: ShieldCheck,
  architecture: Boxes,
  documentation: FileText,
};

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(DEFAULT_OPENROUTER_MODEL);
  const [report, setReport] = useState<RepoReport | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [storedValuesLoaded, setStoredValuesLoaded] = useState(false);

  useEffect(() => {
    setRepoUrl(window.localStorage.getItem("repo-quality.repoUrl") ?? "");
    setApiKey(window.localStorage.getItem("repo-quality.openRouterKey") ?? "");
    setModel(window.localStorage.getItem("repo-quality.model") ?? DEFAULT_OPENROUTER_MODEL);
    const savedReport = readStoredJson<RepoReport>("repo-quality.report");
    if (savedReport) {
      setReport(savedReport);
      const savedConversations = readStoredJson<Conversation[]>(
        conversationStorageKey(savedReport.repo.url),
      );
      setConversations(savedConversations ?? []);
      setActiveConversationId(savedConversations?.[0]?.id ?? null);
    }
    setStoredValuesLoaded(true);
  }, []);

  useEffect(() => {
    if (!storedValuesLoaded) return;
    window.localStorage.setItem("repo-quality.repoUrl", repoUrl);
  }, [repoUrl, storedValuesLoaded]);

  useEffect(() => {
    if (!storedValuesLoaded) return;
    window.localStorage.setItem("repo-quality.openRouterKey", apiKey);
  }, [apiKey, storedValuesLoaded]);

  useEffect(() => {
    if (!storedValuesLoaded) return;
    window.localStorage.setItem("repo-quality.model", model);
  }, [model, storedValuesLoaded]);

  useEffect(() => {
    if (!storedValuesLoaded) return;

    if (report) {
      window.localStorage.setItem("repo-quality.report", JSON.stringify(report));
      return;
    }

    if (!loading) {
      window.localStorage.removeItem("repo-quality.report");
    }
  }, [loading, report, storedValuesLoaded]);

  useEffect(() => {
    if (!storedValuesLoaded || !report) return;
    window.localStorage.setItem(conversationStorageKey(report.repo.url), JSON.stringify(conversations));
  }, [conversations, report, storedValuesLoaded]);

  useEffect(() => {
    if (!loading) {
      setLoadingStep(0);
      return;
    }

    const interval = window.setInterval(() => {
      setLoadingStep((current) => Math.min(current + 1, loadingPhases.length - 1));
    }, 1800);

    return () => window.clearInterval(interval);
  }, [loading]);

  async function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setLoadingStep(0);
    setError("");
    setReport(null);
    setConversations([]);
    setActiveConversationId(null);
    setChatOpen(false);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, apiKey, model }),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Analysis failed.");
      const nextReport = payload as RepoReport;
      setReport(nextReport);
      const savedConversations = readStoredJson<Conversation[]>(conversationStorageKey(nextReport.repo.url));
      setConversations(savedConversations ?? []);
      setActiveConversationId(savedConversations?.[0]?.id ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Analysis failed.");
    } finally {
      setLoading(false);
    }
  }

  async function askFollowUp(section: ReportSection) {
    const question = questions[section.id]?.trim();
    if (!question) return;

    if (!apiKey.trim()) {
      setError("OpenRouter API key is required for follow-up questions.");
      setChatOpen(true);
      return;
    }

    setError("");
    setQuestions((current) => ({ ...current, [section.id]: "" }));
    await startConversation(section, question);
  }

  async function startConversation(section: ReportSection, question: string) {
    const conversationId = createId();
    const now = Date.now();
    const userMessage = makeMessage("user", question);
    const nextConversation: Conversation = {
      id: conversationId,
      title: titleFromQuestion(question),
      section,
      messages: [userMessage],
      loading: true,
      createdAt: now,
      updatedAt: now,
    };

    setConversations((current) => [nextConversation, ...current]);
    setActiveConversationId(conversationId);
    setChatOpen(true);
    await requestAssistant(conversationId, section, [userMessage], question);
  }

  async function continueConversation(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const question = chatDraft.trim();
    if (!question || !activeConversationId) return;

    if (!apiKey.trim()) {
      updateConversation(activeConversationId, {
        error: "OpenRouter API key is required for follow-up questions.",
      });
      return;
    }

    const active = conversations.find((conversation) => conversation.id === activeConversationId);
    if (!active) return;

    const userMessage = makeMessage("user", question);
    const nextMessages = [...active.messages, userMessage];
    setChatDraft("");
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === activeConversationId
          ? {
              ...conversation,
              messages: nextMessages,
              loading: true,
              error: undefined,
              updatedAt: Date.now(),
            }
          : conversation,
      ),
    );

    await requestAssistant(activeConversationId, active.section, nextMessages, question);
  }

  async function requestAssistant(
    conversationId: string,
    section: ReportSection,
    messages: ChatMessage[],
    question: string,
  ) {
    try {
      const response = await fetch("/api/follow-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          model,
          question,
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          section,
          report: report
            ? {
                repo: report.repo,
                overview: report.overview,
                findings: report.findings,
              }
            : undefined,
        }),
      });

      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Follow-up failed.");
      const assistantMessage = makeMessage("assistant", payload.answer);
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                messages: [...conversation.messages, assistantMessage],
                loading: false,
                error: undefined,
                updatedAt: Date.now(),
              }
            : conversation,
        ),
      );
    } catch (caught) {
      setConversations((current) =>
        current.map((conversation) =>
          conversation.id === conversationId
            ? {
                ...conversation,
                loading: false,
                error: caught instanceof Error ? caught.message : "Follow-up failed.",
                updatedAt: Date.now(),
              }
            : conversation,
        ),
      );
    }
  }

  function updateConversation(conversationId: string, patch: Partial<Conversation>) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, ...patch, updatedAt: Date.now() }
          : conversation,
      ),
    );
  }

  const bestSection = useMemo(() => {
    if (!report) return null;
    return [...report.sections].sort((a, b) => b.score - a.score)[0];
  }, [report]);
  const activeConversation =
    conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0] ?? null;

  return (
    <main className="min-h-screen bg-[#f6f5f1] text-[#161616]">
      <section className="border-b border-[#d9d5ca] bg-[#fbfaf7]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#c2410c]">
                Repository Quality
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-normal text-[#111111] sm:text-4xl">
                Report Card
              </h1>
            </div>
            {report ? (
              <div className="flex items-center gap-3 text-sm text-[#5f5b53]">
                <Lock className="h-4 w-4" aria-hidden="true" />
                <span>{report.modelNote}</span>
              </div>
            ) : null}
          </div>

          <form
            onSubmit={analyze}
            className="grid gap-3"
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          >
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(260px,0.8fr)_auto]">
              <label className="flex min-w-0 items-center gap-3 border border-[#cfc9bb] bg-white px-3 py-2">
                <GitBranch className="h-5 w-5 shrink-0 text-[#146c60]" aria-hidden="true" />
                <span className="sr-only">GitHub repository URL</span>
                <input
                  name="repository-url"
                  value={repoUrl}
                  onChange={(event) => setRepoUrl(event.target.value)}
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#8f887b]"
                  placeholder="https://github.com/owner/repo"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>

              <label className="flex min-w-0 items-center gap-3 border border-[#cfc9bb] bg-white px-3 py-2">
                <KeyRound className="h-5 w-5 shrink-0 text-[#3b5bdb]" aria-hidden="true" />
                <span className="sr-only">OpenRouter API key</span>
                <input
                  name="openrouter-api-token"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#8f887b]"
                  placeholder="OpenRouter API key"
                  type="password"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                  spellCheck={false}
                />
              </label>

              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-14 items-center justify-center gap-2 bg-[#111111] px-5 text-sm font-semibold text-white transition hover:bg-[#333333] disabled:cursor-not-allowed disabled:bg-[#77736a]"
                title="Analyze repository"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Analyze
              </button>
            </div>

            <details className="group border border-[#d8d2c5] bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-sm font-semibold text-[#3f3b35]">
                <span>Advanced</span>
                <ChevronDown
                  className="h-4 w-4 text-[#7b7468] transition group-open:rotate-180"
                  aria-hidden="true"
                />
              </summary>
              <div className="grid gap-3 border-t border-[#e4dfd4] p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                <label className="grid gap-2">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
                    OpenRouter Model
                  </span>
                  <input
                    name="openrouter-model-id"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    className="h-11 border border-[#cfc9bb] bg-[#fbfaf7] px-3 text-sm outline-none focus:border-[#146c60]"
                    placeholder={DEFAULT_OPENROUTER_MODEL}
                    autoCapitalize="none"
                    autoCorrect="off"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => setModel(DEFAULT_OPENROUTER_MODEL)}
                  className="h-11 border border-[#cfc9bb] px-4 text-sm font-semibold text-[#3f3b35] transition hover:bg-[#f6f5f1]"
                >
                  Use Free Router
                </button>
              </div>
            </details>
          </form>

          {error ? (
            <div className="border border-[#be123c] bg-[#fff1f2] px-4 py-3 text-sm text-[#9f1239]">{error}</div>
          ) : null}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {report ? (
          <div className="grid gap-6">
            <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
              <OverviewPanel report={report} bestSection={bestSection} />
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {report.bigNumbers.map((item) => (
                  <div key={item.label} className="border border-[#d8d2c5] bg-white p-5">
                    <p className="text-sm font-medium text-[#5f5b53]">{item.label}</p>
                    <p className="mt-3 text-4xl font-semibold tracking-normal text-[#111111]">{item.value}</p>
                    <p className="mt-2 text-sm text-[#7b7468]">{item.caption}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <LanguagePanel report={report} />
              <FindingsPanel report={report} />
            </div>

            <div className="grid gap-5">
              {report.sections.map((section) => (
                <SectionPanel
                  key={section.id}
                  section={section}
                  question={questions[section.id] ?? ""}
                  onQuestionChange={(value) =>
                    setQuestions((current) => ({ ...current, [section.id]: value }))
                  }
                  onAsk={() => askFollowUp(section)}
                />
              ))}
            </div>
          </div>
        ) : (
          <EmptyState loading={loading} loadingStep={loadingStep} />
        )}
      </section>

      <ChatSlideout
        open={chatOpen}
        repoLabel={report ? `${report.repo.owner}/${report.repo.name}` : ""}
        conversations={conversations}
        activeConversation={activeConversation}
        activeConversationId={activeConversationId}
        draft={chatDraft}
        onClose={() => setChatOpen(false)}
        onDraftChange={setChatDraft}
        onSubmit={continueConversation}
        onSelectConversation={(conversationId) => {
          setActiveConversationId(conversationId);
          setChatOpen(true);
        }}
      />

      <ChatReturnMenu
        visible={!chatOpen && Boolean(report)}
        repoLabel={report ? `${report.repo.owner}/${report.repo.name}` : ""}
        conversations={conversations}
        onOpen={() => {
          setActiveConversationId((current) => current ?? conversations[0]?.id ?? null);
          setChatOpen(true);
        }}
        onSelectConversation={(conversationId) => {
          setActiveConversationId(conversationId);
          setChatOpen(true);
        }}
      />
    </main>
  );
}

function OverviewPanel({
  report,
  bestSection,
}: {
  report: RepoReport;
  bestSection: ReportSection | null;
}) {
  return (
    <div className="border border-[#d8d2c5] bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-[#5f5b53]">
            {report.repo.owner}/{report.repo.name}
          </p>
          <p className="mt-1 text-xs text-[#7b7468]">
            {new Date(report.repo.analyzedAt).toLocaleString()}
          </p>
        </div>
        <ScoreRing score={report.overview.score} grade={report.overview.grade} size="large" />
      </div>
      <p className="mt-5 text-sm leading-6 text-[#3f3b35]">{report.overview.summary}</p>
      {bestSection ? (
        <div className="mt-5 border-t border-[#e4dfd4] pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#c2410c]">Strongest Area</p>
          <p className="mt-2 text-lg font-semibold">{bestSection.title}</p>
        </div>
      ) : null}
    </div>
  );
}

function LanguagePanel({ report }: { report: RepoReport }) {
  return (
    <div className="border border-[#d8d2c5] bg-white p-5">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-[#146c60]" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Language Mix</h2>
      </div>
      <div className="mt-5 grid gap-4">
        {report.languageBreakdown.map((slice) => (
          <div key={slice.name}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-[#3f3b35]">{slice.name}</span>
              <span className="text-[#7b7468]">{slice.percent}%</span>
            </div>
            <div className="mt-2 h-3 bg-[#ebe6db]">
              <div
                className="h-full"
                style={{ width: `${Math.max(slice.percent, 3)}%`, backgroundColor: slice.color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FindingsPanel({ report }: { report: RepoReport }) {
  return (
    <div className="border border-[#d8d2c5] bg-white p-5">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-5 w-5 text-[#3b5bdb]" aria-hidden="true" />
        <h2 className="text-lg font-semibold">Reviewer Notes</h2>
      </div>
      <div className="mt-5 divide-y divide-[#e4dfd4]">
        {report.findings.map((finding) => (
          <p key={finding} className="py-3 text-sm leading-6 text-[#3f3b35] first:pt-0 last:pb-0">
            {finding}
          </p>
        ))}
      </div>
    </div>
  );
}

function SectionPanel({
  section,
  question,
  onQuestionChange,
  onAsk,
}: {
  section: ReportSection;
  question: string;
  onQuestionChange: (value: string) => void;
  onAsk: () => void;
}) {
  const Icon = sectionIcons[section.id];

  return (
    <article className="border border-[#d8d2c5] bg-white">
      <div className="grid gap-5 p-5 lg:grid-cols-[240px_minmax(0,1fr)_minmax(260px,0.72fr)]">
        <div>
          <div className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-[#c2410c]" aria-hidden="true" />
            <h2 className="text-lg font-semibold">{section.title}</h2>
          </div>
          <div className="mt-5 flex items-center gap-4">
            <ScoreRing score={section.score} grade={section.grade} />
            <Sparkline points={section.chart} />
          </div>
        </div>

        <div>
          <p className="text-sm leading-6 text-[#3f3b35]">{section.summary}</p>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            {section.metrics.map((metric) => (
              <div key={metric.label} className="border-t border-[#e4dfd4] pt-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
                  {metric.label}
                </p>
                <p className="mt-1 text-2xl font-semibold tracking-normal">{metric.value}</p>
                {metric.detail ? <p className="mt-1 text-xs text-[#7b7468]">{metric.detail}</p> : null}
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <TextList title="Signals" items={section.highlights} />
            <TextList title="Next Checks" items={section.risks} />
          </div>
        </div>

        <div className="border-t border-[#e4dfd4] pt-5 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
          <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
            Ask About {section.title}
          </label>
          <textarea
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            className="mt-3 min-h-28 w-full resize-y border border-[#cfc9bb] bg-[#fbfaf7] p-3 text-sm outline-none focus:border-[#146c60]"
            placeholder="What should we fix first?"
          />
          <button
            type="button"
            onClick={onAsk}
            disabled={!question.trim()}
            className="mt-3 inline-flex h-10 items-center justify-center gap-2 bg-[#146c60] px-4 text-sm font-semibold text-white transition hover:bg-[#0f554b] disabled:cursor-not-allowed disabled:bg-[#8aa7a0]"
            title="Ask follow-up"
          >
            <Send className="h-4 w-4" />
            Open Chat
          </button>
        </div>
      </div>
    </article>
  );
}

function ChatSlideout({
  open,
  repoLabel,
  conversations,
  activeConversation,
  activeConversationId,
  draft,
  onClose,
  onDraftChange,
  onSubmit,
  onSelectConversation,
}: {
  open: boolean;
  repoLabel: string;
  conversations: Conversation[];
  activeConversation: Conversation | null;
  activeConversationId: string | null;
  draft: string;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSelectConversation: (conversationId: string) => void;
}) {
  return (
    <>
      {open ? <button className="fixed inset-0 z-40 bg-black/20" aria-label="Close chat" onClick={onClose} /> : null}
      <aside
        className={`fixed inset-y-0 right-0 z-50 grid w-full max-w-5xl grid-cols-1 border-l border-[#cfc9bb] bg-[#fbfaf7] shadow-2xl transition-transform duration-300 md:grid-cols-[280px_minmax(0,1fr)] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!open}
      >
        <div className="hidden border-r border-[#d8d2c5] bg-white md:block">
          <div className="border-b border-[#e4dfd4] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#c2410c]">Conversations</p>
            <p className="mt-2 text-sm text-[#7b7468]">
              {repoLabel ? `${repoLabel} · ` : ""}
              {conversations.length} section threads
            </p>
          </div>
          <div className="max-h-[calc(100vh-86px)] overflow-y-auto p-3">
            {conversations.length ? (
              <div className="grid gap-2">
                {conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => onSelectConversation(conversation.id)}
                    className={`rounded-md border p-3 text-left transition ${
                      conversation.id === activeConversationId
                        ? "border-[#146c60] bg-[#eef8f5]"
                        : "border-[#e4dfd4] bg-white hover:bg-[#f6f5f1]"
                    }`}
                  >
                    <p className="line-clamp-2 text-sm font-semibold text-[#25221e]">{conversation.title}</p>
                    <p className="mt-2 text-xs text-[#7b7468]">
                      {repoLabel ? `${repoLabel} · ` : ""}
                      {conversation.section.title}
                    </p>
                  </button>
                ))}
              </div>
            ) : (
              <p className="p-3 text-sm leading-6 text-[#7b7468]">Ask from any report section to start a thread.</p>
            )}
          </div>
        </div>

        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <div className="flex items-start justify-between gap-4 border-b border-[#d8d2c5] bg-white p-4">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#c2410c]">
                {repoLabel || "Repo Chat"}
              </p>
              <h2 className="mt-1 truncate text-lg font-semibold">
                {activeConversation?.title ?? "Ask a section question"}
              </h2>
              <p className="mt-1 text-xs text-[#7b7468]">
                {activeConversation?.section.title ? `${activeConversation.section.title} · ` : ""}
                Searches matching repo files before answering.
              </p>
              {conversations.length > 1 ? (
                <select
                  value={activeConversationId ?? ""}
                  onChange={(event) => onSelectConversation(event.target.value)}
                  className="mt-3 h-10 w-full border border-[#cfc9bb] bg-[#fbfaf7] px-2 text-sm outline-none md:hidden"
                  aria-label="Select conversation"
                >
                  {conversations.map((conversation) => (
                    <option key={conversation.id} value={conversation.id}>
                      {conversation.section.title}: {conversation.title}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="grid h-9 w-9 shrink-0 place-items-center border border-[#cfc9bb] text-[#3f3b35] transition hover:bg-[#f6f5f1]"
              aria-label="Close chat"
              title="Close chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto p-4">
            {activeConversation ? (
              <div className="mx-auto grid max-w-3xl gap-4">
                {activeConversation.messages.map((message) => (
                  <div
                    key={message.id}
                    className={`max-w-[92%] rounded-md border p-4 ${
                      message.role === "user"
                        ? "ml-auto border-[#146c60] bg-[#eef8f5]"
                        : "mr-auto border-[#d8d2c5] bg-white"
                    }`}
                  >
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
                      {message.role === "user" ? "You" : "Reviewer"}
                    </p>
                    <MarkdownMessage content={message.content} />
                  </div>
                ))}
                {activeConversation.loading ? (
                  <div className="mr-auto flex max-w-[92%] items-center gap-3 rounded-md border border-[#d8d2c5] bg-white p-4 text-sm text-[#7b7468]">
                    <Loader2 className="h-4 w-4 animate-spin text-[#146c60]" />
                    Searching repo context and drafting the answer
                  </div>
                ) : null}
                {activeConversation.error ? (
                  <p className="rounded-md border border-[#be123c] bg-[#fff1f2] p-3 text-sm text-[#9f1239]">
                    {activeConversation.error}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <MessageSquare className="mx-auto h-10 w-10 text-[#146c60]" />
                  <p className="mt-4 text-lg font-semibold">No conversation selected</p>
                  <p className="mt-2 text-sm text-[#7b7468]">Ask a question from a report section to start.</p>
                </div>
              </div>
            )}
          </div>

          <form onSubmit={onSubmit} className="border-t border-[#d8d2c5] bg-white p-4">
            <div className="mx-auto flex max-w-3xl gap-3">
              <textarea
                value={draft}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey) return;
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
                className="min-h-14 flex-1 resize-none border border-[#cfc9bb] bg-[#fbfaf7] p-3 text-sm outline-none focus:border-[#146c60]"
                placeholder="Ask a follow-up about this section..."
                disabled={!activeConversation || activeConversation.loading}
              />
              <button
                type="submit"
                disabled={!activeConversation || activeConversation.loading || !draft.trim()}
                className="inline-flex h-14 items-center justify-center gap-2 bg-[#146c60] px-4 text-sm font-semibold text-white transition hover:bg-[#0f554b] disabled:cursor-not-allowed disabled:bg-[#8aa7a0]"
                title="Send message"
              >
                <Send className="h-4 w-4" />
                Send
              </button>
            </div>
          </form>
        </div>
      </aside>
    </>
  );
}

function ChatReturnMenu({
  visible,
  repoLabel,
  conversations,
  onOpen,
  onSelectConversation,
}: {
  visible: boolean;
  repoLabel: string;
  conversations: Conversation[];
  onOpen: () => void;
  onSelectConversation: (conversationId: string) => void;
}) {
  if (!visible) return null;

  return (
    <details className="group fixed bottom-5 right-5 z-30">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-[#cfc9bb] bg-white px-3 py-3 text-sm font-semibold text-[#25221e] shadow-lg transition hover:bg-[#f6f5f1]">
        <MessageSquare className="h-4 w-4 text-[#146c60]" aria-hidden="true" />
        <span>Chats</span>
        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-[#146c60] px-1 text-xs text-white">
          {conversations.length}
        </span>
      </summary>
      <div className="absolute bottom-14 right-0 w-[min(320px,calc(100vw-2rem))] rounded-md border border-[#cfc9bb] bg-white p-3 shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-[#e4dfd4] pb-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#c2410c]">Recent Threads</p>
            <p className="mt-1 text-xs text-[#7b7468]">{repoLabel || "Return to repo chat"}</p>
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="h-9 rounded-md bg-[#111111] px-3 text-xs font-semibold text-white transition hover:bg-[#333333]"
          >
            Open
          </button>
        </div>
        <div className="mt-3 grid gap-2">
          {conversations.length ? (
            conversations.slice(0, 5).map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => onSelectConversation(conversation.id)}
                className="rounded-md border border-[#e4dfd4] bg-[#fbfaf7] p-3 text-left transition hover:border-[#146c60] hover:bg-[#eef8f5]"
              >
                <p className="line-clamp-1 text-sm font-semibold text-[#25221e]">{conversation.title}</p>
                <p className="mt-1 text-xs text-[#7b7468]">
                  {repoLabel ? `${repoLabel} · ` : ""}
                  {conversation.section.title}
                </p>
              </button>
            ))
          ) : (
            <p className="rounded-md border border-dashed border-[#d8d2c5] bg-[#fbfaf7] p-3 text-sm leading-6 text-[#7b7468]">
              No chats yet. Ask a question from any report section to start one.
            </p>
          )}
        </div>
      </div>
    </details>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  const parts = splitThinking(content);

  return (
    <div className="grid gap-3">
      {parts.thinking ? (
        <details className="rounded-md border border-[#d8d2c5] bg-[#f6f5f1]">
          <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
            Model Thinking
          </summary>
          <div className="markdown-body border-t border-[#d8d2c5] p-3 text-[#5f5b53]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{parts.thinking}</ReactMarkdown>
          </div>
        </details>
      ) : null}
      {parts.answer ? (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{parts.answer}</ReactMarkdown>
        </div>
      ) : null}
    </div>
  );
}

function splitThinking(content: string) {
  const thinkBlocks = [...content.matchAll(/<think>([\s\S]*?)<\/think>/gi)];
  const thinking = thinkBlocks.map((match) => match[1].trim()).filter(Boolean).join("\n\n");
  const answer = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  return {
    thinking,
    answer: answer || (thinking ? "" : content),
  };
}

function ScoreRing({
  score,
  grade,
  size = "small",
}: {
  score: number;
  grade: string;
  size?: "small" | "large";
}) {
  const dimension = size === "large" ? "h-32 w-32" : "h-24 w-24";
  const inner = size === "large" ? "h-[96px] w-[96px]" : "h-[70px] w-[70px]";

  return (
    <div
      className={`${dimension} grid shrink-0 place-items-center rounded-full`}
      style={{
        background: `conic-gradient(#146c60 ${score * 3.6}deg, #e4dfd4 0deg)`,
      }}
      aria-label={`Score ${score}, grade ${grade}`}
    >
      <div className={`${inner} grid place-items-center rounded-full bg-white text-center`}>
        <div>
          <p className="text-3xl font-semibold tracking-normal">{score}</p>
          <p className="text-xs font-semibold text-[#c2410c]">{grade}</p>
        </div>
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  const path = points
    .map((point, index) => {
      const x = (index / Math.max(points.length - 1, 1)) * 118 + 1;
      const y = 58 - (point / 100) * 54;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <svg className="h-16 w-32" viewBox="0 0 120 60" role="img" aria-label="Section score trend">
      <path d="M 1 58 H 119" stroke="#e4dfd4" strokeWidth="1" />
      <path d={path} fill="none" stroke="#d97706" strokeLinecap="round" strokeWidth="4" />
    </svg>
  );
}

function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">{title}</p>
      <ul className="mt-2 space-y-2 text-sm leading-5 text-[#3f3b35]">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function makeMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: createId(),
    role,
    content,
  };
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function titleFromQuestion(question: string) {
  const clean = question.replace(/\s+/g, " ").trim();
  if (clean.length <= 56) return clean;
  return `${clean.slice(0, 53)}...`;
}

function readStoredJson<T>(key: string): T | null {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function conversationStorageKey(repoUrl: string) {
  return `repo-quality.conversations.${repoUrl}`;
}

function EmptyState({ loading, loadingStep }: { loading: boolean; loadingStep: number }) {
  const phase = loadingPhases[Math.min(loadingStep, loadingPhases.length - 1)];

  return (
    <div className="grid min-h-[54vh] place-items-center border border-dashed border-[#cfc9bb] bg-[#fbfaf7] p-5 sm:p-8">
      <div className="w-full max-w-2xl text-center">
        <BarChart3 className="mx-auto h-10 w-10 text-[#146c60]" aria-hidden="true" />
        <p className="mt-5 text-xl font-semibold">{loading ? phase.title : "No report loaded"}</p>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-[#7b7468]">
          {loading ? phase.detail : "Enter a repository URL to begin."}
        </p>

        {loading ? (
          <div className="mt-6 border border-[#d8d2c5] bg-white p-4 text-left">
            <div className="flex items-center justify-between gap-4 text-xs font-semibold uppercase tracking-[0.12em] text-[#7b7468]">
              <span>Analysis Progress</span>
              <span>{phase.progress}%</span>
            </div>
            <div className="mt-3 h-3 overflow-hidden bg-[#ebe6db]">
              <div
                className="h-full bg-[#146c60] transition-all duration-700 ease-out"
                style={{ width: `${phase.progress}%` }}
              />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              <MessageSquare className="h-5 w-5 text-[#d97706]" aria-hidden="true" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#c2410c]">
                  Review Focus
                </p>
                <p className="mt-2 text-sm leading-6 text-[#3f3b35]">{phase.focus}</p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
