import { ResolverLoader, virtualContent } from "@embroider/core";
import type { LoaderContext } from "@rspack/core";

let resolverLoader: ResolverLoader | undefined;

function setup(appRoot: string): ResolverLoader {
  if (resolverLoader?.appRoot !== appRoot) {
    resolverLoader = new ResolverLoader(appRoot);
  }
  return resolverLoader;
}

export default function virtualLoader(this: LoaderContext<unknown>) {
  if (typeof this.query === "string" && this.query[0] === "?") {
    let params = new URLSearchParams(this.query);
    let filename = params.get("f");
    let appRoot = params.get("a");
    if (!filename || !appRoot) {
      throw new Error(
        `bug in embroider-rspack virtual loader, cannot locate params in ${this.query}`,
      );
    }
    let { resolver } = setup(appRoot);
    this.resourcePath = filename;
    try {
      return virtualContent(filename, resolver);
    } catch (err) {
      // v1 addons that weren't rewritten by Embroider resolve to their original
      // pnpm location, where isV2Ember() is false. Returning empty content is
      // correct: unrewritten v1 packages have no v2 implicit modules to emit.
      if (
        filename.includes("-embroider-implicit-") &&
        err instanceof Error &&
        err.message.includes("non-ember package")
      ) {
        return "";
      }
      throw err;
    }
  }
  throw new Error(
    `embroider-rspack/src/virtual-loader received unexpected request: ${this.query}`,
  );
}
