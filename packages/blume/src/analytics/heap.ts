import { z } from "zod";

import type { AdapterDescriptor, JsonValue } from "../core/adapter.ts";
import { adapterDescriptorSchema } from "../core/adapter.ts";
import type { HeadScript } from "./head.ts";
import { inlineJson } from "./inline.ts";

/** The options {@link heap} maps itself. */
export interface HeapNamedOptions {
  /** App ID (the environment ID), from the project's install settings. */
  id: string;
}

/**
 * Options for {@link heap}: the app ID plus any other `heap.load` config
 * option, forwarded verbatim (`disableTextCapture`, `secureCookie`, …). JSON
 * values only.
 */
export type HeapOptions = HeapNamedOptions & {
  [option: string]: JsonValue;
};

export const heapOptionsSchema = z
  .object({
    id: z.string().min(1),
  })
  .catchall(z.json());

export type HeapAdapter = AdapterDescriptor<"heap", HeapOptions>;

export const heapAdapterSchema = adapterDescriptorSchema(
  "heap",
  heapOptionsSchema
);

/**
 * Heap autocapture analytics. The app ID is public — the tag carries it on
 * every page.
 */
export const heap = (options: HeapOptions): HeapAdapter => ({
  kind: "heap",
  options,
  requiredSecrets: [],
  runtimeDeps: [],
});

// The install snippet: a `window.heap` queue whose `load` injects the keyed
// script and stubs the API until it arrives.
const HEAP_LOADER =
  'window.heap=window.heap||[],heap.load=function(e,t){window.heap.appid=e,window.heap.config=t=t||{};var r=document.createElement("script");r.type="text/javascript",r.async=!0,r.src="https://cdn.heapanalytics.com/js/heap-"+e+".js";var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(r,a);for(var n=function(e){return function(){heap.push([e].concat(Array.prototype.slice.call(arguments,0)))}},p=["addEventProperties","addUserProperties","clearEventProperties","identify","resetIdentity","removeEventProperty","setEventProperties","track","unsetEventProperty"],o=0;o<p.length;o++)heap[p[o]]=n(p[o])};';

/**
 * The loader plus `heap.load` with `id` mapped and everything else forwarded
 * as the config object; the object is left off when there is nothing to pass,
 * as the install snippet prints it. Heap autocaptures history changes as
 * pageviews, so client-router navigations need no extra hook.
 */
export const heapHead = (options: HeapOptions): HeadScript[] => {
  const { id, ...config } = options;
  const load =
    Object.keys(config).length === 0
      ? `heap.load(${inlineJson(id)});`
      : `heap.load(${inlineJson(id)},${inlineJson(config)});`;
  return [{ attributes: {}, content: `${HEAP_LOADER}${load}` }];
};
