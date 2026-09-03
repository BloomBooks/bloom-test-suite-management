// Shared command-line and path helpers for the progress report steps.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const dataDir = path.join(here, "data");
export const reportHtml = path.join(here, "report.html");
export const outDir = path.join(here, "out");

export function argFlag(name) {
  return process.argv.includes(name);
}

// Accepts `--name value` and `--name=value`.
export function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const pair = process.argv.find((a) => a.startsWith(name + "="));
  return pair ? pair.slice(name.length + 1) : null;
}
