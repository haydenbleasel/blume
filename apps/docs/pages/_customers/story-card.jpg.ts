// Serves each customer story's Open Graph card (story-card.ts) at
// /customers/og/<id>.jpg, prerendered at build. The `storyCards` integration
// in blume.config.ts mounts it, since pages/ only routes .astro files.
import { fileURLToPath } from "node:url";

import type { APIRoute } from "astro";
import { publicDir } from "astro:config/server";

import { stories } from "./customers.ts";
import type { CustomerStory } from "./customers.ts";
import { renderStoryCard } from "./story-card.ts";

export const prerender = true;

export const getStaticPaths = () =>
  stories.map((story) => ({ params: { id: story.id }, props: { story } }));

export const GET: APIRoute<{ story: CustomerStory }> = async ({ props }) => {
  const card = await renderStoryCard(props.story, fileURLToPath(publicDir));
  return new Response(new Uint8Array(card), {
    headers: { "Content-Type": "image/jpeg" },
  });
};
