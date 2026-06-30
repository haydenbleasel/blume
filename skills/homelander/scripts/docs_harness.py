#!/usr/bin/env python3
"""Homelander docs harness.

Dependency-free scanner, portfolio planner, stub writer, and DeepSec-style
review pass for Blume docs source trees.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from collections import defaultdict
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
    ".homelander",
    ".homelander-evals",
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
MAX_ITEMS = 140
SKILL_ROOT = Path(__file__).resolve().parents[1]

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
    r"graphql|protobuf|openapi|asyncapi|prisma)\b",
    re.IGNORECASE,
)
FRONTMATTER_FIELD_PATTERN = re.compile(r"^([A-Za-z0-9_-]+):\s*(.*)$", re.MULTILINE)
HEADING_PATTERN = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)
LINK_PATTERN = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)|href=[\"']([^\"']+)[\"']")
FENCE_PATTERN = re.compile(r"^```([A-Za-z0-9_-]+)?", re.MULTILINE)
PLACEHOLDER_PATTERN = re.compile(
    r"\[(?:[A-Za-z0-9 _/-]+ from evidence|placeholder|TODO|TBD)[^\]]*\]"
    r"|HOMELANDER:"
    r"|\bTODO\b"
    r"|\bTBD\b",
    re.IGNORECASE,
)

PACK_ALIASES = {
    "api": "http-api",
    "app": "platform-app",
    "cli": "cli-tool",
    "config": "framework-tool",
    "docs": "site-shell",
    "framework": "framework-tool",
    "integrations": "integrations",
    "migration": "migration",
    "models": "model-provider",
    "sdk": "sdk-library",
    "site": "site-shell",
}


def page(path: str, title: str, description: str, required: bool) -> dict[str, Any]:
    return {"path": path, "title": title, "description": description, "required": required}


PACKS: dict[str, dict[str, Any]] = {
    "site-shell": {
        "label": "Site shell",
        "description": "Base docs structure, introduction, getting started path, and navigation.",
        "threshold": 1,
        "signals": ["readme", "package", "docs", "quickstart"],
        "obligations": [
            page("index.mdx", "Introduction", "What this product is and who it is for.", required=True),
            page("getting-started.mdx", "Getting Started", "First working path from install to outcome.", required=True),
        ],
    },
    "platform-app": {
        "label": "Platform app",
        "description": "Hosted app, dashboard, projects, users, billing, auth, admin workflows.",
        "threshold": 4,
        "signals": [
            "auth",
            "billing",
            "dashboard",
            "invite",
            "organization",
            "role",
            "team",
            "workspace",
        ],
        "obligations": [
            page("concepts/workspaces.mdx", "Workspaces", "Account, org, or project model.", required=False),
            page("concepts/users-and-roles.mdx", "Users and Roles", "Users, teams, roles, and permissions.", required=False),
            page("guides/billing.mdx", "Billing", "Billing and plan-management workflows.", required=False),
            page("guides/integrations.mdx", "Integrations", "Connected services and setup flows.", required=False),
            page("reference/env.mdx", "Environment Variables", "Runtime and deployment variables.", required=False),
        ],
    },
    "http-api": {
        "label": "HTTP API",
        "description": "Endpoints, auth, errors, pagination, rate limits, request and response schemas.",
        "threshold": 1,
        "signals": ["api", "endpoint", "http", "openapi", "route", "server"],
        "obligations": [
            page("reference/api.mdx", "API Reference", "Public endpoints and schemas.", required=True),
            page("reference/errors.mdx", "Errors", "Error responses and failure modes.", required=False),
            page("reference/rate-limits.mdx", "Rate Limits", "Limits, retries, and backoff.", required=False),
        ],
    },
    "model-provider": {
        "label": "Model provider",
        "description": "Models, inference, streaming, parameters, tokens, evals, and safety.",
        "threshold": 4,
        "signals": [
            "completion",
            "embedding",
            "eval",
            "inference",
            "model",
            "multimodal",
            "prompt",
            "rate_limit",
            "safety",
            "stream",
            "token",
            "tool_call",
        ],
        "obligations": [
            page("models/overview.mdx", "Models", "Model catalog and capabilities.", required=True),
            page("guides/text-generation.mdx", "Text Generation", "Generate text with the model API.", required=False),
            page("guides/streaming.mdx", "Streaming", "Stream incremental model output.", required=False),
            page("guides/structured-output.mdx", "Structured Output", "Generate schema-shaped output.", required=False),
            page("guides/tool-calling.mdx", "Tool Calling", "Let models call external tools.", required=False),
            page("concepts/tokens-and-context.mdx", "Tokens and Context", "Token budgets and context windows.", required=False),
            page("reference/parameters.mdx", "Parameters", "Generation parameters and defaults.", required=True),
        ],
    },
    "sdk-library": {
        "label": "SDK library",
        "description": "Installable package exports, types, examples, and public API.",
        "threshold": 1,
        "signals": ["export", "package", "sdk", "types"],
        "obligations": [
            page("guides/sdk-quickstart.mdx", "SDK Quickstart", "Install and call the SDK.", required=False),
            page("reference/sdk.mdx", "SDK Reference", "Public exports, types, and examples.", required=True),
        ],
    },
    "cli-tool": {
        "label": "CLI tool",
        "description": "Commands, flags, config, environment variables, and examples.",
        "threshold": 1,
        "signals": ["bin", "cli", "command", "flag"],
        "obligations": [
            page("reference/cli.mdx", "CLI Reference", "Commands, flags, and examples.", required=True),
            page("reference/config.mdx", "Configuration Reference", "Config files, defaults, and env vars.", required=False),
        ],
    },
    "framework-tool": {
        "label": "Framework tool",
        "description": "Config, plugins, adapters, build/runtime behavior, and extension points.",
        "threshold": 2,
        "signals": ["adapter", "build", "config", "framework", "plugin", "runtime", "schema"],
        "obligations": [
            page("concepts/runtime.mdx", "Runtime Model", "How the framework executes user projects.", required=False),
            page("guides/plugins.mdx", "Plugins and Adapters", "Extend or integrate with the framework.", required=False),
            page("reference/configuration.mdx", "Configuration Reference", "Options, defaults, and validation.", required=True),
        ],
    },
    "integrations": {
        "label": "Integrations",
        "description": "Providers, webhooks, OAuth apps, external setup, and sync behavior.",
        "threshold": 3,
        "signals": [
            "github",
            "integration",
            "notion",
            "oauth",
            "provider",
            "resend",
            "sanity",
            "slack",
            "stripe",
            "sync",
            "webhook",
        ],
        "obligations": [
            page("guides/integrations.mdx", "Integrations", "Connect external providers.", required=False),
            page("guides/oauth-apps.mdx", "OAuth Apps", "Configure OAuth-based integrations.", required=False),
            page("reference/webhooks.mdx", "Webhooks", "Webhook events and verification.", required=False),
        ],
    },
    "migration": {
        "label": "Migration",
        "description": "Version changes, breaking changes, migrations, and upgrade steps.",
        "threshold": 2,
        "signals": ["breaking", "changeset", "changelog", "migrate", "migration", "upgrade", "version"],
        "obligations": [
            page("migration/index.mdx", "Migration Guide", "Upgrade and migration path.", required=False),
        ],
    },
}


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


def is_docs_app_source(repo: Path, path: Path) -> bool:
    rel_parts = path.relative_to(repo).parts
    if len(rel_parts) >= 2 and rel_parts[0] == "docs":
        if (repo / "docs" / "blume.config.ts").exists():
            return rel_parts[1] in {"pages", ".blume"} or path.name == "blume.config.ts"
    if len(rel_parts) >= 3 and rel_parts[0] == "apps" and rel_parts[1] == "docs":
        if (repo / "apps" / "docs" / "blume.config.ts").exists():
            return rel_parts[2] in {"pages", ".blume"} or path.name == "blume.config.ts"
    return False


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


def slug_for(path: str) -> str:
    stem = Path(path).stem
    if stem == "index":
        return Path(path).parent.name or "index"
    return stem


def titleize(value: str) -> str:
    return value.replace("-", " ").replace("_", " ").title()


def normalize_pack(name: str) -> str:
    cleaned = name.strip().lower()
    return PACK_ALIASES.get(cleaned, cleaned)


def parse_pack_list(raw: str | None) -> list[str]:
    if not raw or raw == "auto":
        return []
    packs = []
    for item in raw.split(","):
        pack = normalize_pack(item)
        if pack:
            packs.append(pack)
    return packs


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


def choose_stub_docs_root(repo: Path, docs_roots: list[Path], explicit_docs_root: str | None) -> Path:
    if explicit_docs_root:
        return (repo / explicit_docs_root).resolve()
    if docs_roots:
        return docs_roots[0]
    return repo / "docs"


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
        rel_parts = path.relative_to(repo).parts
        if rel_parts in {("docs", "package.json"), ("apps", "docs", "package.json")}:
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


def keyword_hits(text: str, rel: str, line_limit: int = 3) -> list[dict[str, Any]]:
    hits: list[dict[str, Any]] = []
    lowered = text.lower()
    for pack_id, pack in PACKS.items():
        for keyword in pack["signals"]:
            if keyword.lower() not in lowered:
                continue
            for line_number, line in enumerate(text.splitlines(), start=1):
                if keyword.lower() in line.lower():
                    hits.append(
                        {
                            "pack": pack_id,
                            "keyword": keyword,
                            "file": rel,
                            "line": line_number,
                            "snippet": line.strip()[:180],
                        }
                    )
                    break
            if len([hit for hit in hits if hit["pack"] == pack_id]) >= line_limit:
                break
    return hits


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
    pack_keyword_signals: list[dict[str, Any]] = []
    migration_files: list[str] = []
    provider_files: list[str] = []

    for path in iter_files(repo, CODE_EXTS):
        if any(is_under(path, docs_root) for docs_root in docs_roots) or is_docs_app_source(repo, path):
            continue
        rel = str(path.relative_to(repo))
        text = read_text(path)
        if text is None:
            continue
        parts = set(path.parts)
        rel_lower = rel.lower()

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

        if any(term in rel_lower for term in ("migrate", "migration", "changelog", "changeset")):
            migration_files.append(rel)
        if any(term in rel_lower for term in ("provider", "integration", "webhook", "oauth")):
            provider_files.append(rel)

        pack_keyword_signals.extend(keyword_hits(text, rel))

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
        "pack_keyword_signals": pack_keyword_signals[:MAX_ITEMS],
        "migration_files": sorted(set(migration_files))[:MAX_ITEMS],
        "provider_files": sorted(set(provider_files))[:MAX_ITEMS],
    }


def link_candidates(docs_root: Path, page_path: Path, target: str) -> list[Path]:
    clean = target.split("#", 1)[0].split("?", 1)[0].strip()
    if not clean:
        return []
    if clean.startswith("/"):
        stripped = clean.lstrip("/")
        roots = [docs_root / stripped]
        if stripped.startswith("docs/"):
            roots.append(docs_root / stripped.removeprefix("docs/"))
    else:
        roots = [(page_path.parent / clean).resolve()]

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
    placeholder_issues: list[dict[str, Any]] = []
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
            root_rel = str(docs_root.relative_to(repo))
            page_record = {
                "path": rel,
                "path_under_root": str(path.relative_to(docs_root)),
                "docs_root": root_rel,
                "title": frontmatter.get("title"),
                "description": frontmatter.get("description"),
                "headings": headings[:20],
                "link_count": len(links),
                "code_fence_count": len(fences),
                "code_fence_languages": sorted({lang for lang in fences if lang}),
            }
            pages.append(page_record)
            if not frontmatter.get("title"):
                issues.append({"path": rel, "issue": "missing frontmatter title"})
            if not frontmatter.get("description"):
                issues.append({"path": rel, "issue": "missing frontmatter description"})
            for match in PLACEHOLDER_PATTERN.finditer(text):
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
        "placeholder_issues": placeholder_issues[:MAX_ITEMS],
        "navigation_files": sorted(set(nav_files))[:MAX_ITEMS],
        "docs_text": "\n".join(docs_text_chunks),
    }


def add_evidence(
    scores: dict[str, int],
    evidence: dict[str, list[dict[str, str]]],
    pack_id: str,
    reason: str,
    source: str,
    weight: int = 1,
) -> None:
    scores[pack_id] += weight
    evidence[pack_id].append({"reason": reason, "source": source})


def pack_gate(pack_id: str, surfaces: dict[str, Any], evidence: dict[str, list[dict[str, str]]]) -> bool:
    joined_evidence = " ".join(
        f"{item['reason']} {item['source']}" for item in evidence.get(pack_id, [])
    ).lower()
    routes = " ".join(f"{item['route']} {item['file']}" for item in surfaces["routes"]).lower()
    files = " ".join(
        surfaces["cli_files"] + surfaces["configs"] + surfaces["schemas"] + surfaces["migration_files"] + surfaces["provider_files"]
    ).lower()

    if pack_id == "platform-app":
        return any(
            term in routes
            for term in ("dashboard", "billing", "workspace", "organization", "org", "team", "invite", "auth")
        )
    if pack_id == "model-provider":
        model_terms = ("inference", "completion", "embedding", "chat", "tool_call", "multimodal", "tokenizer")
        return any(term in joined_evidence or term in routes or term in files for term in model_terms) and (
            bool(surfaces["api_handlers"]) or bool(surfaces["sdk_exports"]) or "api" in routes
        )
    return True


def classify_packs(
    surfaces: dict[str, Any],
    docs_inventory: dict[str, Any],
    packs_arg: str,
    include_packs: list[str],
    exclude_packs: list[str],
) -> dict[str, Any]:
    scores: dict[str, int] = defaultdict(int)
    evidence: dict[str, list[dict[str, str]]] = defaultdict(list)
    forced = set(include_packs)
    excluded = set(exclude_packs)

    add_evidence(scores, evidence, "site-shell", "base docs shell is always useful", "homelander", 2)

    if surfaces["api_handlers"] or any("api" in item["file"].lower() for item in surfaces["routes"]):
        add_evidence(scores, evidence, "http-api", "API handlers or API routes detected", "routes/api", 3)
    if surfaces["sdk_exports"]:
        add_evidence(scores, evidence, "sdk-library", "public exports detected", "sdk exports", 2)
    if surfaces["cli_files"] or any(manifest.get("bin") for manifest in surfaces["package_manifests"]):
        add_evidence(scores, evidence, "cli-tool", "CLI files or package bins detected", "package bin/cli", 3)
    if surfaces["configs"] or surfaces["schemas"]:
        add_evidence(scores, evidence, "framework-tool", "config or schema files detected", "config/schema", 1)
    if surfaces["provider_files"]:
        add_evidence(scores, evidence, "integrations", "provider, OAuth, webhook, or integration files detected", "provider files", 2)
    if surfaces["migration_files"]:
        add_evidence(scores, evidence, "migration", "migration or changelog files detected", "migration files", 2)

    for env_var in surfaces["env_vars"]:
        name = env_var["name"].lower()
        if any(term in name for term in ("api", "token", "key", "secret")):
            add_evidence(scores, evidence, "http-api", f"env var `{env_var['name']}` suggests external API/auth", "env", 1)
        if any(term in name for term in ("stripe", "slack", "github", "notion", "sanity", "resend")):
            add_evidence(scores, evidence, "integrations", f"provider env var `{env_var['name']}` detected", "env", 1)

    for route in surfaces["routes"]:
        value = f"{route['route']} {route['file']}".lower()
        if any(term in value for term in PACKS["platform-app"]["signals"]):
            add_evidence(scores, evidence, "platform-app", f"app/platform route `{route['route']}`", route["file"], 1)
        if any(term in value for term in PACKS["model-provider"]["signals"]):
            add_evidence(scores, evidence, "model-provider", f"model route `{route['route']}`", route["file"], 2)

    for signal in surfaces["pack_keyword_signals"]:
        add_evidence(
            scores,
            evidence,
            signal["pack"],
            f"keyword `{signal['keyword']}`",
            f"{signal['file']}:{signal['line']}",
            1,
        )

    explicit_packs = set(parse_pack_list(packs_arg))
    selected: list[str] = []
    if explicit_packs:
        selected = [pack for pack in explicit_packs if pack in PACKS and pack not in excluded]
    else:
        for pack_id, pack in PACKS.items():
            if pack_id in excluded:
                continue
            if pack_id in forced or (
                scores[pack_id] >= pack["threshold"] and pack_gate(pack_id, surfaces, evidence)
            ):
                selected.append(pack_id)

    for pack_id in forced:
        if pack_id in PACKS and pack_id not in selected and pack_id not in excluded:
            selected.append(pack_id)

    selected = sorted(selected, key=lambda pack_id: list(PACKS).index(pack_id))
    skipped = []
    for pack_id, pack in PACKS.items():
        if pack_id in selected:
            continue
        if pack_id in excluded:
            reason = "excluded by user"
        elif scores[pack_id] >= pack["threshold"] and not pack_gate(pack_id, surfaces, evidence):
            reason = "failed pack-specific evidence gate"
        else:
            reason = "insufficient evidence"
        skipped.append(
            {
                "pack": pack_id,
                "label": pack["label"],
                "score": scores[pack_id],
                "threshold": pack["threshold"],
                "reason": reason,
            }
        )

    classifications = []
    for pack_id in selected:
        pack = PACKS[pack_id]
        confidence = min(1.0, scores[pack_id] / max(1, pack["threshold"] + 2))
        if pack_id in forced or pack_id in explicit_packs:
            confidence = max(confidence, 0.85)
        classifications.append(
            {
                "pack": pack_id,
                "label": pack["label"],
                "score": scores[pack_id],
                "threshold": pack["threshold"],
                "confidence": round(confidence, 2),
                "evidence": evidence[pack_id][:12],
                "obligations": pack["obligations"],
            }
        )

    surface_to_pack_map = []
    for pack_id, items in evidence.items():
        for item in items[:20]:
            surface_to_pack_map.append({"pack": pack_id, **item})

    return {
        "selected_packs": classifications,
        "skipped_packs": skipped,
        "surface_to_pack_map": surface_to_pack_map[:MAX_ITEMS],
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

    for export in surfaces["sdk_exports"][:80]:
        name = export["name"]
        if name.startswith("export from "):
            continue
        if name.lower() not in docs_text and not name.startswith("_"):
            gaps.append({"surface": "sdk export", "name": name, "reason": "export not found in docs"})

    for route in surfaces["routes"][:80]:
        name = route["route"]
        if name != "/" and name.lower() not in docs_text:
            gaps.append({"surface": "route", "name": name, "reason": "route not found in docs"})

    return gaps[:MAX_ITEMS]


def page_exists(docs_inventory: dict[str, Any], plan_path: str) -> bool:
    candidates = {plan_path, str(Path(plan_path))}
    for page_item in docs_inventory["pages"]:
        if page_item["path_under_root"] in candidates:
            return True
    return False


def build_docs_portfolio_plan(
    docs_root: Path,
    pack_classification: dict[str, Any],
    docs_inventory: dict[str, Any],
) -> dict[str, Any]:
    planned_pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for selected in pack_classification["selected_packs"]:
        pack_id = selected["pack"]
        for obligation in selected["obligations"]:
            path = obligation["path"]
            if path in seen:
                continue
            seen.add(path)
            exists = page_exists(docs_inventory, path)
            planned_pages.append(
                {
                    "path": path,
                    "absolute_path": str(docs_root / path),
                    "title": obligation["title"],
                    "description": obligation["description"],
                    "pack": pack_id,
                    "required": obligation["required"],
                    "status": "exists" if exists else "missing",
                }
            )

    meta_targets = sorted(
        {
            str(Path(page_item["path"]).parent)
            for page_item in planned_pages
            if str(Path(page_item["path"]).parent) != "."
        }
    )
    if planned_pages:
        meta_targets.insert(0, ".")

    return {
        "docs_root": str(docs_root),
        "planned_pages": planned_pages,
        "meta_targets": meta_targets,
        "output_contract": [
            "MDX pages and folders",
            "Blume meta.ts navigation files",
            "Minimal blume.config.ts only when bootstrapping through blume init",
            ".homelander evidence and plan artifacts remain uncommitted by default",
        ],
    }


def template_for(pack_id: str, plan_page: dict[str, Any]) -> str:
    template_path = SKILL_ROOT / "assets" / "packs" / pack_id / plan_page["path"]
    text = read_text(template_path)
    if text:
        return text
    return f"""---
title: {plan_page["title"]}
description: {plan_page["description"]}
---

<!-- HOMELANDER: replace every scaffold marker with evidence from code, tests, schemas, examples, or PRs before opening a PR. -->

## Overview

[Summarize this page from evidence.]

## Source Evidence

- [List source files, tests, schemas, commands, or PRs used for this page.]

## Usage

[Add the user-facing workflow or reference material.]
"""


def write_file_if_missing(path: Path, content: str) -> dict[str, str]:
    if path.exists():
        return {"path": str(path), "status": "skipped", "reason": "exists"}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"path": str(path), "status": "created", "reason": "missing"}


def meta_content(folder: str, pages: list[str]) -> str:
    title = "Docs" if folder == "." else titleize(Path(folder).name)
    pages_literal = ", ".join(json.dumps(page_item) for page_item in pages)
    return f"""import {{ defineMeta }} from "blume";

export default defineMeta({{
  title: {json.dumps(title)},
  pages: [{pages_literal}],
}});
"""


def write_stubs(plan: dict[str, Any]) -> list[dict[str, str]]:
    docs_root = Path(plan["docs_root"])
    writes: list[dict[str, str]] = []
    for plan_page in plan["planned_pages"]:
        if plan_page["status"] == "exists":
            continue
        target = docs_root / plan_page["path"]
        writes.append(write_file_if_missing(target, template_for(plan_page["pack"], plan_page)))

    pages_by_folder: dict[str, list[str]] = defaultdict(list)
    for plan_page in plan["planned_pages"]:
        folder = str(Path(plan_page["path"]).parent)
        pages_by_folder[folder].append(slug_for(plan_page["path"]))
    for folder, pages in sorted(pages_by_folder.items()):
        target_folder = docs_root if folder == "." else docs_root / folder
        writes.append(write_file_if_missing(target_folder / "meta.ts", meta_content(folder, pages)))
    return writes


def build_review_findings(
    mode: str,
    docs_inventory: dict[str, Any],
    surfaces: dict[str, Any],
    gaps: list[dict[str, str]],
    plan: dict[str, Any],
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []

    def pack_for_page(page_path: str) -> str:
        for plan_page in plan["planned_pages"]:
            planned_path = plan_page["path"]
            if page_path == planned_path or page_path.endswith(f"/{planned_path}"):
                return plan_page["pack"]
        return "site-shell"

    for plan_page in plan["planned_pages"]:
        if plan_page["status"] == "missing" and plan_page["required"]:
            findings.append(
                finding(
                    "high",
                    "selected pack missing required page",
                    plan_page["path"],
                    plan_page["pack"],
                    f"Create `{plan_page['path']}` or remove the pack with evidence.",
                    "docs portfolio plan",
                )
            )

    for issue in docs_inventory["placeholder_issues"]:
        findings.append(
            finding(
                "high",
                "placeholder or scaffold text left behind",
                issue["path"],
                pack_for_page(issue["path"]),
                "Replace scaffold markers with evidence-backed prose before opening a PR.",
                f"{issue['path']}:{issue['line']} {issue['snippet']}",
            )
        )

    for issue in docs_inventory["frontmatter_issues"]:
        findings.append(
            finding(
                "medium",
                "frontmatter issue",
                issue["path"],
                "site-shell",
                "Add factual frontmatter title and description.",
                issue["issue"],
            )
        )
    for issue in docs_inventory["local_link_issues"]:
        findings.append(
            finding(
                "medium",
                "navigation/frontmatter/link/build issue",
                issue["path"],
                "site-shell",
                f"Fix local link target `{issue['target']}`.",
                issue["target"],
            )
        )

    for gap in gaps[:40]:
        pack = {
            "cli": "cli-tool",
            "env var": "cli-tool",
            "route": "http-api",
            "sdk export": "sdk-library",
        }.get(gap["surface"], "site-shell")
        findings.append(
            finding(
                "medium",
                "public surface undocumented",
                "(coverage gap)",
                pack,
                f"Document `{gap['name']}` or record why it is internal/unreleased.",
                f"{gap['surface']}: {gap['reason']}",
            )
        )

    if surfaces["feature_flags"]:
        for item in surfaces["feature_flags"][:20]:
            findings.append(
                finding(
                    "low" if mode == "audit" else "medium",
                    "feature-flag or unreleased signal needs review",
                    "(classification)",
                    "site-shell",
                    "Do not document this behavior as GA unless the docs target that audience.",
                    f"{item['file']}:{item['line']} {item['snippet']}",
                )
            )

    return findings[:MAX_ITEMS]


def finding(
    severity: str,
    category: str,
    page_path: str,
    pack: str,
    required_fix: str,
    evidence: str,
) -> dict[str, str]:
    return {
        "severity": severity,
        "category": category,
        "page": page_path,
        "pack": pack,
        "required_fix": required_fix,
        "evidence": evidence,
    }


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
    classification = report["pack_classification"]
    plan = report["docs_portfolio_plan"]
    review = report["review_findings"]

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
        f"- Selected docs packs: {len(classification['selected_packs'])}",
        f"- Planned pages: {len(plan['planned_pages'])}",
        f"- Review findings: {len(review)}",
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
        "## Pack Classification",
        "",
    ]
    if classification["selected_packs"]:
        for pack in classification["selected_packs"]:
            evidence = "; ".join(item["reason"] for item in pack["evidence"][:3]) or "forced"
            lines.append(
                f"- `{pack['pack']}` confidence={pack['confidence']} score={pack['score']}: {evidence}"
            )
    else:
        lines.append("- No packs selected.")

    lines.extend(["", "### Skipped Packs", ""])
    lines.append(
        bullet_list(
            [
                f"`{pack['pack']}` score={pack['score']}/{pack['threshold']}: {pack['reason']}"
                for pack in classification["skipped_packs"]
            ],
            "No packs skipped.",
        )
    )

    lines.extend(["", "## Docs Portfolio Plan", ""])
    lines.append(
        bullet_list(
            [
                f"`{page_item['path']}` ({page_item['pack']}, {page_item['status']}, required={page_item['required']})"
                for page_item in plan["planned_pages"]
            ],
            "No pages planned.",
        )
    )

    if report["stub_writes"]:
        lines.extend(["", "## Stub Writes", ""])
        lines.append(
            bullet_list(
                [
                    f"{item['status']}: `{item['path']}` ({item['reason']})"
                    for item in report["stub_writes"]
                ],
                "No stubs written.",
            )
        )

    lines.extend(["", "## DeepSec-Style Review Findings", ""])
    lines.append(
        bullet_list(
            [
                f"[{item['severity']}] {item['category']} in `{item['page']}` "
                f"({item['pack']}): {item['required_fix']} Evidence: {item['evidence']}"
                for item in review
            ],
            "No review findings.",
        )
    )

    lines.extend(
        [
            "",
            "## Recent Merged Work",
            "",
        ]
    )
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
                    f"`{page_item['path']}` title={page_item.get('title')!r} "
                    f"fences={page_item['code_fence_count']} links={page_item['link_count']}"
                    for page_item in docs["pages"][:40]
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
            "## Navigation Files",
            "",
            bullet_list([f"`{item}`" for item in docs["navigation_files"][:40]], "No navigation files found."),
            "",
            "## Next Steps",
            "",
            "- Use selected packs to author the docs portfolio, not a single archetype.",
            "- Replace all scaffold markers with evidence from code, tests, schemas, examples, or PRs.",
            "- Run the DeepSec-style review turn again after authoring and before opening a PR.",
            "- Skip flagged or unreleased behavior unless the docs target that audience.",
            "- Run the repo docs build and focused validation after edits.",
        ]
    )

    if validation:
        lines.extend(["", "## Scanner Notes", ""])
        lines.extend(f"- {item}" for item in validation)

    return "\n".join(lines) + "\n"


def build_report(args: argparse.Namespace, stub_writes: list[dict[str, str]] | None = None) -> dict[str, Any]:
    repo = Path(args.repo).resolve()
    docs_roots = detect_docs_roots(repo, args.docs_root)
    docs_inventory = scan_docs(repo, docs_roots)
    public_surfaces = scan_public_surfaces(repo, docs_roots)
    pack_classification = classify_packs(
        public_surfaces,
        docs_inventory,
        args.packs,
        parse_pack_list(args.include_packs),
        parse_pack_list(args.exclude_packs),
    )
    docs_root = choose_stub_docs_root(repo, docs_roots, args.docs_root)
    portfolio_plan = build_docs_portfolio_plan(docs_root, pack_classification, docs_inventory)
    gaps = docs_gap_candidates(docs_inventory, public_surfaces)
    review_findings = build_review_findings(
        args.mode,
        docs_inventory,
        public_surfaces,
        gaps,
        portfolio_plan,
    )
    validation: list[str] = []
    if not docs_roots:
        validation.append(
            "No docs root was detected. Run `blume init` or set --docs-root before writing final docs."
        )
    if args.docs_root and not docs_roots:
        validation.append(f"Explicit docs root does not exist yet: {args.docs_root}")
    unknown_packs = [
        pack
        for pack in parse_pack_list(args.packs) + parse_pack_list(args.include_packs) + parse_pack_list(args.exclude_packs)
        if pack not in PACKS
    ]
    if unknown_packs:
        validation.append(f"Unknown pack(s): {', '.join(sorted(set(unknown_packs)))}")

    return {
        "mode": args.mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "repo": str(repo),
        "git": git_context(repo, args.lookback_days),
        "docs_inventory": docs_inventory,
        "public_surfaces": public_surfaces,
        "pack_classification": pack_classification,
        "surface_to_pack_map": pack_classification["surface_to_pack_map"],
        "pack_obligations": {
            pack_id: pack["obligations"] for pack_id, pack in PACKS.items()
        },
        "docs_portfolio_plan": portfolio_plan,
        "docs_gap_candidates": gaps,
        "review_findings": review_findings,
        "validation": validation,
        "stub_writes": stub_writes or [],
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
    parser.add_argument(
        "--packs",
        default="auto",
        help="Comma-separated pack list or `auto`. Aliases: api, models, sdk, cli, app.",
    )
    parser.add_argument("--include-packs", help="Comma-separated pack list to force include.")
    parser.add_argument("--exclude-packs", help="Comma-separated pack list to exclude.")
    parser.add_argument("--write-stubs", action="store_true", help="Create missing planned MDX and meta.ts files.")
    parser.add_argument("--lookback-days", type=int, default=7, help="Recent git/PR lookback window.")
    parser.add_argument("--output", default=".homelander/evidence.md", help="Markdown report path.")
    parser.add_argument("--json-output", default=".homelander/evidence.json", help="JSON report path.")
    parser.add_argument("--plan-output", default=".homelander/docs-plan.json", help="Docs portfolio plan JSON path.")
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    if not repo.exists():
        raise SystemExit(f"Repository path does not exist: {repo}")

    initial_report = build_report(args)
    stub_writes: list[dict[str, str]] = []
    if args.write_stubs:
        stub_writes = write_stubs(initial_report["docs_portfolio_plan"])
    report = build_report(args, stub_writes=stub_writes)

    output = (repo / args.output).resolve()
    json_output = (repo / args.json_output).resolve()
    plan_output = (repo / args.plan_output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    json_output.parent.mkdir(parents=True, exist_ok=True)
    plan_output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(markdown_report(report), encoding="utf-8")
    json_output.write_text(json.dumps(strip_large_fields(report), indent=2), encoding="utf-8")
    plan_output.write_text(
        json.dumps(report["docs_portfolio_plan"], indent=2),
        encoding="utf-8",
    )
    print(f"Wrote {output}")
    print(f"Wrote {json_output}")
    print(f"Wrote {plan_output}")
    if args.write_stubs:
        created = len([item for item in stub_writes if item["status"] == "created"])
        skipped = len([item for item in stub_writes if item["status"] == "skipped"])
        print(f"Stub writes: {created} created, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
