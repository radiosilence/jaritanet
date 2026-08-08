#!/usr/bin/env -S node --experimental-strip-types

/**
 * Adds a macro to templates/icons.html for any `icons::<name>` a template
 * calls that icons.html does not yet define, sourced from lucide-static by
 * kebab-casing the name.
 *
 * Existing macros are never overwritten — only warned about if their content
 * no longer matches the name-guessed lucide-static icon, since the guess is
 * not always right. `trash`'s macro is actually `trash-2.svg`'s paths under
 * the name `trash`, kept for the plainer icon it names; nothing records that
 * on purpose, so regenerating it from the name would have silently dropped
 * two paths from a shipped icon. A mismatch here means "look before
 * touching this one", not "overwrite it".
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(root, "templates");
const iconsPath = join(templatesDir, "icons.html");
const lucideIconsDir = join(root, "node_modules/lucide-static/icons");

const kebab = (name: string) => name.replaceAll("_", "-");

function lucideInner(name: string): string | undefined {
  let svg: string;
  try {
    svg = readFileSync(join(lucideIconsDir, `${kebab(name)}.svg`), "utf8");
  } catch {
    return undefined;
  }
  return svg
    .slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("")
    .replaceAll(" />", "/>");
}

const referenced = new Set<string>();
for (const file of readdirSync(templatesDir)) {
  if (!file.endsWith(".html")) continue;
  const text = readFileSync(join(templatesDir, file), "utf8");
  for (const m of text.matchAll(/icons::([a-z_]+)\(/g)) referenced.add(m[1]);
}

const icons = readFileSync(iconsPath, "utf8");
const macroRe =
  /\{% macro (\w+)\(class="[^"]*"\) %\}<svg[^>]*>([\s\S]*?)<\/svg>\{% endmacro %\}/g;

const defined = new Map<string, string>();
for (const m of icons.matchAll(macroRe)) defined.set(m[1], m[2]);

const stale: string[] = [];
for (const [name, currentInner] of defined) {
  const lucide = lucideInner(name);
  if (lucide !== undefined && lucide !== currentInner) stale.push(name);
}

const missing = [...referenced].filter((name) => !defined.has(name));
const additions = missing.map((name) => {
  const inner = lucideInner(name);
  if (inner === undefined) {
    throw new Error(
      `templates call icons::${name}(), but it has no macro and no lucide-static icon named "${kebab(name)}.svg" exists — add the macro by hand, or fix the name`,
    );
  }
  return `\n{% macro ${name}(class="") %}<svg class="icon {{ class }}" data-icon="${kebab(name)}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>{% endmacro %}\n`;
});

if (additions.length > 0) {
  writeFileSync(iconsPath, `${icons.trimEnd()}\n${additions.join("")}`);
  console.log(`added: ${missing.join(", ")}`);
} else {
  console.log("nothing missing");
}

if (stale.length > 0) {
  console.warn(
    `content differs from lucide-static's name-guessed source, not touched: ${stale.join(", ")} — check by hand before assuming this is just an upstream shape change`,
  );
}
