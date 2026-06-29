import { readFile } from "node:fs/promises";

import { dirname, relative, resolve } from "pathe";

import { BlumeError } from "../../core/diagnostics.ts";
import type {
  BlumeConfig,
  DirectoryMode,
  ResolvedConfig,
  SidebarItemConfig,
} from "../../core/schema.ts";

type JsonObject = Record<string, unknown>;
type NavigationSelectors = ResolvedConfig["navigation"]["selectors"];
type NavigationSelectorItem = NavigationSelectors[number]["items"][number];
type NavigationChromeVariants = NonNullable<
  BlumeConfig["navigation"]
>["chromeVariants"];
type NavigationSidebarVariants =
  ResolvedConfig["navigation"]["sidebarVariants"];

const MINTLIFY_DEFAULT_IGNORES = [
  "**/_*",
  "**/.*",
  ".git/**",
  ".github/**",
  ".claude/**",
  ".agents/**",
  ".mintlify/**",
  ".idea/**",
  ".vscode/**",
  ".blume/**",
  "node_modules/**",
  "build/**",
  "dist/**",
  "coverage/**",
  ".cache/**",
  "snippets/**",
  "tmp/**",
  "temp/**",
  "README.md",
  "README.mdx",
  "skill.md",
  "LICENSE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
];
const API_ENDPOINT_REF =
  /^(?<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(?<path>\/.*)$/iu;
const VARIABLE_NAME = /^[A-Za-z0-9-]+$/u;

const asObject = (value: unknown): JsonObject | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

const asArray = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asDirectoryMode = (value: unknown): DirectoryMode | undefined =>
  value === "accordion" || value === "card" || value === "none"
    ? value
    : undefined;

const withoutUndefined = <T extends JsonObject>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  ) as T;

const hasOwn = (object: JsonObject, key: string): boolean =>
  Object.hasOwn(object, key);

const isInsideRoot = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

const readJsonFile = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (error) {
    throw new BlumeError({
      code: "BLUME_MINTLIFY_CONFIG_INVALID",
      file,
      message: `Could not parse Mintlify config: ${(error as Error).message}`,
      severity: "error",
    });
  }
};

const resolveRefs = async (
  value: unknown,
  options: { file: string; root: string; seen: Set<string> }
): Promise<unknown> => {
  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item) => resolveRefs(item, options))
    ) as Promise<unknown[]>;
  }

  const object = asObject(value);
  if (!object) {
    return value;
  }

  const ref = asString(object.$ref);
  if (ref) {
    const refFile = resolve(dirname(options.file), ref);
    if (!isInsideRoot(options.root, refFile)) {
      throw new BlumeError({
        code: "BLUME_MINTLIFY_REF_OUTSIDE_ROOT",
        file: options.file,
        message: `Mintlify $ref points outside the project root: ${ref}`,
        severity: "error",
      });
    }
    if (options.seen.has(refFile)) {
      throw new BlumeError({
        code: "BLUME_MINTLIFY_REF_CYCLE",
        file: options.file,
        message: `Mintlify $ref cycle detected at ${ref}`,
        severity: "error",
      });
    }

    options.seen.add(refFile);
    const resolved = await resolveRefs(await readJsonFile(refFile), {
      file: refFile,
      root: options.root,
      seen: options.seen,
    });
    options.seen.delete(refFile);

    const siblings = Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== "$ref")
    );
    if (asObject(resolved)) {
      return resolveRefs({ ...(resolved as JsonObject), ...siblings }, options);
    }
    return resolved;
  }

  return Object.fromEntries(
    await Promise.all(
      Object.entries(object).map(async ([key, item]) => [
        key,
        await resolveRefs(item, options),
      ])
    )
  );
};

const normalizePageRef = (ref: string): string =>
  ref.replace(/\.(?<ext>mdx?|mdoc)$/u, "");

const labelForNavItem = (item: JsonObject): string | undefined =>
  asString(item.group) ??
  asString(item.label) ??
  asString(item.anchor) ??
  asString(item.tab) ??
  asString(item.dropdown) ??
  asString(item.product) ??
  asString(item.version) ??
  asString(item.language) ??
  asString(item.item) ??
  asString(item.name) ??
  asString(item.title);

const childNavigationArrays = (item: JsonObject): unknown[][] => [
  asArray(item.pages),
  asArray(item.groups),
  asArray(item.menu),
  asArray(item.tabs),
  asArray(item.anchors),
  asArray(item.dropdowns),
  asArray(item.products),
  asArray(item.versions),
  asArray(item.languages),
  asArray(item.items),
  asArray(item.children),
];

const childItemsFor = (item: JsonObject): unknown[] => {
  for (const items of childNavigationArrays(item)) {
    if (items.length > 0) {
      return items;
    }
  }
  return [];
};

const mintlifyNavigationItems = (navigation: JsonObject): unknown[] => {
  const pages = asArray(navigation.pages);
  if (pages.length > 0) {
    return pages;
  }
  const groups = asArray(navigation.groups);
  if (groups.length > 0) {
    return groups;
  }
  return [
    ...asArray(navigation.tabs),
    ...asArray(navigation.anchors),
    ...asArray(navigation.dropdowns),
    ...asArray(navigation.products),
    ...asArray(navigation.versions),
    ...asArray(navigation.languages),
  ];
};

const normalizeDirectory = (value: string): string =>
  normalizePageRef(value).replaceAll(/^\/+|\/+$/gu, "");

const tabPathFromRef = (ref: string): string => {
  const normalized = normalizeDirectory(ref).replaceAll(/\/index$/gu, "");
  return normalized.length === 0 || normalized === "index"
    ? "/"
    : `/${normalized}`;
};

const navItemPath = (item: unknown): string | undefined => {
  if (typeof item === "string") {
    return API_ENDPOINT_REF.test(item) ? undefined : tabPathFromRef(item);
  }

  const object = asObject(item);
  if (!object) {
    return undefined;
  }

  const href = asString(object.href);
  if (href) {
    return href;
  }

  const root = asString(object.root);
  if (root) {
    return tabPathFromRef(root);
  }

  for (const child of childItemsFor(object)) {
    const path = navItemPath(child);
    if (path) {
      return path;
    }
  }
  return undefined;
};

const optionalBoolean = (value: unknown): boolean | undefined => {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  return undefined;
};

const mintlifyBackgroundColor = (
  value: unknown
): { dark?: string; light?: string } => {
  const object = asObject(value);
  if (!object) {
    return {};
  }
  const color = asObject(object.color);
  return {
    dark: asString(color?.dark),
    light: asString(color?.light),
  };
};

const mintlifyBackgroundImage = (
  value: unknown
): { dark?: string; light?: string } => {
  const object = asObject(value);
  if (!object) {
    return {};
  }
  if (typeof object.image === "string") {
    return { light: object.image };
  }
  const image = asObject(object.image);
  return {
    dark: asString(image?.dark),
    light: asString(image?.light),
  };
};

const mintlifyBackgroundDecoration = (
  value: unknown
): "gradient" | "grid" | "windows" | undefined => {
  const object = asObject(value);
  const decoration = asString(object?.decoration);
  if (
    decoration === "gradient" ||
    decoration === "grid" ||
    decoration === "windows"
  ) {
    return decoration;
  }
  return undefined;
};

const sidebarItemPaths = (items: SidebarItemConfig[]): string[] =>
  items.flatMap((item) => {
    if (typeof item === "string") {
      return [tabPathFromRef(item)];
    }
    if (item.href) {
      return [item.href];
    }
    const paths = item.root ? [tabPathFromRef(item.root)] : [];
    return item.items ? [...paths, ...sidebarItemPaths(item.items)] : paths;
  });

const collapsedFromExpanded = (value: unknown): boolean | undefined => {
  if (value === false) {
    return true;
  }
  if (value === true) {
    return false;
  }
  return undefined;
};

interface SidebarOptions {
  directory?: DirectoryMode;
}

type SidebarItemConverter = (
  items: unknown[],
  options: SidebarOptions
) => Promise<SidebarItemConfig[]>;

const toSidebarObjectItems = async (
  object: JsonObject,
  options: SidebarOptions,
  convertItems: SidebarItemConverter
): Promise<SidebarItemConfig[]> => {
  const label = labelForNavItem(object);
  const href = asString(object.href);
  const icon = asString(object.icon);
  const groupLabel = asString(object.group);
  const tag = groupLabel ? asString(object.tag) : undefined;
  const root = asString(object.root);
  const rootRef = root && groupLabel ? normalizePageRef(root) : undefined;
  const directory = asDirectoryMode(object.directory) ?? options.directory;
  const rootDirectory = rootRef && directory !== "none" ? directory : undefined;
  const children = childItemsFor(object);
  const nested = await convertItems(children, { ...options, directory });

  if (nested.length > 0) {
    return label
      ? [
          withoutUndefined({
            badge: tag,
            collapsed: collapsedFromExpanded(object.expanded),
            directory: rootDirectory,
            icon,
            items: nested,
            label,
            root: rootRef,
          }),
        ]
      : nested;
  }

  if (label && rootRef) {
    return [
      withoutUndefined({
        badge: tag,
        directory: rootDirectory,
        icon,
        label,
        root: rootRef,
      }),
    ];
  }

  if (label && href) {
    return [withoutUndefined({ badge: tag, href, icon, label })];
  }

  return [];
};

const toSidebarItems = async (
  items: unknown[],
  options: SidebarOptions
): Promise<SidebarItemConfig[]> => {
  const itemLists = await Promise.all(
    items.map((item): SidebarItemConfig[] | Promise<SidebarItemConfig[]> => {
      if (typeof item === "string") {
        return [normalizePageRef(item)];
      }

      const object = asObject(item);
      if (!object) {
        return [];
      }

      return toSidebarObjectItems(object, options, toSidebarItems);
    })
  );
  return itemLists.flat();
};

const selectorItemsFor = (items: unknown[]): NavigationSelectorItem[] =>
  items.flatMap((item) => {
    const object = asObject(item);
    if (!object) {
      return [];
    }
    const label = labelForNavItem(object);
    const path = navItemPath(object);
    if (!label || !path) {
      return [];
    }
    return [
      withoutUndefined({
        description: asString(object.description),
        icon: asString(object.icon),
        label,
        path,
        tag: asString(object.tag),
      }),
    ];
  });

const isExternalRoute = (path: string): boolean =>
  path.startsWith("http://") ||
  path.startsWith("https://") ||
  path.startsWith("mailto:") ||
  path.startsWith("tel:");

const hasOwnNavigationContent = (item: JsonObject): boolean =>
  Boolean(asString(item.root)) || childItemsFor(item).length > 0;

const mintlifySidebarVariants = async (
  spec: JsonObject
): Promise<NavigationSidebarVariants> => {
  const navigation = asObject(spec.navigation) ?? {};
  const global = asObject(navigation.global) ?? {};
  interface SidebarVariantCandidate {
    item: unknown;
    path: string;
  }
  const candidates: SidebarVariantCandidate[] = [];

  const addCandidate = (item: unknown): void => {
    const path = navItemPath(item);
    if (!path || isExternalRoute(path)) {
      return;
    }

    candidates.push({ item, path });
  };

  for (const item of [
    ...asArray(navigation.tabs),
    ...asArray(navigation.anchors),
    ...asArray(global.anchors),
  ]) {
    const object = asObject(item);
    if (!object) {
      addCandidate(item);
      continue;
    }

    for (const menuItem of asArray(object.menu)) {
      addCandidate(menuItem);
    }

    if (hasOwnNavigationContent(object)) {
      addCandidate(item);
    }
  }

  for (const item of [
    ...asArray(navigation.dropdowns),
    ...asArray(navigation.products),
    ...asArray(navigation.versions),
    ...asArray(navigation.languages),
  ]) {
    addCandidate(item);
  }

  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      const items = await toSidebarItems([candidate.item], {});
      if (items.length === 0) {
        return [];
      }
      return [candidate.path, ...sidebarItemPaths(items)]
        .filter((path) => !isExternalRoute(path))
        .map((path) => ({ items, path }));
    })
  );
  const seen = new Set<string>();
  return resolved.flat().flatMap((variant) => {
    if (!variant || seen.has(variant.path)) {
      return [];
    }
    seen.add(variant.path);
    return [variant];
  });
};

const mintlifyTabs = (
  spec: JsonObject
): NonNullable<BlumeConfig["navigation"]>["tabs"] => {
  const navigation = asObject(spec.navigation) ?? {};
  const global = asObject(navigation.global) ?? {};

  const items = [
    ...asArray(navigation.tabs),
    ...asArray(global.anchors),
  ].filter(Boolean);
  const seen = new Set<string>();

  return items.flatMap((item) => {
    const object = asObject(item);
    if (!object) {
      return [];
    }
    const label = labelForNavItem(object);
    const path = navItemPath(object);
    if (!label || !path) {
      return [];
    }
    const key = `${label}\u0000${path}`;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    const menu = asArray(object.menu);
    const menuItems = selectorItemsFor(
      menu.length > 0 ? menu : childItemsFor(object)
    );
    return [
      withoutUndefined({
        icon: asString(object.icon),
        items: menuItems.length > 0 ? menuItems : undefined,
        label,
        path,
      }),
    ];
  });
};

const mintlifySelectors = (spec: JsonObject): NavigationSelectors => {
  const navigation = asObject(spec.navigation) ?? {};
  return [
    {
      items: selectorItemsFor(asArray(navigation.dropdowns)),
      kind: "dropdown" as const,
      label: "Dropdowns",
    },
    {
      items: selectorItemsFor(asArray(navigation.products)),
      kind: "product" as const,
      label: "Products",
    },
    {
      items: selectorItemsFor(asArray(navigation.versions)),
      kind: "version" as const,
      label: "Versions",
    },
    {
      items: selectorItemsFor(asArray(navigation.languages)),
      kind: "language" as const,
      label: "Languages",
    },
  ].filter((selector) => selector.items.length > 0);
};

const navbarTypeLabel = (type: string | undefined): string | undefined => {
  if (type === "github") {
    return "GitHub";
  }
  if (type === "discord") {
    return "Discord";
  }
  return undefined;
};

const navbarLinkType = (
  type: string | undefined
): "github" | "discord" | undefined =>
  type === "github" || type === "discord" ? type : undefined;

const navbarPrimaryType = (
  type: string | undefined
): "button" | "github" | "discord" =>
  type === "github" || type === "discord" ? type : "button";

const mintlifyNavbar = (value: unknown): NonNullable<BlumeConfig["navbar"]> => {
  const object = asObject(value);
  if (!object) {
    return { links: [] };
  }

  const links = asArray(object.links).flatMap((item) => {
    const itemObject = asObject(item);
    const href = itemObject ? asString(itemObject.href) : undefined;
    const type = itemObject ? asString(itemObject.type) : undefined;
    const label = itemObject
      ? (asString(itemObject.label) ?? navbarTypeLabel(type))
      : undefined;
    if (!itemObject || !href || !label) {
      return [];
    }
    return [
      withoutUndefined({
        href,
        icon: asString(itemObject.icon),
        label,
        type: navbarLinkType(type),
      }),
    ];
  });

  const primaryObject = asObject(object.primary);
  const primaryHref = primaryObject ? asString(primaryObject.href) : undefined;
  const primaryType = primaryObject
    ? (asString(primaryObject.type) ?? "button")
    : undefined;
  const primaryLabel = primaryObject
    ? (asString(primaryObject.label) ?? navbarTypeLabel(primaryType))
    : undefined;
  const primary =
    primaryObject && primaryHref && primaryLabel
      ? withoutUndefined({
          href: primaryHref,
          label: primaryLabel,
          type: navbarPrimaryType(primaryType),
        })
      : undefined;

  return withoutUndefined({ links, primary });
};

const mintignorePatterns = async (root: string): Promise<string[]> => {
  try {
    const raw = await readFile(resolve(root, ".mintignore"), "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .filter((line) => !line.startsWith("!"))
      .map((line) => (line.endsWith("/") ? `${line}**` : line));
  } catch {
    return [];
  }
};

const mintlifyRedirects = (
  spec: JsonObject
): NonNullable<BlumeConfig["redirects"]> =>
  asArray(spec.redirects).flatMap((redirect) => {
    const object = asObject(redirect);
    if (!object) {
      return [];
    }
    const from = asString(object.source) ?? asString(object.from);
    const to =
      asString(object.destination) ??
      asString(object.to) ??
      asString(object.redirect);
    if (!from || !to) {
      return [];
    }
    return [{ from, to }];
  });

const mintlifyContextual = (
  value: unknown
): NonNullable<BlumeConfig["contextual"]> => {
  const object = asObject(value);
  if (!object) {
    return { options: [] };
  }

  const display = object.display === "toc" ? "toc" : "header";
  const options: NonNullable<BlumeConfig["contextual"]>["options"] = [];
  for (const option of asArray(object.options)) {
    if (typeof option === "string") {
      options.push(option);
      continue;
    }

    const optionObject = asObject(option);
    const title = optionObject ? asString(optionObject.title) : undefined;
    if (!optionObject || !title) {
      continue;
    }

    options.push(
      withoutUndefined({
        description: asString(optionObject.description),
        href: asString(optionObject.href),
        icon: asString(optionObject.icon),
        title,
      })
    );
  }

  return { display, options };
};

const mintlifyFooter = (value: unknown): NonNullable<BlumeConfig["footer"]> => {
  const object = asObject(value);
  const socials = asObject(object?.socials);
  const links = asArray(object?.links)
    .flatMap((group) => {
      const groupObject = asObject(group);
      const items = asArray(groupObject?.items).flatMap((item) => {
        const itemObject = asObject(item);
        const label = itemObject ? asString(itemObject.label) : undefined;
        const href = itemObject ? asString(itemObject.href) : undefined;
        return label && href ? [{ href, label }] : [];
      });
      if (!groupObject || items.length === 0) {
        return [];
      }
      return [
        withoutUndefined({
          header: asString(groupObject.header),
          items,
        }),
      ];
    })
    .slice(0, 4);

  return {
    links,
    socials: socials
      ? Object.fromEntries(
          Object.entries(socials).flatMap(([label, href]) => {
            const hrefValue = asString(href);
            return hrefValue ? [[label, hrefValue]] : [];
          })
        )
      : {},
  };
};

const mintlifyLogo = (value: unknown): BlumeConfig["logo"] => {
  if (typeof value === "string") {
    return value;
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const dark = asString(object.dark);
  const light = asString(object.light);
  const href = asString(object.href);
  if (!dark && !light && !href) {
    return undefined;
  }
  return withoutUndefined({ dark, href, light });
};

const mintlifyFavicon = (value: unknown): BlumeConfig["favicon"] => {
  if (typeof value === "string") {
    return value;
  }
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const dark = asString(object.dark);
  const light = asString(object.light);
  if (!dark && !light) {
    return undefined;
  }
  return withoutUndefined({ dark, light });
};

const mintlifyBanner = (value: unknown): BlumeConfig["banner"] => {
  const object = asObject(value);
  const content = object ? asString(object.content) : undefined;
  if (!object || !content) {
    return undefined;
  }

  const color = asObject(object.color);
  const dark = color ? asString(color.dark) : undefined;
  const light = color ? asString(color.light) : undefined;
  const rawType = asString(object.type);
  let type: "info" | "warning" | "critical" | undefined;
  if (rawType === "warning" || rawType === "critical" || rawType === "info") {
    type = rawType;
  }

  return withoutUndefined({
    color:
      dark || light
        ? withoutUndefined({
            dark,
            light,
          })
        : undefined,
    content,
    dismissible: object.dismissible === true ? true : undefined,
    type,
  });
};

const mintlifyChromeVariants = (spec: JsonObject): NavigationChromeVariants => {
  const navigation = asObject(spec.navigation) ?? {};

  return asArray(navigation.languages).flatMap((item) => {
    const object = asObject(item);
    const path = navItemPath(item);
    if (!object || !path || isExternalRoute(path)) {
      return [];
    }

    const banner = hasOwn(object, "banner")
      ? mintlifyBanner(object.banner)
      : undefined;
    const footer = hasOwn(object, "footer")
      ? mintlifyFooter(object.footer)
      : undefined;
    const navbar = hasOwn(object, "navbar")
      ? mintlifyNavbar(object.navbar)
      : undefined;
    if (!banner && !footer && !navbar) {
      return [];
    }

    return [
      withoutUndefined({
        banner,
        footer,
        navbar,
        path,
      }),
    ];
  });
};

const mintlifyVariables = (
  value: unknown
): NonNullable<BlumeConfig["variables"]> => {
  const object = asObject(value);
  if (!object) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(object).flatMap(([key, item]) =>
      VARIABLE_NAME.test(key) && typeof item === "string" ? [[key, item]] : []
    )
  );
};

const mintlifyCodeTheme = (
  value: unknown
):
  | NonNullable<NonNullable<BlumeConfig["markdown"]>["codeBlocks"]>["theme"]
  | undefined => {
  if (value === "system" || value === undefined) {
    return undefined;
  }
  if (value === "dark") {
    return { dark: "github-dark", light: "github-dark" };
  }
  const theme = asString(value);
  if (theme) {
    return { dark: theme, light: theme };
  }

  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  const light = asString(object.light);
  const dark = asString(object.dark);
  if (!light && !dark) {
    return undefined;
  }
  return {
    dark: dark ?? light ?? "github-dark",
    light: light ?? dark ?? "github-light",
  };
};

const mintlifyCodeBlocks = (
  value: unknown
): NonNullable<BlumeConfig["markdown"]>["codeBlocks"] | undefined => {
  const object = asObject(value);
  const theme = mintlifyCodeTheme(object ? object.theme : value);
  return theme ? { theme } : undefined;
};

const mintlifyMarkdown = (
  value: unknown,
  styling: unknown
): NonNullable<BlumeConfig["markdown"]> => {
  const object = asObject(value);
  const stylingObject = asObject(styling);
  return withoutUndefined({
    codeBlocks: mintlifyCodeBlocks(stylingObject?.codeblocks),
    math: optionalBoolean(stylingObject?.latex),
    schema: object?.schema === false ? false : undefined,
  });
};

const mintlifyStyling = (
  value: unknown
): NonNullable<BlumeConfig["styling"]> => {
  const object = asObject(value);
  const eyebrows = asString(object?.eyebrows);
  return withoutUndefined({
    eyebrows:
      eyebrows === "breadcrumbs" || eyebrows === "section"
        ? eyebrows
        : undefined,
  });
};

const mintlifySeo = (value: unknown): NonNullable<BlumeConfig["seo"]> => {
  const object = asObject(value);
  const metatags = asObject(object?.metatags);
  return {
    metatags: metatags
      ? Object.fromEntries(
          Object.entries(metatags).flatMap(([key, item]) => {
            const content = asString(item);
            return content ? [[key, content]] : [];
          })
        )
      : {},
  };
};

const mintlifyIcons = (value: unknown): NonNullable<BlumeConfig["icons"]> => {
  const object = asObject(value);
  const library = object?.library;
  return withoutUndefined({
    library:
      library === "fontawesome" || library === "lucide" || library === "tabler"
        ? library
        : undefined,
  });
};

export const loadMintlifyConfig = async (
  root: string,
  file: string
): Promise<BlumeConfig> => {
  const projectRoot = resolve(root);
  const configFile = resolve(file);
  const spec = asObject(
    await resolveRefs(await readJsonFile(configFile), {
      file: configFile,
      root: projectRoot,
      seen: new Set([configFile]),
    })
  );
  if (!spec) {
    throw new BlumeError({
      code: "BLUME_MINTLIFY_CONFIG_INVALID",
      file: configFile,
      message: "Mintlify config must be a JSON object.",
      severity: "error",
    });
  }

  const navigation = asObject(spec.navigation) ?? {};
  const colors = asObject(spec.colors) ?? {};
  const appearance = asObject(spec.appearance) ?? {};
  const backgroundColor = mintlifyBackgroundColor(spec.background);
  const backgroundImage = mintlifyBackgroundImage(spec.background);
  const seo = asObject(spec.seo) ?? {};
  const search = asObject(spec.search) ?? {};
  const styling = asObject(spec.styling) ?? {};

  return {
    banner: mintlifyBanner(spec.banner),
    content: {
      exclude: [
        ...MINTLIFY_DEFAULT_IGNORES,
        ...(await mintignorePatterns(projectRoot)),
      ],
      root: ".",
    },
    contextual: mintlifyContextual(spec.contextual),
    description: asString(spec.description),
    favicon: mintlifyFavicon(spec.favicon),
    footer: mintlifyFooter(spec.footer),
    icons: mintlifyIcons(spec.icons),
    logo: mintlifyLogo(spec.logo),
    markdown: mintlifyMarkdown(spec.markdown, styling),
    navbar: mintlifyNavbar(spec.navbar),
    navigation: {
      chromeVariants: mintlifyChromeVariants(spec),
      selectors: mintlifySelectors(spec),
      sidebar: await toSidebarItems(mintlifyNavigationItems(navigation), {}),
      sidebarVariants: await mintlifySidebarVariants(spec),
      tabs: mintlifyTabs(spec),
    },
    redirects: mintlifyRedirects(spec),
    search: {
      indexing: {
        includeHiddenPages: seo.indexing === "all",
      },
      prompt: asString(search.prompt),
    },
    seo: mintlifySeo(seo),
    styling: mintlifyStyling(styling),
    theme: {
      accent: asString(colors.primary) ?? "blue",
      accentDark: asString(colors.light),
      action: asString(colors.dark),
      background: backgroundColor.light,
      backgroundDark: backgroundColor.dark,
      backgroundDecoration: mintlifyBackgroundDecoration(spec.background),
      backgroundImage: backgroundImage.light,
      backgroundImageDark: backgroundImage.dark,
      mode:
        appearance.default === "light" ||
        appearance.default === "dark" ||
        appearance.default === "system"
          ? appearance.default
          : "system",
      strict: appearance.strict === true,
    },
    title: asString(spec.name) ?? asString(spec.title) ?? "Documentation",
    variables: mintlifyVariables(spec.variables),
  };
};
