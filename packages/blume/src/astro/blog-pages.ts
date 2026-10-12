import { join } from "pathe";

import { BLOG_TAGS_ROUTE, blogTagRoutes } from "../core/blog.ts";
import type { BlumeProject } from "../core/project-graph.ts";
import { generatedBlogTagRoutes, hasGeneratedBlog } from "./pages.ts";
import { blogPageTemplate } from "./templates.ts";

/**
 * The blog's generated pages, for the generator and eject alike: the `/blog`
 * index unless a user page owns the route, and the tag page (one file, a page
 * per tag) unless user pages own every tag's route — the ones they own are
 * left to them. Empty without blog posts.
 */
export const blogPageFiles = (
  project: BlumeProject,
  userPages: { pattern: string }[],
  srcDir: string,
  options: Omit<Parameters<typeof blogPageTemplate>[0], "tags">
): { content: string; path: string }[] => {
  const files: { content: string; path: string }[] = [];
  if (hasGeneratedBlog(project, userPages)) {
    files.push({
      content: blogPageTemplate(options),
      path: join(srcDir, "pages", "blog.astro"),
    });
  }
  const tagPages = generatedBlogTagRoutes(project, userPages);
  if (tagPages.length > 0) {
    const taken = blogTagRoutes(
      project.graph.pages,
      project.config.i18n?.defaultLocale ?? null
    )
      .filter((route) => !tagPages.includes(route))
      .map((route) => route.slice(BLOG_TAGS_ROUTE.length + 1));
    files.push({
      content: blogPageTemplate({ ...options, tags: { taken } }),
      path: join(srcDir, "pages", "blog", "tags", "[tag].astro"),
    });
  }
  return files;
};
