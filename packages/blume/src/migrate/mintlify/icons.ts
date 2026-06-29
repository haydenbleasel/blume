const JSX_ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  clipPath: "clip-path",
  clipRule: "clip-rule",
  fillOpacity: "fill-opacity",
  fillRule: "fill-rule",
  strokeDasharray: "stroke-dasharray",
  strokeDashoffset: "stroke-dashoffset",
  strokeLinecap: "stroke-linecap",
  strokeLinejoin: "stroke-linejoin",
  strokeMiterlimit: "stroke-miterlimit",
  strokeOpacity: "stroke-opacity",
  strokeWidth: "stroke-width",
};

const SVG_EXPRESSION = /^\s*\(?\s*<svg[\s\S]*<\/svg>\s*\)?\s*;?\s*$/u;

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const stripExpressionWrapper = (value: string): string => {
  let next = value.trim().replaceAll(/;$/gu, "").trim();
  if (next.startsWith("(") && next.endsWith(")")) {
    next = next.slice(1, -1).trim();
  }
  return next;
};

const jsxExpressionAttribute = (
  value: string,
  quoted: string | undefined,
  single: string | undefined,
  template: string | undefined,
  scalar: string | undefined
): string => {
  const literal = quoted ?? single ?? template ?? scalar;
  return literal === undefined ? value : `="${escapeAttribute(literal)}"`;
};

const normalizeJsxSvg = (value: string): string | null => {
  const stripped = stripExpressionWrapper(value);
  if (!SVG_EXPRESSION.test(stripped)) {
    return null;
  }

  let svg = stripped.replaceAll(
    /[=]\{\s*(?:"(?<quoted>[^"]*)"|'(?<single>[^']*)'|`(?<template>[^`]*)`|(?<scalar>-?\d+(?:\.\d+)?|true|false))\s*\}/gu,
    jsxExpressionAttribute
  );
  for (const [jsxName, htmlName] of Object.entries(JSX_ATTRIBUTE_ALIASES)) {
    svg = svg.replaceAll(new RegExp(`\\b${jsxName}=`, "gu"), `${htmlName}=`);
  }
  return svg;
};

const findExpressionEnd = (source: string, start: number): number => {
  let depth = 1;
  let quote: '"' | "'" | "`" | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const previous = source[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
};

const startsWithSvgExpression = (value: string): boolean => {
  const trimmed = value.trimStart();
  return trimmed.startsWith("<svg") || trimmed.startsWith("(<svg");
};

/**
 * Rewrite Mintlify inline-SVG icon JSX props (`icon={<svg .../>}`) to plain
 * string props so the migrated MDX compiles under Astro. Runs once at
 * migration time; non-SVG `icon={...}` expressions are left untouched.
 */
export const rewriteMintlifySvgIconProps = (source: string): string => {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("icon={", cursor);
    if (start === -1) {
      output += source.slice(cursor);
      break;
    }

    const expressionStart = start + "icon={".length;
    const end = findExpressionEnd(source, expressionStart);
    if (end === -1) {
      output += source.slice(cursor);
      break;
    }

    const expression = source.slice(expressionStart, end);
    const svg = startsWithSvgExpression(expression)
      ? normalizeJsxSvg(expression)
      : null;
    output += source.slice(cursor, start);
    output += svg
      ? `icon={${JSON.stringify(svg)}}`
      : source.slice(start, end + 1);
    cursor = end + 1;
  }
  return output;
};
