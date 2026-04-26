import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extract } from "tar";

export const DEFAULT_OPENROUTER_MODEL = "openrouter/free";

export type SectionId =
  | "maintainability"
  | "testing"
  | "security"
  | "architecture"
  | "documentation";

export type Metric = {
  label: string;
  value: string;
  detail?: string;
};

export type ReportSection = {
  id: SectionId;
  title: string;
  score: number;
  grade: string;
  summary: string;
  highlights: string[];
  risks: string[];
  metrics: Metric[];
  chart: number[];
};

export type LanguageSlice = {
  name: string;
  lines: number;
  percent: number;
  color: string;
};

export type BigNumber = {
  label: string;
  value: string;
  caption: string;
};

export type ChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export type RepoReport = {
  repo: {
    name: string;
    owner: string;
    url: string;
    analyzedAt: string;
  };
  overview: {
    score: number;
    grade: string;
    summary: string;
  };
  bigNumbers: BigNumber[];
  languageBreakdown: LanguageSlice[];
  sections: ReportSection[];
  findings: string[];
  modelNote: string;
};

type FileMetric = {
  path: string;
  ext: string;
  language: string;
  lines: number;
  codeLines: number;
  todoCount: number;
  branchCount: number;
  isTest: boolean;
  isDoc: boolean;
};

type RepoSnapshot = {
  owner: string;
  name: string;
  repoUrl: string;
  files: FileMetric[];
  rootFiles: Set<string>;
  directories: Set<string>;
  packageJson?: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
};

type OpenRouterMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
      content?: string;
    }>
  | null;

type OpenRouterPayload = {
  error?: {
    message?: string;
    code?: string | number;
  };
  choices?: Array<{
    finish_reason?: string;
    native_finish_reason?: string;
    error?: {
      message?: string;
      code?: string | number;
    };
    message?: {
      content?: OpenRouterMessageContent;
      reasoning?: string;
      refusal?: string;
    };
  }>;
  model?: string;
  provider?: string;
};

type SearchFile = {
  path: string;
  content: string;
  lines: string[];
  isDoc: boolean;
  isTest: boolean;
};

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "vendor",
  "target",
  ".venv",
  "__pycache__",
]);

const textExtensions = new Set([
  ".c",
  ".cc",
  ".clj",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".vue",
  ".yaml",
  ".yml",
]);

const extensionLanguages: Record<string, string> = {
  ".c": "C",
  ".cc": "C++",
  ".clj": "Clojure",
  ".cpp": "C++",
  ".cs": "C#",
  ".css": "CSS",
  ".go": "Go",
  ".graphql": "GraphQL",
  ".h": "C/C++",
  ".html": "HTML",
  ".java": "Java",
  ".js": "JavaScript",
  ".jsx": "React",
  ".kt": "Kotlin",
  ".md": "Markdown",
  ".mjs": "JavaScript",
  ".py": "Python",
  ".rb": "Ruby",
  ".rs": "Rust",
  ".scss": "SCSS",
  ".sh": "Shell",
  ".sql": "SQL",
  ".svelte": "Svelte",
  ".swift": "Swift",
  ".toml": "TOML",
  ".ts": "TypeScript",
  ".tsx": "React TS",
  ".vue": "Vue",
  ".yaml": "YAML",
  ".yml": "YAML",
};

const languageColors = [
  "#146c60",
  "#d97706",
  "#3b5bdb",
  "#c2410c",
  "#7c3aed",
  "#0f766e",
  "#be123c",
];

const searchStopWords = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "but",
  "can",
  "code",
  "does",
  "fix",
  "for",
  "from",
  "have",
  "how",
  "into",
  "need",
  "repo",
  "should",
  "that",
  "the",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

export async function analyzeRepository(
  repoInput: string,
  openRouterKey?: string,
  openRouterModel = DEFAULT_OPENROUTER_MODEL,
): Promise<RepoReport> {
  const parsed = parseGitHubUrl(repoInput);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "repo-quality-"));
  const repoDir = path.join(tempRoot, "repo");

  try {
    await downloadRepositoryArchive(parsed.owner, parsed.name, repoDir);

    const snapshot = await buildSnapshot(repoDir, parsed.owner, parsed.name, parsed.webUrl);
    const report = buildReport(snapshot);

    if (!openRouterKey) {
      return report;
    }

    return await enrichWithOpenRouter(report, openRouterKey, openRouterModel);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function buildRepositorySearchContext({
  repoUrl,
  query,
  section,
}: {
  repoUrl: string;
  query: string;
  section: ReportSection;
}) {
  const parsed = parseGitHubUrl(repoUrl);
  const repoDir = await ensureCachedRepository(parsed.owner, parsed.name);
  const files = await collectSearchFiles(repoDir);
  const terms = tokenizeSearch(`${query} ${section.title} ${section.summary}`);
  const ranked = files
    .map((file) => ({ file, score: scoreSearchFile(file, terms, section.id) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  if (!ranked.length) {
    return "No relevant repository snippets were found for this question.";
  }

  const snippets = ranked.map(({ file }) => buildSnippet(file, terms)).filter(Boolean);
  return snippets.join("\n\n---\n\n").slice(0, 14_000);
}

function parseGitHubUrl(input: string) {
  let url: URL;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid GitHub repository URL.");
  }

  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("Only public GitHub repository URLs are supported right now.");
  }

  const [owner, rawName] = url.pathname.split("/").filter(Boolean);
  if (!owner || !rawName) {
    throw new Error("The GitHub URL must include an owner and repo name.");
  }

  const name = rawName.replace(/\.git$/, "");

  return {
    owner,
    name,
    webUrl: `https://github.com/${owner}/${name}`,
  };
}

async function ensureCachedRepository(owner: string, name: string) {
  const cacheRoot = path.join(tmpdir(), "repo-quality-cache");
  const repoDir = path.join(cacheRoot, sanitizeCacheName(`${owner}-${name}`));
  const markerFile = path.join(repoDir, ".repo-quality-cache.json");

  await mkdir(cacheRoot, { recursive: true });

  const exists = await stat(markerFile)
    .then((result) => result.isFile())
    .catch(() => false);

  if (exists) {
    return repoDir;
  }

  await rm(repoDir, { recursive: true, force: true });
  await downloadRepositoryArchive(owner, name, repoDir);

  return repoDir;
}

async function downloadRepositoryArchive(owner: string, name: string, destination: string) {
  await mkdir(destination, { recursive: true });

  const archiveUrl = `https://codeload.github.com/${owner}/${name}/tar.gz/HEAD`;
  const response = await fetch(archiveUrl, {
    headers: {
      Accept: "application/x-gzip",
      "User-Agent": "repo-analyzer-red",
    },
  });

  if (!response.ok) {
    throw new Error(`Unable to download GitHub repository archive (${response.status}).`);
  }

  const archivePath = path.join(tmpdir(), `repo-quality-${sanitizeCacheName(`${owner}-${name}`)}-${Date.now()}.tgz`);
  const archive = Buffer.from(await response.arrayBuffer());
  await writeFile(archivePath, archive);

  try {
    await extract({
      file: archivePath,
      cwd: destination,
      strip: 1,
    });
    await writeFile(
      path.join(destination, ".repo-quality-cache.json"),
      JSON.stringify({ owner, name, cachedAt: new Date().toISOString() }),
    );
  } finally {
    await rm(archivePath, { force: true });
  }
}

async function collectSearchFiles(root: string) {
  const files: SearchFile[] = [];

  async function walk(current: string, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        await walk(fullPath, entryRelative);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!textExtensions.has(ext)) continue;

      const fileStat = await stat(fullPath);
      if (fileStat.size > 500_000) continue;

      const content = await readFile(fullPath, "utf8").catch(() => "");
      if (!content || content.includes("\u0000")) continue;

      files.push({
        path: entryRelative,
        content,
        lines: content.split(/\r?\n/),
        isDoc: ext === ".md" || /^docs?\//.test(entryRelative) || /readme/i.test(entryRelative),
        isTest: /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\./.test(
          entryRelative,
        ),
      });
    }
  }

  await walk(root);
  return files;
}

async function buildSnapshot(
  root: string,
  owner: string,
  name: string,
  repoUrl: string,
): Promise<RepoSnapshot> {
  const files: FileMetric[] = [];
  const rootFiles = new Set<string>();
  const directories = new Set<string>();
  let packageJson: RepoSnapshot["packageJson"];

  async function walk(current: string, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        directories.add(entryRelative);
        await walk(fullPath, entryRelative);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!relative) rootFiles.add(entry.name);

      const ext = path.extname(entry.name).toLowerCase();
      if (!textExtensions.has(ext)) continue;

      const fileStat = await stat(fullPath);
      if (fileStat.size > 1_500_000) continue;

      const content = await readFile(fullPath, "utf8").catch(() => "");
      if (!content || content.includes("\u0000")) continue;

      if (entryRelative === "package.json") {
        packageJson = JSON.parse(content) as RepoSnapshot["packageJson"];
      }

      files.push(measureFile(entryRelative, ext, content));
    }
  }

  await walk(root);

  return { owner, name, repoUrl, files, rootFiles, directories, packageJson };
}

function measureFile(filePath: string, ext: string, content: string): FileMetric {
  const lines = content.split(/\r?\n/);
  const codeLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("//") && !trimmed.startsWith("#");
  }).length;
  const todoCount = (content.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) ?? []).length;
  const branchCount = (
    content.match(
      /\b(if|else if|switch|case|catch|for|while|try|&&|\|\||\?|match|guard|when)\b/g,
    ) ?? []
  ).length;

  return {
    path: filePath,
    ext,
    language: extensionLanguages[ext] ?? ext.slice(1).toUpperCase(),
    lines: lines.length,
    codeLines,
    todoCount,
    branchCount,
    isTest: /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$|_test\./.test(
      filePath,
    ),
    isDoc: ext === ".md" || /^docs?\//.test(filePath) || /readme/i.test(filePath),
  };
}

function buildReport(snapshot: RepoSnapshot): RepoReport {
  const codeFiles = snapshot.files.filter((file) => file.codeLines > 0 && file.ext !== ".md");
  const totalLines = sum(snapshot.files.map((file) => file.lines));
  const codeLines = sum(codeFiles.map((file) => file.codeLines));
  const testFiles = codeFiles.filter((file) => file.isTest);
  const docFiles = snapshot.files.filter((file) => file.isDoc);
  const todoCount = sum(snapshot.files.map((file) => file.todoCount));
  const branchCount = sum(codeFiles.map((file) => file.branchCount));
  const largeFiles = codeFiles.filter((file) => file.lines >= 450);
  const avgFileLines = codeFiles.length ? totalLines / codeFiles.length : 0;
  const kloc = Math.max(codeLines / 1000, 0.1);
  const complexityDensity = branchCount / kloc;
  const testRatio = codeFiles.length ? testFiles.length / codeFiles.length : 0;
  const tsRatio = codeFiles.length
    ? codeFiles.filter((file) => [".ts", ".tsx"].includes(file.ext)).length / codeFiles.length
    : 0;
  const hasPackage = Boolean(snapshot.packageJson);
  const scripts = snapshot.packageJson?.scripts ?? {};
  const dependencyCount =
    Object.keys(snapshot.packageJson?.dependencies ?? {}).length +
    Object.keys(snapshot.packageJson?.devDependencies ?? {}).length;
  const hasTestScript = Boolean(scripts.test && !/no test/i.test(scripts.test));
  const hasLintScript = Boolean(scripts.lint);
  const hasBuildScript = Boolean(scripts.build);
  const hasCi = [...snapshot.directories].some((dir) => dir.startsWith(".github/workflows"));
  const hasLockfile = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].some(
    (file) => snapshot.rootFiles.has(file),
  );
  const hasEnvExample = [...snapshot.rootFiles].some((file) => /^\.env\.(example|sample)$/.test(file));
  const hasReadme = [...snapshot.rootFiles].some((file) => /^readme\.md$/i.test(file));
  const hasDocsDir = [...snapshot.directories].some((dir) => /^docs?(\/|$)/.test(dir));
  const secretHits = detectSecretHints(snapshot.files);

  const maintainabilityScore = clamp(
    86 -
      largeFiles.length * 5 -
      Math.max(0, avgFileLines - 180) * 0.12 -
      Math.max(0, complexityDensity - 55) * 0.35 -
      todoCount / kloc +
      (hasLintScript ? 6 : 0) +
      tsRatio * 8,
  );

  const testingScore = clamp(
    26 + Math.min(testRatio * 260, 44) + (hasTestScript ? 18 : 0) + (hasCi ? 8 : 0) + (hasBuildScript ? 4 : 0),
  );

  const securityScore = clamp(
    70 +
      (hasLockfile ? 10 : -12) +
      (hasEnvExample ? 5 : 0) -
      secretHits.length * 12 -
      Math.max(0, dependencyCount - 60) * 0.25,
  );

  const architectureScore = clamp(
    58 +
      directoryScore(snapshot.directories) +
      (hasPackage ? 6 : 0) +
      (hasBuildScript ? 5 : 0) +
      tsRatio * 12 -
      largeFiles.length * 3 -
      Math.max(0, avgFileLines - 220) * 0.08,
  );

  const documentationScore = clamp(
    28 +
      (hasReadme ? 30 : 0) +
      (hasDocsDir ? 18 : 0) +
      Math.min(docFiles.length * 4, 16) +
      (hasEnvExample ? 4 : 0) +
      (snapshot.rootFiles.has("CONTRIBUTING.md") ? 4 : 0),
  );

  const sections: ReportSection[] = [
    section("maintainability", "Maintainability", maintainabilityScore, [
      `${largeFiles.length} large files found`,
      `${formatNumber(Math.round(complexityDensity))} branch points per KLOC`,
      `${formatPercent(tsRatio)} typed source files`,
    ], [
      hasLintScript ? "Lint script is present" : "No lint script detected",
      avgFileLines < 180 ? "Average file size is controlled" : "Average file size is trending high",
    ], [
      largeFiles.length ? "Split the largest files before adding major features." : "Keep file boundaries tight as the repo grows.",
      todoCount ? "Resolve or triage TODO/FIXME markers." : "Watch for deferred work markers during review.",
    ], [
      { label: "Avg file", value: `${Math.round(avgFileLines)} lines` },
      { label: "Large files", value: String(largeFiles.length), detail: "450+ lines" },
      { label: "TODOs", value: String(todoCount) },
    ], [maintainabilityScore - 10, maintainabilityScore - 4, maintainabilityScore, maintainabilityScore + 3]),
    section("testing", "Testing", testingScore, [
      `${testFiles.length} test files detected`,
      hasTestScript ? "Test script found" : "No package test script found",
      hasCi ? "CI workflow detected" : "CI workflow not detected",
    ], [
      testRatio >= 0.12 ? "Test file coverage looks healthy" : "Test footprint is light for the source size",
      hasBuildScript ? "Build script can catch integration failures" : "No build script detected",
    ], [
      "Add tests around the highest-change modules first.",
      hasCi ? "Make CI required for merges." : "Add a GitHub Actions workflow for test and build gates.",
    ], [
      { label: "Test ratio", value: formatPercent(testRatio) },
      { label: "Test files", value: String(testFiles.length) },
      { label: "CI", value: hasCi ? "Yes" : "No" },
    ], [testingScore - 12, testingScore - 6, testingScore - 3, testingScore]),
    section("security", "Security", securityScore, [
      hasLockfile ? "Dependency lockfile found" : "No dependency lockfile found",
      `${dependencyCount} direct dependencies`,
      `${secretHits.length} possible secret hints`,
    ], [
      secretHits.length ? "Potential secret-like strings need review" : "No obvious secret patterns found",
      hasEnvExample ? "Environment example is documented" : "Environment variables are not documented",
    ], [
      "Review auth, payment, and data-access code manually.",
      hasLockfile ? "Keep lockfile updates reviewed." : "Commit a lockfile for reproducible installs.",
    ], [
      { label: "Dependencies", value: String(dependencyCount) },
      { label: "Lockfile", value: hasLockfile ? "Yes" : "No" },
      { label: "Secret hints", value: String(secretHits.length) },
    ], [securityScore - 8, securityScore - 3, securityScore + 2, securityScore]),
    section("architecture", "Architecture", architectureScore, [
      `${snapshot.directories.size} directories mapped`,
      `${codeFiles.length} source files analyzed`,
      hasBuildScript ? "Build script present" : "Build script missing",
    ], [
      architectureScore >= 75 ? "Project structure is reasonably legible" : "Structure needs stronger boundaries",
      tsRatio >= 0.45 ? "TypeScript gives the design clearer contracts" : "Type coverage is limited",
    ], [
      "Name modules by product capability, not incidental framework folders.",
      "Keep shared helpers small and explicitly owned.",
    ], [
      { label: "Source files", value: String(codeFiles.length) },
      { label: "Directories", value: String(snapshot.directories.size) },
      { label: "Typed", value: formatPercent(tsRatio) },
    ], [architectureScore - 7, architectureScore - 2, architectureScore + 1, architectureScore]),
    section("documentation", "Documentation", documentationScore, [
      hasReadme ? "README found" : "README missing",
      `${docFiles.length} documentation files`,
      hasEnvExample ? "Env sample found" : "Env sample missing",
    ], [
      documentationScore >= 72 ? "Onboarding materials are visible" : "Onboarding docs are thin",
      hasDocsDir ? "Dedicated docs directory exists" : "No dedicated docs directory found",
    ], [
      "Document setup, test commands, and release/deploy paths.",
      "Add short architecture notes for the most important flows.",
    ], [
      { label: "Doc files", value: String(docFiles.length) },
      { label: "README", value: hasReadme ? "Yes" : "No" },
      { label: "Env docs", value: hasEnvExample ? "Yes" : "No" },
    ], [documentationScore - 9, documentationScore - 4, documentationScore + 1, documentationScore]),
  ];

  const score = clamp(
    maintainabilityScore * 0.28 +
      testingScore * 0.22 +
      securityScore * 0.2 +
      architectureScore * 0.18 +
      documentationScore * 0.12,
  );

  const languageBreakdown = buildLanguageBreakdown(codeFiles);

  return {
    repo: {
      name: snapshot.name,
      owner: snapshot.owner,
      url: snapshot.repoUrl,
      analyzedAt: new Date().toISOString(),
    },
    overview: {
      score,
      grade: gradeFor(score),
      summary:
        "Static analysis completed from repository structure, file metrics, scripts, docs, and lightweight risk heuristics.",
    },
    bigNumbers: [
      { label: "Overall Score", value: String(score), caption: gradeFor(score) },
      { label: "Source Files", value: formatNumber(codeFiles.length), caption: "text source files" },
      { label: "Code Lines", value: formatNumber(codeLines), caption: "non-empty code lines" },
      { label: "Test Ratio", value: formatPercent(testRatio), caption: "tests per source file" },
    ],
    languageBreakdown,
    sections,
    findings: [
      `${snapshot.owner}/${snapshot.name} has ${formatNumber(codeFiles.length)} source files and ${formatNumber(codeLines)} code lines.`,
      hasTestScript ? "A test script is available for local or CI verification." : "Testing command discovery should be improved.",
      largeFiles.length ? `${largeFiles.length} files are large enough to deserve review.` : "No very large source files were detected.",
      secretHits.length ? "Potential secret-like strings were found and should be manually reviewed." : "No obvious secret patterns were detected.",
    ],
    modelNote: "Deterministic static analyzer",
  };
}

async function enrichWithOpenRouter(
  report: RepoReport,
  openRouterKey: string,
  openRouterModel: string,
): Promise<RepoReport> {
  const model = normalizeOpenRouterModel(openRouterModel);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Repo Quality Report Card",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a senior code quality reviewer. Return compact JSON only. Do not use markdown.",
          },
          {
            role: "user",
            content: `Rewrite the summaries and findings for this static repo report. Keep scores and metrics unchanged. Return JSON with shape {"overviewSummary": string, "findings": string[], "sections": [{"id": string, "summary": string, "highlights": string[], "risks": string[]}]}. Use specific, pragmatic language.\n\n${JSON.stringify(report)}`,
          },
        ],
        temperature: 0.25,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      return { ...report, modelNote: `OpenRouter request failed (${response.status}); showing static analysis.` };
    }

    const payload = (await response.json()) as OpenRouterPayload;
    const content = extractOpenRouterContent(payload);
    if (!content) return report;

    const parsed = parseJsonObject(content) as {
      overviewSummary?: string;
      findings?: string[];
      sections?: Array<Partial<ReportSection> & { id?: SectionId }>;
    };

    const sectionMap = new Map(parsed.sections?.map((item) => [item.id, item]));
    return {
      ...report,
      overview: {
        ...report.overview,
        summary: parsed.overviewSummary || report.overview.summary,
      },
      findings: parsed.findings?.slice(0, 4) ?? report.findings,
      sections: report.sections.map((existing) => {
        const generated = sectionMap.get(existing.id);
        return {
          ...existing,
          summary: generated?.summary || existing.summary,
          highlights: generated?.highlights?.slice(0, 3) || existing.highlights,
          risks: generated?.risks?.slice(0, 2) || existing.risks,
        };
      }),
      modelNote: `Static analyzer plus OpenRouter review (${model})`,
    };
  } catch {
    return { ...report, modelNote: "OpenRouter response could not be used; showing static analysis." };
  }
}

export async function answerSectionQuestion({
  apiKey,
  codeContext,
  model = DEFAULT_OPENROUTER_MODEL,
  messages,
  question,
  section,
  report,
}: {
  apiKey: string;
  codeContext?: string;
  model?: string;
  messages?: ChatTurn[];
  question: string;
  section: ReportSection;
  report: Pick<RepoReport, "repo" | "overview" | "findings">;
}) {
  const normalizedModel = normalizeOpenRouterModel(model);
  const conversationMessages =
    messages?.length
      ? messages
      : [
          {
            role: "user" as const,
            content: question,
          },
        ];

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Repo Quality Report Card",
    },
    body: JSON.stringify({
      model: normalizedModel,
      messages: [
        {
          role: "system",
          content:
            "You answer follow-up questions about one section of a repository quality report. Use readable Markdown with short headings or bullets when helpful. Be specific, concise, and action-oriented.",
        },
        {
          role: "user",
          content: `Repository report context:\n${JSON.stringify({ report, section })}\n\nRelevant repository snippets:\n${codeContext || "No repository snippets were available for this question."}`,
        },
        ...conversationMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
      temperature: 0.25,
      max_tokens: 700,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as OpenRouterPayload;
  const content = extractOpenRouterContent(payload);

  if (!content) {
    console.warn("OpenRouter follow-up returned no assistant content", summarizeOpenRouterPayload(payload));
    throw new Error(buildOpenRouterEmptyMessage(payload));
  }

  return content;
}

function section(
  id: SectionId,
  title: string,
  score: number,
  chartLabels: string[],
  highlights: string[],
  risks: string[],
  metrics: Metric[],
  chart: number[],
): ReportSection {
  return {
    id,
    title,
    score,
    grade: gradeFor(score),
    summary: chartLabels.join(". ") + ".",
    highlights,
    risks,
    metrics,
    chart: chart.map(clamp),
  };
}

function buildLanguageBreakdown(files: FileMetric[]) {
  const totals = new Map<string, number>();
  for (const file of files) {
    totals.set(file.language, (totals.get(file.language) ?? 0) + file.codeLines);
  }

  const total = sum([...totals.values()]) || 1;
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([name, lines], index) => ({
      name,
      lines,
      percent: Math.round((lines / total) * 100),
      color: languageColors[index % languageColors.length],
    }));
}

function detectSecretHints(files: FileMetric[]) {
  const patterns = [/api[_-]?key/i, /secret/i, /private[_-]?key/i, /password/i, /token/i];
  return files
    .filter((file) => !file.path.endsWith(".md") && !file.path.includes("lock"))
    .filter((file) => patterns.some((pattern) => pattern.test(file.path)))
    .slice(0, 10);
}

function tokenizeSearch(input: string) {
  const terms = input
    .toLowerCase()
    .match(/[a-z0-9_.$/-]{3,}/g);

  return [...new Set((terms ?? []).filter((term) => !searchStopWords.has(term)))].slice(0, 24);
}

function scoreSearchFile(file: SearchFile, terms: string[], sectionId: SectionId) {
  if (!terms.length) return 0;

  const pathText = file.path.toLowerCase();
  const contentText = file.content.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (pathText.includes(term)) score += 20;

    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = contentText.match(new RegExp(escaped, "g"))?.length ?? 0;
    score += Math.min(matches, 25);
  }

  if (sectionId === "testing" && file.isTest) score += 16;
  if (sectionId === "documentation" && file.isDoc) score += 16;
  if (sectionId === "security" && /auth|token|secret|password|session|permission|policy|env/i.test(file.path)) {
    score += 16;
  }
  if (sectionId === "architecture" && /src|app|lib|service|component|route|controller/i.test(file.path)) {
    score += 8;
  }

  return score;
}

function buildSnippet(file: SearchFile, terms: string[]) {
  const bestLineIndex = findBestLineIndex(file.lines, terms);
  const start = Math.max(0, bestLineIndex - 5);
  const end = Math.min(file.lines.length, bestLineIndex + 8);
  const numberedLines = file.lines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n")
    .slice(0, 2_200);

  return `File: ${file.path}\nLines ${start + 1}-${end}\n\`\`\`\n${numberedLines}\n\`\`\``;
}

function findBestLineIndex(lines: string[], terms: string[]) {
  let bestIndex = 0;
  let bestScore = -1;

  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

function directoryScore(directories: Set<string>) {
  const names = [...directories];
  const signals = ["src", "app", "lib", "components", "services", "tests", "docs"].filter((name) =>
    names.some((dir) => dir === name || dir.startsWith(`${name}/`)),
  );
  return Math.min(signals.length * 4, 18);
}

function parseJsonObject(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found.");
  return JSON.parse(match[0]);
}

function extractOpenRouterContent(payload: OpenRouterPayload) {
  const message = payload.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => part.text ?? part.content ?? "")
      .join("\n")
      .trim();

    if (text) return text;
  }

  if (message?.refusal?.trim()) {
    return `The selected model refused the request:\n\n${message.refusal.trim()}`;
  }

  if (message?.reasoning?.trim()) {
    return `<think>\n${message.reasoning.trim()}\n</think>`;
  }

  return "";
}

function buildOpenRouterEmptyMessage(payload: OpenRouterPayload) {
  const choice = payload.choices?.[0];
  const providerMessage = payload.error?.message || choice?.error?.message;
  const finishReason = choice?.finish_reason || choice?.native_finish_reason;
  const details = [
    providerMessage ? `provider message: ${providerMessage}` : "",
    finishReason ? `finish reason: ${finishReason}` : "",
    payload.model ? `model: ${payload.model}` : "",
    payload.provider ? `provider: ${payload.provider}` : "",
  ].filter(Boolean);

  return details.length
    ? `OpenRouter returned no assistant text (${details.join("; ")}).`
    : "OpenRouter returned a successful response, but it did not include assistant text. Try another free model or retry the request.";
}

function summarizeOpenRouterPayload(payload: OpenRouterPayload) {
  return {
    model: payload.model,
    provider: payload.provider,
    error: payload.error,
    choices: payload.choices?.map((choice) => ({
      finishReason: choice.finish_reason,
      nativeFinishReason: choice.native_finish_reason,
      error: choice.error,
      contentType: Array.isArray(choice.message?.content) ? "array" : typeof choice.message?.content,
      hasReasoning: Boolean(choice.message?.reasoning),
      hasRefusal: Boolean(choice.message?.refusal),
    })),
  };
}

function normalizeOpenRouterModel(model: string) {
  const trimmed = model.trim();
  return trimmed.length ? trimmed : DEFAULT_OPENROUTER_MODEL;
}

function sanitizeCacheName(input: string) {
  return input.replace(/[^a-z0-9._-]/gi, "-").slice(0, 120);
}

function gradeFor(score: number) {
  if (score >= 92) return "A";
  if (score >= 84) return "B";
  if (score >= 74) return "C";
  if (score >= 64) return "D";
  return "F";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}
