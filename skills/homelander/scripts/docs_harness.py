#!/usr/bin/env python3
"""Homelander first-pass docs harness.

This script intentionally stays dependency-free. It produces evidence that an
agent can inspect before creating or maintaining docs.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

DOC_EXTS = {".md", ".mdx"}
CODE_EXTS = {
    ".astro",
    ".cjs",
    ".cs",
    ".go",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".mjs",
    ".php",
    ".py",
    ".rb",
    ".rs",
    ".svelte",
    ".swift",
    ".ts",
    ".tsx",
    ".vue",
}
IGNORE_DIRS = {
    ".blume",
    ".cache",
    ".git",
    ".next",
    ".nuxt",
    ".output",
    ".turbo",
    ".venv",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "target",
    "vendor",
    "venv",
}
MAX_FILE_BYTES = 768 * 1024
MAX_ITEMS = 120

EXPORT_PATTERN = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?"
    r"(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)
EXPORT_FROM_PATTERN = re.compile(
    r"^\s*export\s+(?:\*|\{[^}]+\})\s+from\s+['\"]([^'\"]+)['\"]",
    re.MULTILINE,
)
HTTP_METHOD_PATTERN = re.compile(
    r"\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b", re.IGNORECASE
)
ENV_PATTERN = re.compile(
    r"(?:process\.env\.|import\.meta\.env\.)([A-Z][A-Z0-9_]+)"
    r"|process\.env\[['\"]([A-Z][A-Z0-9_]+)['\"]\]"
    r"|Deno\.env\.get\(\s*['\"]([A-Z][A-Z0-9_]+)['\"]\s*\)"
)
FLAG_PATTERN = re.compile(
    r"\b(feature[-_ ]?flag|launchdarkly|growthbook|posthog|unleash|"
    r"experiment|rollout|preview|private beta|alpha|beta|canary|gate|"
    r"enabledFor|isEnabled|flagged|unreleased)\b",
    re.IGNORECASE,
)
SCHEMA_PATTERN = re.compile(
    r"\b(z\.object|zod|valibot|yup|jsonschema|json schema|"
    r"graphql|protobuf|openapi|asyncapi)\b",
    re.IGNORECASE,
)
FRONTMATTER_FIELD_PATTERN = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$", re.MULTILINE)
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)|href=[\"']([^\"']+)[\"']")
FENCE_PATTERN = re.compile(r"^```([A-Za-z0-9_-]+)?", re.MULTILINE)


def run_command(args: list[str], cwd: Path, timeout: int = 8) -> str | None:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def is_under(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def iter_files(root: Path, exts: set[str] | None = None) -> list[Path]:
    files: list[Path] = []
    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = [
            name
            for name in dirnames
            if name not in IGNORE_DIRS and not name.endswith(".egg-info")
        ]
        current_path = Path(current)
        for filename in filenames:
            path = current_path / filename
            if exts and path.suffix.lower() not in exts:
                continue
            files.append(path)
    return sorted(files)


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    parts = text.split("\n---", 1)
    if len(parts) < 2:
        return {}
    fields: dict[str, str] = {}
    for match in FRONTMATTER_FIELD_PATTERN.finditer(parts[0].removeprefix("---")):
        fields[match.group(1)] = match.group(2).strip().strip("\"'")
    return fields


def detect_docs_roots(repo: Path, explicit_docs_root: str | None) -> list[Path]:
    if explicit_docs_root:
        path = (repo / explicit_docs_root).resolve()
        return [path] if path.exists() else []

    candidates: list[Path] = []
    fixed = [
        "apps/docs/content/docs",
        "apps/docs/content",
        "apps/docs",
        "docs/content/docs",
        "docs/content",
        "docs",
        "documentation",
    ]
    for item in fixed:
        path = repo / item
        if path.exists():
            candidates.append(path.resolve())
    candidates.extend(path.resolve() for path in repo.glob("packages/*/docs") if path.exists())

    with_markdown = [
        path
        for path in candidates
        if any(child.suffix.lower() in DOC_EXTS for child in iter_files(path, DOC_EXTS))
    ]

    selected: list[Path] = []
    for candidate in sorted(with_markdown, key=lambda item: len(item.parts), reverse=True):
        if any(is_under(chosen, candidate) for chosen in selected):
            continue
        selected.append(candidate)
    return sorted(selected)


def detect_default_branch(repo: Path) -> str:
    remote_head = run_command(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "--short"], repo)
    if remote_head:
        return remote_head.replace("origin/", "")
    branches = run_command(["git", "branch", "--format=%(refname:short)"], repo) or ""
    for name in ("main", "master", "trunk"):
        if name in branches.splitlines():
            return name
    return "main"


def git_context(repo: Path, lookback_days: int) -> dict[str, Any]:
    since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).date().isoformat()
    default_branch = detect_default_branch(repo)
    log = run_command(
        [
            "git",
            "log",
            f"--since={since}",
            "--date=short",
            "--pretty=format:%H%x09%ad%x09%s",
            "--first-parent",
            "--max-count=80",
        ],
        repo,
    )
    commits = []
    for line in (log or "").splitlines():
        parts = line.split("\t", 2)
        if len(parts) == 3:
            commits.append({"sha": parts[0], "date": parts[1], "subject": parts[2]})

    gh_prs: list[dict[str, Any]] = []
    if shutil.which("gh"):
        gh_output = run_command(
            [
                "gh",
                "pr",
                "list",
                "--state",
                "merged",
                "--base",
                default_branch,
                "--limit",
                "80",
                "--search",
                f"merged:>={since}",
                "--json",
                "number,title,mergedAt,headRefName,url",
            ],
            repo,
            timeout=12,
        )
        if gh_output:
            try:
                gh_prs = json.loads(gh_output)
            except json.JSONDecodeError:
                gh_prs = []

    return {
        "branch": run_command(["git", "branch", "--show-current"], repo),
        "head": run_command(["git", "rev-parse", "--short", "HEAD"], repo),
        "default_branch": default_branch,
        "lookback_days": lookback_days,
        "since": since,
        "recent_commits": commits,
        "merged_prs": gh_prs,
    }


def route_from_file(repo: Path, path: Path) -> str | None:
    rel_parts = list(path.relative_to(repo).parts)
    markers = ["pages", "app", "routes"]
    marker_index = next((rel_parts.index(marker) for marker in markers if marker in rel_parts), None)
    if marker_index is None:
        return None
    route_parts = rel_parts[marker_index + 1 :]
    if not route_parts:
        return None
    route_parts[-1] = Path(route_parts[-1]).stem
    if route_parts[-1] in {"index", "page", "route"}:
        route_parts = route_parts[:-1]
    route_parts = [part for part in route_parts if part not in {"api"}]
    route = "/" + "/".join(route_parts)
    return route.replace("//", "/")


def package_manifests(repo: Path) -> list[dict[str, Any]]:
    manifests = []
    for path in iter_files(repo, {".json"}):
        if path.name != "package.json":
            continue
        text = read_text(path)
        if not text:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        public = {
            "path": str(path.relative_to(repo)),
            "name": data.get("name"),
            "bin": data.get("bin"),
            "exports": data.get("exports"),
            "main": data.get("main"),
            "module": data.get("module"),
            "types": data.get("types") or data.get("typings"),
        }
        if any(value for key, value in public.items() if key != "path"):
            manifests.append(public)
    return manifests[:MAX_ITEMS]


def scan_public_surfaces(repo: Path, docs_roots: list[Path]) -> dict[str, Any]:
    routes: list[dict[str, str]] = []
    api_handlers: list[dict[str, Any]] = []
    sdk_exports: list[dict[str, str]] = []
    cli_files: list[str] = []
    env_vars: dict[str, list[str]] = {}
    configs: list[str] = []
    schemas: list[str] = []
    components: list[dict[str, str]] = []
    feature_flags: list[dict[str, Any]] = []

    for path in iter_files(repo, CODE_EXTS):
        if any(is_under(path, docs_root) for docs_root in docs_roots):
            continue
        rel = str(path.relative_to(repo))
        text = read_text(path)
        if text is None:
            continue
        parts = set(path.parts)

        route = route_from_file(repo, path)
        if route:
            routes.append({"route": route, "file": rel})

        if "api" in parts or path.stem in {"route", "handler", "controller"}:
            methods = sorted({match.group(1).upper() for match in HTTP_METHOD_PATTERN.finditer(text)})
            if methods:
                api_handlers.append({"file": rel, "methods": methods})

        for match in EXPORT_PATTERN.finditer(text):
            sdk_exports.append({"name": match.group(1), "file": rel})
        for match in EXPORT_FROM_PATTERN.finditer(text):
            sdk_exports.append({"name": f"export from {match.group(1)}", "file": rel})

        if path.suffix.lower() in {".tsx", ".jsx", ".vue", ".svelte", ".astro"}:
            for match in EXPORT_PATTERN.finditer(text):
                name = match.group(1)
                if name[:1].isupper():
                    components.append({"name": name, "file": rel})

        if "bin" in parts or "cli" in parts or path.stem in {"cli", "main"}:
            cli_files.append(rel)

        for match in ENV_PATTERN.finditer(text):
            name = next(group for group in match.groups() if group)
            env_vars.setdefault(name, []).append(rel)

        if (
            ".config." in path.name
            or path.name in {"config.ts", "config.js", "settings.ts", "settings.js"}
            or "config" in parts
        ):
            configs.append(rel)

        if "schema" in path.name.lower() or SCHEMA_PATTERN.search(text):
            schemas.append(rel)

        for line_number, line in enumerate(text.splitlines(), start=1):
            if FLAG_PATTERN.search(line):
                feature_flags.append(
                    {
                        "file": rel,
                        "line": line_number,
                        "snippet": line.strip()[:180],
                    }
                )

    return {
        "package_manifests": package_manifests(repo),
        "routes": routes[:MAX_ITEMS],
        "api_handlers": api_handlers[:MAX_ITEMS],
        "sdk_exports": sdk_exports[:MAX_ITEMS],
        "cli_files": sorted(set(cli_files))[:MAX_ITEMS],
        "env_vars": [
            {"name": name, "files": sorted(set(files))[:12]}
            for name, files in sorted(env_vars.items())
        ][:MAX_ITEMS],
        "configs": sorted(set(configs))[:MAX_ITEMS],
        "schemas": sorted(set(schemas))[:MAX_ITEMS],
        "components": components[:MAX_ITEMS],
        "feature_flags": feature_flags[:MAX_ITEMS],
    }


def link_candidates(docs_root: Path, page: Path, target: str) -> list[Path]:
    clean = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not clean:
        return []
    if clean.startswith("/"):
        stripped = clean.lstrip("/")
        roots = [docs_root / stripped]
        if stripped.startswith("docs/"):
            roots.append(docs_root / stripped.removeprefix("docs/"))
    else:
        roots = [(page.parent / clean).resolve()]

    candidates: list[Path] = []
    for root in roots:
        candidates.append(root)
        if root.suffix == "":
            candidates.extend(
                [
                    root.with_suffix(".md"),
                    root.with_suffix(".mdx"),
                    root / "index.md",
                    root / "index.mdx",
                ]
            )
    return candidates


def scan_docs(repo: Path, docs_roots: list[Path]) -> dict[str, Any]:
    pages: list[dict[str, Any]] = []
    issues: list[dict[str, str]] = []
    local_link_issues: list[dict[str, str]] = []
    nav_files: list[str] = []
    docs_text_chunks: list[str] = []

    for docs_root in docs_roots:
        for path in iter_files(docs_root, DOC_EXTS):
            text = read_text(path)
            if text is None:
                continue
            docs_text_chunks.append(text.lower())
            frontmatter = parse_frontmatter(text)
            headings = [
                {"level": len(match.group(1)), "text": match.group(2)}
                for match in HEADING_PATTERN.finditer(text)
            ]
            links = [match.group(1) or match.group(2) for match in LINK_PATTERN.finditer(text)]
            fences = [match.group(1) or "" for match in FENCE_PATTERN.finditer(text)]
            rel = str(path.relative_to(repo))
            page = {
                "path": rel,
                "docs_root": str(docs_root.relative_to(repo)),
                "title": frontmatter.get("title"),
                "description": frontmatter.get("description"),
                "headings": headings[:20],
                "link_count": len(links),
                "code_fence_count": len(fences),
                "code_fence_languages": sorted({lang for lang in fences if lang}),
            }
            pages.append(page)
            if not frontmatter.get("title"):
                issues.append({"path": rel, "issue": "missing frontmatter title"})
            for link in links:
                if re.match(r"^(https?:|mailto:|tel:|#)", link):
                    continue
                if not any(candidate.exists() for candidate in link_candidates(docs_root, path, link)):
                    local_link_issues.append({"path": rel, "target": link})

    nav_names = {
        "_meta.js",
        "_meta.json",
        "_meta.ts",
        "docs.json",
        "meta.js",
        "meta.ts",
        "mint.json",
        "sidebars.js",
        "sidebars.ts",
    }
    for path in iter_files(repo):
        if path.name in nav_names or path.name.startswith("blume.config."):
            nav_files.append(str(path.relative_to(repo)))

    return {
        "roots": [str(path.relative_to(repo)) for path in docs_roots],
        "pages": pages[:MAX_ITEMS],
        "frontmatter_issues": issues[:MAX_ITEMS],
        "local_link_issues": local_link_issues[:MAX_ITEMS],
        "navigation_files": sorted(set(nav_files))[:MAX_ITEMS],
        "docs_text": "\n".join(docs_text_chunks),
    }


def docs_gap_candidates(docs_inventory: dict[str, Any], surfaces: dict[str, Any]) -> list[dict[str, str]]:
    docs_text = docs_inventory.get("docs_text", "")
    gaps: list[dict[str, str]] = []

    for env_var in surfaces["env_vars"]:
        name = env_var["name"]
        if name.lower() not in docs_text:
            gaps.append({"surface": "env var", "name": name, "reason": "not found in docs text"})

    for manifest in surfaces["package_manifests"]:
        bin_value = manifest.get("bin")
        names: list[str] = []
        if isinstance(bin_value, str):
            names.append(Path(bin_value).stem)
        elif isinstance(bin_value, dict):
            names.extend(str(key) for key in bin_value)
        for name in names:
            if name and name.lower() not in docs_text:
                gaps.append({"surface": "cli", "name": name, "reason": "package bin not found in docs"})

    for export in surfaces["sdk_exports"][:60]:
        name = export["name"]
        if name.startswith("export from "):
            continue
        if name.lower() not in docs_text and not name.startswith("_"):
            gaps.append({"surface": "sdk export", "name": name, "reason": "export not found in docs"})

    for route in surfaces["routes"][:60]:
        name = route["route"]
        if name != "/" and name.lower() not in docs_text:
            gaps.append({"surface": "route", "name": name, "reason": "route not found in docs"})

    return gaps[:MAX_ITEMS]


def strip_large_fields(report: dict[str, Any]) -> dict[str, Any]:
    copy = dict(report)
    docs = dict(copy["docs_inventory"])
    docs.pop("docs_text", None)
    copy["docs_inventory"] = docs
    return copy


def bullet_list(items: list[str], empty: str = "None found.") -> str:
    if not items:
        return f"- {empty}"
    return "\n".join(f"- {item}" for item in items)


def markdown_report(report: dict[str, Any]) -> str:
    git = report["git"]
    docs = report["docs_inventory"]
    surfaces = report["public_surfaces"]
    gaps = report["docs_gap_candidates"]
    validation = report["validation"]

    lines = [
        "# Homelander Evidence Report",
        "",
        f"- Mode: `{report['mode']}`",
        f"- Generated: `{report['generated_at']}`",
        f"- Repo: `{report['repo']}`",
        f"- Branch: `{git.get('branch') or 'unknown'}`",
        f"- Head: `{git.get('head') or 'unknown'}`",
        f"- Default branch: `{git.get('default_branch')}`",
        f"- Lookback: `{git.get('lookback_days')}` days since `{git.get('since')}`",
        "",
        "## Summary",
        "",
        f"- Docs roots: {len(docs['roots'])}",
        f"- Docs pages scanned: {len(docs['pages'])}",
        f"- Recent commits: {len(git['recent_commits'])}",
        f"- Merged PRs from `gh`: {len(git['merged_prs'])}",
        f"- Routes: {len(surfaces['routes'])}",
        f"- API handlers: {len(surfaces['api_handlers'])}",
        f"- SDK exports: {len(surfaces['sdk_exports'])}",
        f"- CLI files: {len(surfaces['cli_files'])}",
        f"- Env vars: {len(surfaces['env_vars'])}",
        f"- Config files: {len(surfaces['configs'])}",
        f"- Schema files/signals: {len(surfaces['schemas'])}",
        f"- Components: {len(surfaces['components'])}",
        f"- Feature flag/unreleased signals: {len(surfaces['feature_flags'])}",
        f"- Candidate docs gaps: {len(gaps)}",
        "",
        "## Docs Roots",
        "",
        bullet_list([f"`{root}`" for root in docs["roots"]], "No docs roots detected."),
        "",
        "## Recent Merged Work",
        "",
    ]

    if git["merged_prs"]:
        for pr in git["merged_prs"][:25]:
            lines.append(
                f"- #{pr.get('number')}: {pr.get('title')} ({pr.get('mergedAt')}) {pr.get('url')}"
            )
    elif git["recent_commits"]:
        for commit in git["recent_commits"][:25]:
            lines.append(f"- `{commit['sha'][:7]}` {commit['date']} {commit['subject']}")
    else:
        lines.append("- No recent commit or PR evidence found for the lookback window.")

    lines.extend(
        [
            "",
            "## Public Surfaces",
            "",
            "### Package manifests",
            "",
            bullet_list(
                [
                    f"`{item['path']}` name=`{item.get('name')}` bin=`{item.get('bin')}`"
                    for item in surfaces["package_manifests"][:20]
                ],
                "No package manifests with public fields found.",
            ),
            "",
            "### Routes and API handlers",
            "",
            bullet_list(
                [f"`{item['route']}` from `{item['file']}`" for item in surfaces["routes"][:30]],
                "No route files found.",
            ),
            "",
            bullet_list(
                [
                    f"`{item['file']}` methods={','.join(item['methods'])}"
                    for item in surfaces["api_handlers"][:30]
                ],
                "No API handlers found.",
            ),
            "",
            "### SDK exports, CLI, config, schemas, env vars",
            "",
            bullet_list(
                [f"`{item['name']}` from `{item['file']}`" for item in surfaces["sdk_exports"][:30]],
                "No SDK exports found.",
            ),
            "",
            bullet_list([f"`{item}`" for item in surfaces["cli_files"][:30]], "No CLI files found."),
            "",
            bullet_list([f"`{item}`" for item in surfaces["configs"][:30]], "No config files found."),
            "",
            bullet_list([f"`{item}`" for item in surfaces["schemas"][:30]], "No schema signals found."),
            "",
            bullet_list(
                [
                    f"`{item['name']}` in {', '.join(f'`{file}`' for file in item['files'][:5])}"
                    for item in surfaces["env_vars"][:30]
                ],
                "No env vars found.",
            ),
            "",
            "## Docs Inventory",
            "",
            bullet_list(
                [
                    f"`{page['path']}` title={page.get('title')!r} fences={page['code_fence_count']} links={page['link_count']}"
                    for page in docs["pages"][:40]
                ],
                "No Markdown/MDX pages found.",
            ),
            "",
            "## Candidate Docs Gaps",
            "",
            bullet_list(
                [
                    f"{gap['surface']}: `{gap['name']}` - {gap['reason']}"
                    for gap in gaps[:40]
                ],
                "No simple text-match gaps found.",
            ),
            "",
            "## Feature Flag and Unreleased Signals",
            "",
            bullet_list(
                [
                    f"`{item['file']}:{item['line']}` {item['snippet']}"
                    for item in surfaces["feature_flags"][:40]
                ],
                "No flag-like signals found.",
            ),
            "",
            "## Validation Findings",
            "",
            bullet_list(
                [f"`{item['path']}`: {item['issue']}" for item in docs["frontmatter_issues"][:40]],
                "No frontmatter issues found.",
            ),
            "",
            bullet_list(
                [
                    f"`{item['path']}` -> `{item['target']}`"
                    for item in docs["local_link_issues"][:40]
                ],
                "No simple local link issues found.",
            ),
            "",
            "## Navigation Files",
            "",
            bullet_list([f"`{item}`" for item in docs["navigation_files"][:40]], "No navigation files found."),
            "",
            "## Next Steps",
            "",
            "- Manually verify candidate gaps against source files before editing docs.",
            "- Skip flagged or unreleased behavior unless the docs target that audience.",
            "- Run the repo docs build and focused validation after edits.",
            "- Include this evidence summary in the final response or PR body.",
        ]
    )

    if validation:
        lines.extend(["", "## Scanner Notes", ""])
        lines.extend(f"- {item}" for item in validation)

    return "\n".join(lines) + "\n"


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    repo = Path(args.repo).resolve()
    docs_roots = detect_docs_roots(repo, args.docs_root)
    docs_inventory = scan_docs(repo, docs_roots)
    public_surfaces = scan_public_surfaces(repo, docs_roots)
    gaps = docs_gap_candidates(docs_inventory, public_surfaces)
    validation: list[str] = []
    if not docs_roots:
        validation.append("No docs root was detected. Init mode should scaffold docs before build validation.")
    if args.docs_root and not docs_roots:
        validation.append(f"Explicit docs root does not exist: {args.docs_root}")

    return {
        "mode": args.mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo": str(repo),
        "git": git_context(repo, args.lookback_days),
        "docs_inventory": docs_inventory,
        "public_surfaces": public_surfaces,
        "docs_gap_candidates": gaps,
        "validation": validation,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a Homelander docs evidence report.")
    parser.add_argument("--repo", default=".", help="Repository root to scan.")
    parser.add_argument("--docs-root", help="Docs root relative to repo root.")
    parser.add_argument(
        "--mode",
        choices=["init", "maintenance", "audit"],
        default="maintenance",
        help="Workflow mode for the evidence report.",
    )
    parser.add_argument("--lookback-days", type=int, default=7, help="Recent git/PR lookback window.")
    parser.add_argument("--output", default=".homelander/evidence.md", help="Markdown report path.")
    parser.add_argument("--json-output", default=".homelander/evidence.json", help="JSON report path.")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.exists():
        raise SystemExit(f"Repository path does not exist: {repo}")

    report = build_report(args)
    output = (repo / args.output).resolve()
    json_output = (repo / args.json_output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    json_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(markdown_report(report), encoding="utf-8")
    json_output.write_text(json.dumps(strip_large_fields(report), indent=2), encoding="utf-8")
    print(f"Wrote {output}")
    print(f"Wrote {json_output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
