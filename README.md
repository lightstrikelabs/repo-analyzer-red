# Repo Quality Report Card

A Next.js and Tailwind web app that analyzes a public GitHub repository and renders a code-quality report card with scores, big numbers, charts, and section-specific OpenRouter follow-up questions.

## Run

```bash
npm run dev
```

Open http://localhost:3000.

## Notes

- The analyzer downloads public GitHub repo archives into a temporary directory.
- The OpenRouter key is submitted only to the local API routes for report enrichment and follow-up answers.
- If no OpenRouter key is provided, the app still generates a deterministic static report.
- The default OpenRouter model is `openrouter/free`; change it from the Advanced section.
- Repo URL, OpenRouter key, and model are persisted in browser localStorage.
- The latest report and per-repo chat threads are restored from localStorage on refresh.
- Section follow-up questions open a slideout chat with Markdown-rendered replies and multiple conversation threads.
- Follow-up answers search cached repository files and include matching code snippets in the model context.
