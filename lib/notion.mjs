// Shared Notion plumbing for this repo: the HTTP client (auth + retry),
// generic page/database operations, and the rich-text / block helpers used to
// build card content. Both the one-and-done import (../import) and the ongoing
// suite-run clone tool (../clone-test-suite-run) build on this module.
//
// This module has no top-level side effects (it never reads a config file or
// touches the network on load); callers pass in ids and bodies.
import fs from "node:fs";
import path from "node:path";

// The database title and its title-property name. Kept here so both tools
// agree on the schema's anchor points.
export const DB_TITLE = "Test Case Runs";
export const TITLE_PROPERTY = "Test Case Run";

// The native Status options, in board order. Cloning a suite run resets every
// card to the first one.
export const STATUS_OPTIONS = [
  { name: "Not started", color: "default" },
  { name: "In Progress", color: "blue" },
  { name: "Problems", color: "red" },
  { name: "Skipped", color: "yellow" },
  { name: "Done", color: "green" },
];

// Client retry/timeout knobs (env-overridable; IMPORT_* kept as a fallback for
// the historical import's documented variables).
const RETRY_COUNT = Number(
  process.env.NOTION_RETRY_COUNT || process.env.IMPORT_RETRY_COUNT || "6",
);
const RETRY_DELAY_MS = Number(
  process.env.NOTION_RETRY_DELAY_MS || process.env.IMPORT_RETRY_DELAY_MS || "3000",
);
const REQUEST_TIMEOUT_MS = Number(
  process.env.NOTION_REQUEST_TIMEOUT_MS ||
    process.env.IMPORT_REQUEST_TIMEOUT_MS ||
    "45000",
);

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function clean(value) {
  return (value ?? "").trim();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function saveJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// Notion ids are accepted dashed or undashed; we normalize to undashed for
// path segments.
export function normalizePageId(id) {
  return (id || "").replace(/-/g, "");
}

// ---------------------------------------------------------------------------
// Rich text + blocks
// ---------------------------------------------------------------------------

export function issueUrl(issueId) {
  return `https://issues.bloomlibrary.org/youtrack/issue/${issueId.toUpperCase()}`;
}

function dokimionUrl(tcNumber) {
  return `https://github.com/BloomBooks/bloom-test-cases/blob/main/test%20cases/${tcNumber}.md`;
}

export function chunkText(value, size = 1800) {
  const text = String(value ?? "");
  if (!text) {
    return [];
  }
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export function pushTextFragments(target, value, link) {
  for (const chunk of chunkText(value)) {
    const fragment = { type: "text", text: { content: chunk } };
    if (link) {
      fragment.text.link = { url: link };
    }
    target.push(fragment);
  }
}

export function richText(value) {
  const content = clean(value);
  if (!content) {
    return [];
  }
  const fragments = [];
  pushTextFragments(fragments, content);
  return fragments;
}

// Notion does not auto-linkify plain text from the API, so we set text.link
// ourselves. This finds both bare URLs and `BL-####` issue refs and makes each
// a clickable fragment; everything else stays plain text.
const LINK_PATTERN = /(https?:\/\/[^\s<>]+)|(BL-\d+)/gi;

// A matched URL greedily swallows trailing sentence punctuation and an
// unbalanced closing bracket (e.g. "(see https://x)"); peel those back off the
// link so they render as plain text.
function splitTrailingUrlPunctuation(url) {
  let link = url;
  let trailing = "";
  const punct = link.match(/[.,;:!?]+$/);
  if (punct) {
    trailing = punct[0];
    link = link.slice(0, -punct[0].length);
  }
  const balanced = (open, close) =>
    (link.match(new RegExp("\\" + open, "g")) || []).length >=
    (link.match(new RegExp("\\" + close, "g")) || []).length;
  while (
    (link.endsWith(")") && !balanced("(", ")")) ||
    (link.endsWith("]") && !balanced("[", "]"))
  ) {
    trailing = link.slice(-1) + trailing;
    link = link.slice(0, -1);
  }
  return { link, trailing };
}

export function linkifyRichText(value) {
  const content = String(value ?? "");
  if (!clean(content)) {
    return [];
  }
  const fragments = [];
  let lastIndex = 0;
  for (const match of content.matchAll(LINK_PATTERN)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      pushTextFragments(fragments, content.slice(lastIndex, matchIndex));
    }
    if (match[1]) {
      const { link, trailing } = splitTrailingUrlPunctuation(match[1]);
      pushTextFragments(fragments, link, link);
      if (trailing) {
        pushTextFragments(fragments, trailing);
      }
    } else {
      const issueId = match[2].toUpperCase();
      pushTextFragments(fragments, issueId, issueUrl(issueId));
    }
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < content.length) {
    pushTextFragments(fragments, content.slice(lastIndex));
  }
  return fragments;
}

// Render a Dokimion ID as a link to its bloom-test-cases markdown file. The
// link target is the leading TC number (files are named `<number>.md`); the
// full label (e.g. "TC105 (steps 1 to 4)") is kept as the link text. Values
// without a TC number (e.g. "-") render as plain text.
export function dokimionRichText(value) {
  const content = clean(value);
  if (!content) {
    return [];
  }
  const match = content.match(/TC\s*0*(\d+)/i);
  if (!match) {
    return richText(content);
  }
  const fragments = [];
  pushTextFragments(fragments, content, dokimionUrl(match[1]));
  return fragments;
}

export function titleText(value) {
  const content = clean(value) || "Untitled";
  return [{ text: { content: content.slice(0, 2000) } }];
}

// Notion select option names cannot contain commas.
export function selectName(value) {
  return clean(value).replace(/,/g, " ").slice(0, 100);
}

export function multiSelect(values) {
  return Array.from(
    new Set((values || []).map((value) => clean(value)).filter(Boolean)),
  ).map((value) => ({ name: selectName(value) }));
}

export function paragraphBlockFromRichText(richTextValue) {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: richTextValue },
  };
}

export function paragraphBlock(text) {
  return paragraphBlockFromRichText(linkifyRichText(text));
}

export function headingBlock(text) {
  return {
    object: "block",
    type: "heading_2",
    heading_2: { rich_text: richText(text.slice(0, 2000)) },
  };
}

export function toDoBlockFromRichText(richTextValue) {
  return {
    object: "block",
    type: "to_do",
    to_do: { rich_text: richTextValue, checked: false },
  };
}

export function toDoBlock(text) {
  return toDoBlockFromRichText(linkifyRichText(text));
}

// ---------------------------------------------------------------------------
// HTTP client + page/database operations
// ---------------------------------------------------------------------------

export async function execNotionJson(method, apiPath, body) {
  const token =
    process.env.BLOOM_TESTCASE_NOTION || process.env.NOTION_TOKEN || "";
  if (!token) {
    throw new Error("NOTION_TOKEN is not available.");
  }

  for (let attempt = 0; attempt <= RETRY_COUNT; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.notion.com/v1/${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const text = await response.text();
      const json = text ? JSON.parse(text) : {};
      if (response.ok) {
        return json;
      }

      if (
        (response.status === 429 || response.status === 503) &&
        attempt < RETRY_COUNT
      ) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : RETRY_DELAY_MS * (attempt + 1);
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(
        `Notion API Error (${response.status}): ${json.message || text}`,
      );
    } catch (error) {
      clearTimeout(timer);
      if (
        (error.name === "AbortError" ||
          /timed out/i.test(String(error.message || error))) &&
        attempt < RETRY_COUNT
      ) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }

  throw new Error("Notion API request exhausted retries.");
}

export async function getDatabase(databaseId) {
  return execNotionJson("GET", `databases/${normalizePageId(databaseId)}`);
}

export async function updateDatabase(databaseId, body) {
  return execNotionJson("PATCH", `databases/${normalizePageId(databaseId)}`, body);
}

export async function queryDatabase(databaseId, startCursor) {
  const body = { page_size: 100 };
  if (startCursor) {
    body.start_cursor = startCursor;
  }
  return execNotionJson(
    "POST",
    `databases/${normalizePageId(databaseId)}/query`,
    body,
  );
}

export async function listDatabasePages(databaseId) {
  const pages = [];
  let startCursor = "";
  while (true) {
    const response = await queryDatabase(databaseId, startCursor);
    pages.push(...(response.results || []));
    if (!response.has_more || !response.next_cursor) {
      return pages;
    }
    startCursor = response.next_cursor;
  }
}

export async function createPage(parentDatabaseId, properties) {
  return execNotionJson("POST", "pages", {
    parent: { database_id: normalizePageId(parentDatabaseId) },
    properties,
  });
}

export async function updatePage(pageId, properties) {
  return execNotionJson("PATCH", `pages/${normalizePageId(pageId)}`, {
    properties,
  });
}

export async function archivePage(pageId) {
  await execNotionJson("PATCH", `pages/${normalizePageId(pageId)}`, {
    in_trash: true,
  });
}

export async function listChildren(pageId) {
  return execNotionJson(
    "GET",
    `blocks/${normalizePageId(pageId)}/children?page_size=100`,
  );
}

export async function appendChildren(pageId, children) {
  if (!children.length) {
    return;
  }
  await execNotionJson("PATCH", `blocks/${normalizePageId(pageId)}/children`, {
    children,
  });
}

export async function deleteChildren(pageId) {
  const existing = await listChildren(pageId);
  for (const block of existing.results || []) {
    await execNotionJson("DELETE", `blocks/${normalizePageId(block.id)}`);
  }
}

// Write the page body. With `replace`, existing children are cleared first;
// otherwise the body is only written when the page currently has none (so a
// resumed run does not duplicate content).
export async function writeBody(pageId, blocks, { replace = false } = {}) {
  if (!blocks.length) {
    return;
  }
  if (replace) {
    await deleteChildren(pageId);
    await appendChildren(pageId, blocks);
    return;
  }
  const existing = await listChildren(pageId);
  if ((existing.results || []).length > 0) {
    return;
  }
  await appendChildren(pageId, blocks);
}
