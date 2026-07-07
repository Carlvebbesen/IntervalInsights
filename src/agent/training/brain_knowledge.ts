import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { config } from "../../config";

export interface BrainPage {
  slug: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  related: string[];
  summary: string;
  content: string;
}

export interface BrainSearchHit {
  slug: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  summary: string;
}

export interface BrainReadResult {
  found: boolean;
  page?: BrainPage & { links: string[] };
  message?: string;
  suggestions?: string[];
}

const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const MAX_SEARCH_RESULTS = 8;
const SUMMARY_MAX_LENGTH = 300;

function defaultBrainDir(): string {
  return config.BRAIN_DIR ?? join(process.cwd(), "knowledge", "brain");
}

function parseInlineArray(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseFrontmatter(raw: string): { meta: Record<string, string | string[]>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const block = raw.slice(raw.indexOf("\n") + 1, end);
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");
  const meta: Record<string, string | string[]> = {};
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (!key) continue;
    meta[key] =
      value.startsWith("[") && value.endsWith("]")
        ? parseInlineArray(value)
        : value.replace(/^["']|["']$/g, "");
  }
  return { meta, body };
}

function wikilinkTargets(values: string[]): string[] {
  return values.map((v) => {
    const match = /\[\[([^\]|]+)/.exec(v);
    return (match ? match[1] : v).trim();
  });
}

function extractSummary(body: string): string {
  const lines = body.split("\n");
  const block: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
    started = true;
    block.push(trimmed.replace(/^>\s?(\[![a-z]+\]\s*)?/i, ""));
  }
  const text = block
    .join(" ")
    .replace(WIKILINK, "$1")
    .replace(/\*\*|__|`/g, "")
    .trim();
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : text;
}

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function arr(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

function buildPage(slug: string, raw: string): BrainPage {
  const { meta, body } = parseFrontmatter(raw);
  return {
    slug,
    title: str(meta.title) || slug,
    type: str(meta.type),
    tags: arr(meta.tags),
    status: str(meta.status),
    related: wikilinkTargets(arr(meta.related)),
    summary: extractSummary(body),
    content: body,
  };
}

const caches = new Map<string, Promise<Map<string, BrainPage>>>();

async function readPages(dir: string): Promise<Map<string, BrainPage>> {
  const pages = new Map<string, BrainPage>();
  const entries = await readdir(dir, { recursive: true });
  for (const entry of entries) {
    const name = basename(entry);
    if (!name.endsWith(".md") || name === "log.md" || entry.includes("_templates")) continue;
    const slug = name.slice(0, -3);
    const raw = await Bun.file(join(dir, entry)).text();
    pages.set(slug, buildPage(slug, raw));
  }
  return pages;
}

export function loadBrain(dir = defaultBrainDir()): Promise<Map<string, BrainPage>> {
  let cached = caches.get(dir);
  if (!cached) {
    cached = readPages(dir).catch((err) => {
      caches.delete(dir);
      throw err;
    });
    caches.set(dir, cached);
  }
  return cached;
}

function scorePage(page: BrainPage, terms: string[]): number {
  const title = page.title.toLowerCase();
  const slug = page.slug.toLowerCase();
  const tags = page.tags.join(" ").toLowerCase();
  const summary = page.summary.toLowerCase();
  const content = page.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (slug.includes(term)) score += 3;
    if (tags.includes(term)) score += 3;
    if (summary.includes(term)) score += 2;
    if (content.includes(term)) score += 1;
  }
  return score;
}

function toHit(page: BrainPage): BrainSearchHit {
  return {
    slug: page.slug,
    title: page.title,
    type: page.type,
    tags: page.tags,
    status: page.status,
    summary: page.summary,
  };
}

export async function searchBrainPages(
  query: string,
  dir = defaultBrainDir(),
): Promise<{ results: BrainSearchHit[]; totalPages: number; hint?: string }> {
  const pages = await loadBrain(dir);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9åæø]+/)
    .filter((t) => t.length > 1);
  const scored = [...pages.values()]
    .map((page) => ({ page, score: scorePage(page, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SEARCH_RESULTS);
  const results = scored.map((s) => toHit(s.page));
  return {
    results,
    totalPages: pages.size,
    hint:
      results.length === 0
        ? "No pages matched. Try different keywords, or read the page with slug 'index' for the full catalog."
        : undefined,
  };
}

export async function readBrainPage(
  slug: string,
  dir = defaultBrainDir(),
): Promise<BrainReadResult> {
  const pages = await loadBrain(dir);
  const normalized = slug.trim().toLowerCase().replace(/\.md$/, "");
  const page = pages.get(normalized);
  if (!page) {
    const suggestions = (await searchBrainPages(normalized.replace(/-/g, " "), dir)).results.map(
      (r) => r.slug,
    );
    return {
      found: false,
      message: `No knowledge page with slug "${slug}".`,
      suggestions,
    };
  }
  const links = new Set<string>();
  for (const match of page.content.matchAll(WIKILINK)) {
    const target = match[1].trim();
    if (pages.has(target)) links.add(target);
  }
  for (const rel of page.related) {
    if (pages.has(rel)) links.add(rel);
  }
  return { found: true, page: { ...page, links: [...links] } };
}
