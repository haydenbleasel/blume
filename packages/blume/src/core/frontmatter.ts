import baseMatter from "gray-matter";
import { dump, load } from "js-yaml";

// gray-matter@4 binds js-yaml 3's `safeLoad`/`safeDump` as its default YAML
// engine. In a workspace that pins js-yaml to v4 — where those functions were
// removed — parsing front matter throws "Function yaml.safeLoad is removed in
// js-yaml 4." Every Blume front-matter call routes through this `matter`
// wrapper, which supplies an explicit engine built on `load`/`dump`. Both exist
// in js-yaml 3 and 4, so Blume is immune to whichever version the consumer's
// install resolves for gray-matter.

type MatterInput = Parameters<typeof baseMatter>[0];
type MatterOptions = Parameters<typeof baseMatter>[1];
type ReadArgs = Parameters<typeof baseMatter.read>;
type StringifyArgs = Parameters<typeof baseMatter.stringify>;

const yamlEngine = {
  parse: (input: string): object => (load(input) ?? {}) as object,
  stringify: (data: object): string => dump(data),
};

const withYamlEngine = <O>(options: O): O =>
  ({
    ...options,
    engines: {
      yaml: yamlEngine,
      ...(options as { engines?: object })?.engines,
    },
  }) as O;

// Every helper that parses or emits YAML (`read`, `stringify`) must be
// re-wrapped here — Object.assign copies gray-matter's own helpers, which use
// its default `safeLoad` engine and would reintroduce the crash. `test` only
// checks for a delimiter, so the copied original is safe.
const matter = Object.assign(
  (input: MatterInput, options?: MatterOptions) =>
    baseMatter(input, withYamlEngine(options)),
  baseMatter,
  {
    read: (filepath: ReadArgs[0], options?: ReadArgs[1]) =>
      baseMatter.read(filepath, withYamlEngine(options)),
    stringify: (
      file: StringifyArgs[0],
      data: StringifyArgs[1],
      options?: StringifyArgs[2]
    ): string => baseMatter.stringify(file, data, withYamlEngine(options)),
  }
);

export default matter;
