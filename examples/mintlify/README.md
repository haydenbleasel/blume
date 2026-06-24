# Blume Starter Kit

Use the starter kit to get your docs deployed and ready to customize.

The fixture mirrors the Mintlify starter layout with Blume branding. It is intended to test whether a Mintlify project runs after swapping the docs dependency and CLI command to Blume.

## Compatibility status

This fixture passes with Blume out of the box through the Mintlify-compatible
`mint` alias.

```bash
bun --filter @blume-examples/mintlify build
bun --filter @blume-examples/mintlify dev
```

The build reads `docs.json`, discovers root-level MDX pages, applies the Blume default theme, renders Mintlify-style MDX components, and serves root-level static assets such as `favicon.svg` and `logo/`.

## Development

Run the following command at the root of your documentation, where your `docs.json` is located:

```bash
mint dev
```

View your local preview at `http://localhost:4323`.

Blume's `mint` alias supports local `dev`, `build`, and `preview` for existing
Mintlify projects. Hosted platform and quality commands such as
`mint broken-links` are intentionally out of scope for this fixture.
