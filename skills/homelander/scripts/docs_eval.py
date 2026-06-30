#!/usr/bin/env python3
"""Homelander docs comparison evaluator.

Runs two complementary comparisons:

1. Map existing Markdown/MDX docs to Homelander packs and obligations.
2. Run a blind codebase-to-Blume-docs plan into an eval output folder, then
   compare the generated portfolio against the existing docs corpus.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import docs_harness as harness

DOC_PACK_TERMS: dict[str, list[str]] = {
    "site-shell": [
        "getting started",
        "home",
        "index",
        "introduction",
        "overview",
        "quickstart",
        "start",
    ],
    "platform-app": [
        "account",
        "admin",
        "auth",
        "billing",
        "dashboard",
        "invite",
        "organization",
        "project",
        "role",
        "team",
        "user",
        "workspace",
    ],
    "http-api": [
        "api",
        "authentication",
        "endpoint",
        "error",
        "http",
        "pagination",
        "rate limit",
        "request",
        "response",
        "schema",
        "web api",
    ],
    "model-provider": [
        "completion",
        "embedding",
        "eval",
        "inference",
        "model",
        "multimodal",
        "parameter",
        "prompt",
        "safety",
        "streaming",
        "token",
        "tool calling",
    ],
    "sdk-library": [
        "client",
        "export",
        "import",
        "install",
        "library",
        "package",
        "sdk",
        "typescript",
        "types",
    ],
    "cli-tool": [
        "cli",
        "command",
        "config file",
        "flag",
        "option",
        "terminal",
    ],
    "framework-tool": [
        "adapter",
        "build",
        "configuration",
        "framework",
        "plugin",
        "runtime",
        "settings",
    ],
    "integrations": [
        "app",
        "github",
        "integration",
        "oauth",
        "provider",
        "slack",
        "stripe",
        "sync",
        "webhook",
    ],
    "migration": [
        "breaking",
        "changelog",
        "migration",
        "release",
        "upgrade",
        "version",
    ],
}

GENERIC_DOC_WORDS = {
    "a",
    "an",
    "and",
    "api",
    "docs",
    "for",
    "guide",
    "guides",
    "index",
    "md",
    "mdx",
    "reference",
    "the",
    "to",
}


def run(args: list[str], cwd: Path, timeout: int = 60) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Command failed in {cwd}: {' '.join(args)}\n{result.stderr.strip()}"
        )
    return result.stdout.strip()


def slug_words(value: str) -> set[str]:
    return {
        item
        for item in re.split(r"[^a-z0-9]+", value.lower())
        if item and item not in GENERIC_DOC_WORDS
    }


def page_text_for(repo: Path, page: dict[str, Any]) -> str:
    text = harness.read_text(repo / page["path"]) or ""
    headings = " ".join(item["text"] for item in page.get("headings", []))
    return " ".join(
        [
            page.get("path", ""),
            page.get("path_under_root", ""),
            page.get("title") or "",
            page.get("description") or "",
            headings,
            text,
        ]
    ).lower()


def obligation_path_hits(page_path: str) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    page_slug = Path(page_path).with_suffix("").as_posix()
    for pack_id, pack in harness.PACKS.items():
        for obligation in pack["obligations"]:
            obligation_slug = Path(obligation["path"]).with_suffix("").as_posix()
            if page_slug == obligation_slug or page_slug.endswith(f"/{obligation_slug}"):
                hits.append(
                    {
                        "pack": pack_id,
                        "score": 5,
                        "reason": f"matches obligation `{obligation['path']}`",
                    }
                )
            elif slug_words(obligation["title"]) & slug_words(page_path):
                hits.append(
                    {
                        "pack": pack_id,
                        "score": 1,
                        "reason": f"resembles obligation `{obligation['path']}`",
                    }
                )
    return hits


def classify_docs_page(repo: Path, page: dict[str, Any]) -> list[dict[str, Any]]:
    haystack = page_text_for(repo, page)
    scores: dict[str, int] = {}
    reasons: dict[str, list[str]] = {}

    for hit in obligation_path_hits(page["path_under_root"]):
        pack = hit["pack"]
        scores[pack] = scores.get(pack, 0) + hit["score"]
        reasons.setdefault(pack, []).append(hit["reason"])

    path_haystack = f"{page['path_under_root']} {page.get('title') or ''}".lower()
    for pack_id, terms in DOC_PACK_TERMS.items():
        for term in terms:
            if term in path_haystack:
                scores[pack_id] = scores.get(pack_id, 0) + 3
                reasons.setdefault(pack_id, []).append(f"path/title term `{term}`")
            elif term in haystack:
                scores[pack_id] = scores.get(pack_id, 0) + 1
                reasons.setdefault(pack_id, []).append(f"body term `{term}`")

    hits = [
        {
            "pack": pack,
            "score": score,
            "reasons": reasons.get(pack, [])[:4],
        }
        for pack, score in scores.items()
        if score > 0
    ]
    return sorted(hits, key=lambda item: item["score"], reverse=True)[:4]


def analyze_official_docs(repo: Path, docs_roots: list[Path]) -> dict[str, Any]:
    inventory = harness.scan_docs(repo, docs_roots)
    page_mappings: list[dict[str, Any]] = []
    pack_scores: dict[str, int] = {pack_id: 0 for pack_id in harness.PACKS}
    pack_pages: dict[str, list[dict[str, Any]]] = {pack_id: [] for pack_id in harness.PACKS}

    for page in inventory["pages"]:
        hits = classify_docs_page(repo, page)
        top_hit = hits[0] if hits else None
        page_mappings.append(
            {
                "path": page["path"],
                "path_under_root": page["path_under_root"],
                "title": page.get("title"),
                "top_pack": top_hit["pack"] if top_hit else None,
                "hits": hits,
            }
        )
        if top_hit:
            pack_scores[top_hit["pack"]] += top_hit["score"]
            pack_pages[top_hit["pack"]].append(page_mappings[-1])

    implied_packs = []
    for pack_id, score in pack_scores.items():
        if not pack_pages[pack_id]:
            continue
        confidence = min(1.0, score / 16)
        implied_packs.append(
            {
                "pack": pack_id,
                "label": harness.PACKS[pack_id]["label"],
                "score": score,
                "confidence": round(confidence, 2),
                "pages": pack_pages[pack_id][:20],
            }
        )

    return {
        "inventory": harness.strip_large_fields({"docs_inventory": inventory})[
            "docs_inventory"
        ],
        "page_mappings": page_mappings,
        "implied_packs": sorted(
            implied_packs,
            key=lambda item: list(harness.PACKS).index(item["pack"]),
        ),
    }


def empty_docs_inventory() -> dict[str, Any]:
    return {
        "roots": [],
        "pages": [],
        "frontmatter_issues": [],
        "local_link_issues": [],
        "placeholder_issues": [],
        "navigation_files": [],
        "docs_text": "",
    }


def scan_docs_for_eval(docs_root: Path) -> dict[str, Any]:
    if not docs_root.exists():
        return empty_docs_inventory()

    pages: list[dict[str, Any]] = []
    frontmatter_issues: list[dict[str, str]] = []
    local_link_issues: list[dict[str, str]] = []
    placeholder_issues: list[dict[str, Any]] = []
    navigation_files: list[str] = []
    docs_text_chunks: list[str] = []

    for path in harness.iter_files(docs_root, harness.DOC_EXTS):
        text = harness.read_text(path)
        if text is None:
            continue
        rel = str(path.relative_to(docs_root))
        docs_text_chunks.append(text.lower())
        frontmatter = harness.parse_frontmatter(text)
        links = [
            match.group(1) or match.group(2)
            for match in harness.LINK_PATTERN.finditer(text)
        ]
        fences = [match.group(1) or "" for match in harness.FENCE_PATTERN.finditer(text)]
        headings = [
            {"level": len(match.group(1)), "text": match.group(2)}
            for match in harness.HEADING_PATTERN.finditer(text)
        ]
        pages.append(
            {
                "path": rel,
                "path_under_root": rel,
                "docs_root": str(docs_root),
                "title": frontmatter.get("title"),
                "description": frontmatter.get("description"),
                "headings": headings[:20],
                "link_count": len(links),
                "code_fence_count": len(fences),
                "code_fence_languages": sorted({lang for lang in fences if lang}),
            }
        )
        if not frontmatter.get("title"):
            frontmatter_issues.append({"path": rel, "issue": "missing frontmatter title"})
        if not frontmatter.get("description"):
            frontmatter_issues.append({"path": rel, "issue": "missing frontmatter description"})
        for match in harness.PLACEHOLDER_PATTERN.finditer(text):
            line = text[: match.start()].count("\n") + 1
            placeholder_issues.append(
                {
                    "path": rel,
                    "line": line,
                    "snippet": text[match.start() : match.end()][:120],
                }
            )
        for link in links:
            if re.match(r"^(https?:|mailto:|tel:|#)", link):
                continue
            if not any(candidate.exists() for candidate in harness.link_candidates(docs_root, path, link)):
                local_link_issues.append({"path": rel, "target": link})

    for path in harness.iter_files(docs_root):
        if path.name == "meta.ts" or path.name.startswith("blume.config."):
            navigation_files.append(str(path.relative_to(docs_root)))

    return {
        "roots": [str(docs_root)],
        "pages": pages[: harness.MAX_ITEMS],
        "frontmatter_issues": frontmatter_issues[: harness.MAX_ITEMS],
        "local_link_issues": local_link_issues[: harness.MAX_ITEMS],
        "placeholder_issues": placeholder_issues[: harness.MAX_ITEMS],
        "navigation_files": sorted(set(navigation_files))[: harness.MAX_ITEMS],
        "docs_text": "\n".join(docs_text_chunks),
    }


def build_blind_generation_report(
    args: argparse.Namespace,
    repo: Path,
    official_docs_roots: list[Path],
    generated_docs_root: Path,
) -> dict[str, Any]:
    initial_docs = empty_docs_inventory()
    surfaces = harness.scan_public_surfaces(repo, official_docs_roots)
    classification = harness.classify_packs(
        surfaces,
        initial_docs,
        args.packs,
        harness.parse_pack_list(args.include_packs),
        harness.parse_pack_list(args.exclude_packs),
    )
    plan = harness.build_docs_portfolio_plan(
        generated_docs_root,
        classification,
        initial_docs,
    )

    stub_writes: list[dict[str, str]] = []
    if args.write_generated_stubs:
        stub_writes = harness.write_stubs(plan)

    generated_docs = scan_docs_for_eval(generated_docs_root)
    plan = harness.build_docs_portfolio_plan(
        generated_docs_root,
        classification,
        generated_docs,
    )
    gaps = harness.docs_gap_candidates(initial_docs, surfaces)
    review_findings = harness.build_review_findings(
        "audit",
        generated_docs,
        surfaces,
        gaps,
        plan,
    )

    return {
        "generated_docs_root": str(generated_docs_root),
        "pack_classification": classification,
        "surface_to_pack_map": classification["surface_to_pack_map"],
        "public_surfaces": surfaces,
        "docs_portfolio_plan": plan,
        "generated_docs_inventory": harness.strip_large_fields(
            {"docs_inventory": generated_docs}
        )["docs_inventory"],
        "docs_gap_candidates": gaps,
        "review_findings": review_findings,
        "stub_writes": stub_writes,
    }


def best_page_match(
    plan_page: dict[str, Any],
    official_pages: list[dict[str, Any]],
) -> dict[str, Any] | None:
    plan_path = Path(plan_page["path"]).with_suffix("").as_posix()
    plan_words = slug_words(plan_page["path"]) | slug_words(plan_page["title"])
    best: dict[str, Any] | None = None

    for page in official_pages:
        official_path = Path(page["path_under_root"]).with_suffix("").as_posix()
        official_words = slug_words(page["path_under_root"]) | slug_words(
            page.get("title") or ""
        )
        exact = official_path == plan_path or (
            plan_path != "index" and official_path.endswith(f"/{plan_path}")
        )
        if exact:
            score = 100
            reason = "exact path"
        else:
            if page.get("top_pack") != plan_page["pack"]:
                continue
            overlap = plan_words & official_words
            score = len(overlap)
            reason = f"word overlap: {', '.join(sorted(overlap))}" if overlap else ""
        if score < 2:
            continue
        candidate = {
            "path": page["path"],
            "path_under_root": page["path_under_root"],
            "title": page.get("title"),
            "score": score,
            "reason": reason,
        }
        if best is None or candidate["score"] > best["score"]:
            best = candidate

    return best


def compare_generated_to_official(
    official: dict[str, Any],
    generated: dict[str, Any],
) -> dict[str, Any]:
    official_pack_ids = {item["pack"] for item in official["implied_packs"]}
    generated_pack_ids = {
        item["pack"]
        for item in generated["pack_classification"]["selected_packs"]
    }
    official_pages = official["page_mappings"]
    generated_plan = generated["docs_portfolio_plan"]["planned_pages"]

    page_matches = []
    matched_official_paths: set[str] = set()
    for plan_page in generated_plan:
        match = best_page_match(plan_page, official_pages)
        if match:
            matched_official_paths.add(match["path"])
        page_matches.append(
            {
                "generated_path": plan_page["path"],
                "generated_pack": plan_page["pack"],
                "required": plan_page["required"],
                "official_match": match,
                "status": "matched" if match else "missing-official-analogue",
            }
        )

    template_gap_candidates = []
    for page in official_pages:
        if page["path"] in matched_official_paths:
            continue
        top_pack = page.get("top_pack")
        if not top_pack:
            continue
        if top_pack in generated_pack_ids or top_pack in official_pack_ids:
            template_gap_candidates.append(
                {
                    "path": page["path"],
                    "path_under_root": page["path_under_root"],
                    "title": page.get("title"),
                    "top_pack": top_pack,
                    "reason": "official docs page has no generated obligation analogue",
                }
            )

    return {
        "official_implied_packs": sorted(official_pack_ids, key=list(harness.PACKS).index),
        "generated_selected_packs": sorted(
            generated_pack_ids, key=list(harness.PACKS).index
        ),
        "packs_in_official_not_generated": sorted(
            official_pack_ids - generated_pack_ids, key=list(harness.PACKS).index
        ),
        "packs_generated_not_in_official": sorted(
            generated_pack_ids - official_pack_ids, key=list(harness.PACKS).index
        ),
        "page_matches": page_matches,
        "required_generated_pages_without_official_match": [
            item
            for item in page_matches
            if item["required"] and not item["official_match"]
        ],
        "template_gap_candidates": template_gap_candidates[:80],
    }


def markdown_list(items: list[str], empty: str = "None.") -> str:
    if not items:
        return f"- {empty}"
    return "\n".join(f"- {item}" for item in items)


def markdown_report(report: dict[str, Any]) -> str:
    official = report["official_docs_analysis"]
    generated = report["blind_generation"]
    comparison = report["comparison"]

    lines = [
        "# Homelander Docs Evaluation",
        "",
        f"- Target: `{report['target']}`",
        f"- Generated: `{report['generated_at']}`",
        f"- Repo: `{report['repo']}`",
        f"- Output root: `{report['output_root']}`",
        "",
        "## Summary",
        "",
        f"- Official docs pages: {len(official['inventory']['pages'])}",
        f"- Official-implied packs: {', '.join(comparison['official_implied_packs']) or 'none'}",
        f"- Blind generated packs: {', '.join(comparison['generated_selected_packs']) or 'none'}",
        f"- Generated planned pages: {len(generated['docs_portfolio_plan']['planned_pages'])}",
        f"- Generated stubs written: {len([item for item in generated['stub_writes'] if item['status'] == 'created'])}",
        f"- Required generated pages without official match: {len(comparison['required_generated_pages_without_official_match'])}",
        f"- Official pages without generated analogue: {len(comparison['template_gap_candidates'])}",
        f"- Review findings from generated docs: {len(generated['review_findings'])}",
        "",
        "## Pack Comparison",
        "",
        "### Official Docs Implied Packs",
        "",
    ]

    lines.append(
        markdown_list(
            [
                f"`{pack['pack']}` score={pack['score']} confidence={pack['confidence']} pages={len(pack['pages'])}"
                for pack in official["implied_packs"]
            ],
            "No pack signal found in official docs.",
        )
    )
    lines.extend(["", "### Blind Codebase Selected Packs", ""])
    lines.append(
        markdown_list(
            [
                f"`{pack['pack']}` score={pack['score']} confidence={pack['confidence']}"
                for pack in generated["pack_classification"]["selected_packs"]
            ],
            "No pack selected from code.",
        )
    )
    lines.extend(["", "### Pack Deltas", ""])
    lines.append(
        markdown_list(
            [f"`{pack}`" for pack in comparison["packs_in_official_not_generated"]],
            "No official-only packs.",
        )
    )
    lines.append("")
    lines.append(
        markdown_list(
            [f"`{pack}`" for pack in comparison["packs_generated_not_in_official"]],
            "No generated-only packs.",
        )
    )

    lines.extend(["", "## Generated Page Matches", ""])
    lines.append(
        markdown_list(
            [
                f"`{item['generated_path']}` ({item['generated_pack']}) -> "
                f"{'`' + item['official_match']['path_under_root'] + '`' if item['official_match'] else 'no official analogue'}"
                for item in comparison["page_matches"][:80]
            ],
            "No generated pages planned.",
        )
    )

    lines.extend(["", "## Required Generated Pages Without Official Match", ""])
    lines.append(
        markdown_list(
            [
                f"`{item['generated_path']}` ({item['generated_pack']})"
                for item in comparison["required_generated_pages_without_official_match"]
            ],
            "All required generated pages found an official analogue.",
        )
    )

    lines.extend(["", "## Official Pages Without Generated Analogue", ""])
    lines.append(
        markdown_list(
            [
                f"`{item['path_under_root']}` ({item['top_pack']}): {item.get('title') or 'untitled'}"
                for item in comparison["template_gap_candidates"][:60]
            ],
            "No template gap candidates found.",
        )
    )

    lines.extend(["", "## Generated Review Findings", ""])
    lines.append(
        markdown_list(
            [
                f"[{item['severity']}] {item['category']} in `{item['page']}` "
                f"({item['pack']}): {item['required_fix']}"
                for item in generated["review_findings"][:60]
            ],
            "No generated review findings.",
        )
    )

    lines.extend(
        [
            "",
            "## How To Use This Report",
            "",
            "- Treat official-only packs as classifier misses unless the official docs include non-code product intent.",
            "- Treat generated-only packs as classifier noise unless the official docs are incomplete.",
            "- Treat official pages without generated analogues as template-pack improvement candidates.",
            "- Treat generated required pages without official matches as either healthy new coverage or over-strict obligations.",
            "- Run a human docs review before changing pack obligations from one repository.",
        ]
    )
    return "\n".join(lines) + "\n"


def clone_target(args: argparse.Namespace, output_root: Path) -> tuple[Path, list[str]]:
    notes: list[str] = []
    if not args.clone_url:
        return Path(args.repo).resolve(), notes

    clone_dir = Path(args.clone_dir) if args.clone_dir else output_root / "_source"
    clone_dir = clone_dir.resolve()
    if clone_dir.exists():
        notes.append(f"Using existing clone at {clone_dir}")
    else:
        clone_dir.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--depth", "1", args.clone_url, str(clone_dir)], Path.cwd(), timeout=240)
        notes.append(f"Cloned {args.clone_url} into {clone_dir}")
    if args.ref:
        run(["git", "fetch", "--depth", "1", "origin", args.ref], clone_dir, timeout=120)
        run(["git", "checkout", "FETCH_HEAD"], clone_dir, timeout=60)
        notes.append(f"Checked out {args.ref}")
    return clone_dir, notes


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare Homelander output to existing docs.")
    parser.add_argument("--repo", default=".", help="Repository root to evaluate.")
    parser.add_argument("--name", help="Target name for the eval output folder.")
    parser.add_argument("--docs-root", help="Official docs root relative to repo root.")
    parser.add_argument("--clone-url", help="Optional git URL to clone before evaluation.")
    parser.add_argument("--clone-dir", help="Optional clone destination.")
    parser.add_argument("--ref", help="Optional git ref to fetch and evaluate.")
    parser.add_argument(
        "--output-root",
        default=".homelander-evals",
        help="Eval output root. Created in the current working directory unless absolute.",
    )
    parser.add_argument(
        "--generated-docs-dir",
        default="generated-docs",
        help="Generated Blume docs folder inside the target eval folder.",
    )
    parser.add_argument(
        "--packs",
        default="auto",
        help="Comma-separated pack list or `auto` for blind generation.",
    )
    parser.add_argument("--include-packs", help="Comma-separated packs to force include.")
    parser.add_argument("--exclude-packs", help="Comma-separated packs to exclude.")
    parser.add_argument(
        "--write-generated-stubs",
        action="store_true",
        help="Write missing generated MDX/meta.ts stubs into the eval folder.",
    )
    args = parser.parse_args()

    base_output = Path(args.output_root)
    if not base_output.is_absolute():
        base_output = (Path.cwd() / base_output).resolve()
    target_name = args.name or (
        Path(args.clone_url.rstrip("/")).stem if args.clone_url else Path(args.repo).resolve().name
    )
    output_root = base_output / target_name
    repo, clone_notes = clone_target(args, output_root)
    if not repo.exists():
        raise SystemExit(f"Repository path does not exist: {repo}")

    official_docs_roots = harness.detect_docs_roots(repo, args.docs_root)
    generated_docs_root = output_root / args.generated_docs_dir
    official = analyze_official_docs(repo, official_docs_roots)
    generated = build_blind_generation_report(
        args,
        repo,
        official_docs_roots,
        generated_docs_root,
    )
    comparison = compare_generated_to_official(official, generated)

    report = {
        "target": target_name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo": str(repo),
        "output_root": str(output_root),
        "clone_notes": clone_notes,
        "official_docs_roots": [str(path) for path in official_docs_roots],
        "official_docs_analysis": official,
        "blind_generation": generated,
        "comparison": comparison,
    }

    output_root.mkdir(parents=True, exist_ok=True)
    write_json(output_root / "official-docs-inventory.json", official)
    write_json(output_root / "generated-plan.json", generated["docs_portfolio_plan"])
    write_json(output_root / "comparison.json", report)
    (output_root / "comparison.md").write_text(markdown_report(report), encoding="utf-8")

    print(f"Wrote {output_root / 'comparison.md'}")
    print(f"Wrote {output_root / 'comparison.json'}")
    print(f"Wrote {output_root / 'official-docs-inventory.json'}")
    print(f"Wrote {output_root / 'generated-plan.json'}")
    if args.write_generated_stubs:
        created = len([item for item in generated["stub_writes"] if item["status"] == "created"])
        skipped = len([item for item in generated["stub_writes"] if item["status"] == "skipped"])
        print(f"Generated docs stubs: {created} created, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
