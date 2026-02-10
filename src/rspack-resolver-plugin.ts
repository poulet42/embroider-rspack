import { dirname, resolve } from "path";
import type {
  ModuleRequest,
  ResolverFunction,
  Resolution,
} from "@embroider/core";
import {
  Resolver as EmbroiderResolver,
  ResolverOptions as EmbroiderResolverOptions,
} from "@embroider/core";
import type { Compiler } from "@rspack/core";
import assertNever from "assert-never";
import makeDebug from "debug";
import escapeRegExp from "escape-string-regexp";

const debug = makeDebug("embroider:rspack-resolver");

export { EmbroiderResolverOptions as Options };

const virtualLoaderName = "embroider-rspack/src/virtual-loader";
const virtualLoaderPath = resolve(__dirname, "./virtual-loader.js");

// Type definitions for rspack's resolver
interface RspackResolver {
  resolve(
    context: object,
    path: string,
    request: string,
    resolveContext: object,
    callback: (err: Error | null, result?: string | false) => void,
  ): void;
}

interface NormalModuleFactory {
  getResolver(type: string): RspackResolver;
  hooks: {
    resolve: {
      tapAsync(
        options: { name: string; stage: number },
        callback: (state: unknown, callback: () => void) => void,
      ): void;
    };
  };
}

function isNormalModuleFactory(value: unknown): value is NormalModuleFactory {
  return (
    typeof value === "object" &&
    value !== null &&
    "getResolver" in value &&
    typeof value.getResolver === "function" &&
    "hooks" in value
  );
}

export class EmbroiderPlugin {
  #resolver: EmbroiderResolver;
  #babelLoaderPrefix: string;
  #appRoot: string;
  // Track context -> virtual module filename mappings
  // This helps us fix missing issuers for imports from virtual modules
  #virtualModuleContexts: Map<string, string> = new Map();

  constructor(opts: EmbroiderResolverOptions, babelLoaderPrefix: string) {
    this.#resolver = new EmbroiderResolver(opts);
    this.#babelLoaderPrefix = babelLoaderPrefix;
    this.#appRoot = opts.appRoot;
  }

  #addLoaderAlias(compiler: Compiler, name: string, alias: string) {
    let { resolveLoader } = compiler.options;
    if (Array.isArray(resolveLoader.alias)) {
      resolveLoader.alias.push({ name, alias });
    } else if (resolveLoader.alias) {
      resolveLoader.alias[name] = alias;
    } else {
      resolveLoader.alias = {
        [name]: alias,
      };
    }
  }

  apply(compiler: Compiler) {
    this.#addLoaderAlias(compiler, virtualLoaderName, virtualLoaderPath);

    // Rspack supports the same normalModuleFactory hook as webpack
    compiler.hooks.normalModuleFactory.tap(
      "embroider-rspack",
      (normalModuleFactory) => {
        // Create a fallback resolver that uses rspack's actual resolver
        let adaptedResolve = getAdaptedResolve(
          normalModuleFactory,
          this.#virtualModuleContexts,
        );

        normalModuleFactory.hooks.resolve.tapAsync(
          { name: "embroider-rspack", stage: 50 },
          (state: unknown, callback) => {
            let request = RspackModuleRequest.from(
              state,
              this.#babelLoaderPrefix,
              this.#appRoot,
              this.#virtualModuleContexts,
            );
            if (!request) {
              debug("No embroider request, passing through");
              callback();
              return;
            }

            debug("Resolving %s from %s", request.specifier, request.fromFile);

            this.#resolver.resolve(request, adaptedResolve).then(
              (resolution) => {
                switch (resolution.type) {
                  case "not_found":
                    // For implicit modules, replace with empty module (optional dependency)
                    // This handles cases where packages don't have these files - that's not an error
                    if (
                      request.specifier.includes(
                        "-embroider-implicit-modules",
                      ) ||
                      request.specifier.includes(
                        "-embroider-implicit-test-modules",
                      )
                    ) {
                      debug(
                        "Implicit modules not found for %s, replacing with empty module",
                        request.specifier,
                      );
                      // Replace with empty module by changing the request to resolve to nothing
                      request.state.request = `data:text/javascript,export default {};`;
                      callback(null);
                    } else {
                      debug(
                        "Embroider could not resolve %s, letting rspack try",
                        request.specifier,
                      );
                      // Don't pass the error - just let the normal resolution chain continue
                      callback();
                    }
                    break;
                  case "found":
                    // Rspack's resolve hook returns void; the state is modified in place
                    debug("Resolution succeeded for %s", request.specifier);
                    callback(null);
                    break;
                  default:
                    throw assertNever(resolution);
                }
              },
              (err) => {
                // For implicit modules, replace with empty module (transitive dependencies may not be resolvable from app root)
                if (
                  request.specifier.includes("-embroider-implicit-modules") ||
                  request.specifier.includes("-embroider-implicit-test-modules")
                ) {
                  debug(
                    "Implicit modules error for %s, replacing with empty module (likely transitive dependency): %O",
                    request.specifier,
                    err,
                  );
                  // Replace with empty module
                  request.state.request = `data:text/javascript,export default {};`;
                  callback(null);
                } else {
                  debug("Resolution error for %s: %O", request.specifier, err);
                  callback(err);
                }
              },
            );
          },
        );
      },
    );
  }
}

// This creates a fallback resolver for @embroider/core's resolver.
// We use rspack's enhanced-resolve to actually try to resolve modules.
// The fallback resolver receives the request state that may have been modified
// by the Embroider resolver (e.g., virtualized with loaders), and it needs to
// resolve that potentially modified request.
function getAdaptedResolve(
  normalModuleFactory: unknown,
  virtualModuleContexts: Map<string, string>,
): ResolverFunction<RspackModuleRequest, Resolution<null, null | Error>> {
  // Type guard to ensure normalModuleFactory has the expected shape
  if (!isNormalModuleFactory(normalModuleFactory)) {
    throw new Error("Invalid normalModuleFactory: missing required methods");
  }

  const factory = normalModuleFactory;

  return function (
    request: RspackModuleRequest,
  ): Promise<Resolution<null, null | Error>> {
    return new Promise((resolve) => {
      const context = dirname(request.fromFile);
      // Use the current state.request, which may have been modified by Embroider (e.g., virtualized)
      const requestToResolve = request.state.request;

      debug(
        "Fallback resolver attempting to resolve %s from %s",
        requestToResolve,
        context,
      );

      // If the request contains loader syntax (contains '!'), it's a loader request
      // and we should just accept it as-is, letting rspack's module loading handle it
      if (requestToResolve.includes("!")) {
        debug("Fallback resolver detected loader request, accepting as-is");

        // Track virtual modules by extracting the 'f' parameter from virtual-loader requests
        if (requestToResolve.includes(virtualLoaderName)) {
          // Extract query string specifically from virtual-loader part
          // Format: ...!embroider-rspack/src/virtual-loader?f=...&a=...!
          const virtualLoaderMatch = requestToResolve.match(
            new RegExp(escapeRegExp(virtualLoaderName) + "\\?([^!]+)"),
          );
          if (virtualLoaderMatch) {
            try {
              const params = new URLSearchParams(virtualLoaderMatch[1]);
              const filename = params.get("f");
              if (filename) {
                virtualModuleContexts.set(dirname(filename), filename);
                debug(
                  "Tracked virtual module from fallback: context=%s, filename=%s",
                  dirname(filename),
                  filename,
                );
              }
            } catch (e) {
              debug(
                "Failed to extract virtual module filename from %s",
                requestToResolve,
              );
            }
          }
        }

        resolve({
          type: "found",
          result: null,
        });
        return;
      }

      // For normal module requests, use rspack's resolver
      const resolver = factory.getResolver("normal");
      resolver.resolve(
        {},
        context,
        requestToResolve,
        {},
        (err: Error | null, result: string | false | undefined) => {
          if (err || !result) {
            debug(
              "Fallback resolver could not resolve %s: %O",
              requestToResolve,
              err,
            );
            resolve({
              type: "not_found",
              err: err || new Error(`Module not found: ${requestToResolve}`),
            });
          } else {
            debug(
              "Fallback resolver resolved %s to %s",
              requestToResolve,
              result,
            );
            resolve({
              type: "found",
              result: null,
            });
          }
        },
      );
    });
  };
}

class RspackModuleRequest implements ModuleRequest {
  readonly specifier: string;
  readonly fromFile: string;
  readonly meta: Record<string, any> | undefined;

  static from(
    state: any,
    babelLoaderPrefix: string,
    appRoot: string,
    virtualModuleContexts: Map<string, string>,
  ): RspackModuleRequest | undefined {
    // Basic validation
    if (
      typeof state.request !== "string" ||
      typeof state.context !== "string"
    ) {
      debug(
        "Skipping request - invalid state: request=%s, context=%s",
        typeof state.request,
        typeof state.context,
      );
      return undefined;
    }

    const issuer = state.contextInfo?.issuer || "";
    debug(
      "Request: %s, Context: %s, Issuer: %s",
      state.request,
      state.context,
      issuer,
    );

    // Track virtual module loads by detecting requests that include the virtual loader
    // This helps us know which virtual module is associated with each context
    if (state.request.includes(virtualLoaderName)) {
      // Extract the 'f' parameter which contains the virtual module filename
      const queryMatch = state.request.match(/\?([^!]+)/);
      if (queryMatch) {
        try {
          const params = new URLSearchParams(queryMatch[1]);
          const filename = params.get("f");
          if (filename) {
            virtualModuleContexts.set(dirname(filename), filename);
            debug(
              "Tracked virtual module: context=%s, filename=%s",
              dirname(filename),
              filename,
            );
          }
        } catch (e) {
          debug(
            "Failed to extract virtual module filename from %s",
            state.request,
          );
        }
      }
      // Let this request pass through - we don't want to handle the virtual loader request itself
      debug("Skipping virtual loader request");
      return undefined;
    }

    // Prevent recursion on loader requests
    if (state.request.startsWith("!")) {
      debug("Skipping loader request");
      return undefined;
    }

    // Fix issuers for imports from virtual modules
    // Rspack doesn't set the issuer correctly for imports from virtual modules
    // We need to check this FIRST, even if an issuer is already set, because rspack
    // might set it to the wrong location (e.g., app root instead of package directory)

    // Try to find a tracked virtual module for this context
    let foundVirtualModule: string | undefined;

    // First, try exact context lookup
    foundVirtualModule = virtualModuleContexts.get(state.context);
    if (foundVirtualModule) {
      debug(
        "Found virtual module by exact context lookup: %s",
        foundVirtualModule,
      );
    }

    if (!foundVirtualModule) {
      debug(
        "No exact context match for %s, searching through %d tracked virtual modules",
        state.context,
        virtualModuleContexts.size,
      );
      // If exact lookup fails, iterate all tracked virtual modules to find one in the same context
      // This handles cases where the context path might be slightly different or virtual modules
      // that share the same directory
      for (let filename of virtualModuleContexts.values()) {
        if (dirname(filename) === state.context) {
          foundVirtualModule = filename;
          debug("Found tracked virtual module in same context: %s", filename);
          break;
        }
      }
      if (!foundVirtualModule) {
        debug("No virtual module found for context %s", state.context);
      }
    }

    if (foundVirtualModule) {
      // Fix issuer to point to the virtual module, even if issuer is already set
      debug(
        "Found virtual module for context %s: %s",
        state.context,
        foundVirtualModule,
      );
      if (!state.contextInfo) {
        state.contextInfo = { issuer: "" };
      }
      if (state.contextInfo.issuer !== foundVirtualModule) {
        debug(
          "Fixing issuer from %s to %s for request %s",
          state.contextInfo.issuer,
          foundVirtualModule,
          state.request,
        );
        state.contextInfo.issuer = foundVirtualModule;
      }
    } else if (!state.contextInfo?.issuer || state.contextInfo.issuer === "") {
      // Only if we don't have a tracked virtual module AND issuer is empty,
      // try constructing the issuer path for rewritten packages
      debug("Empty issuer detected for request: %s", state.request);

      if (
        state.context.includes("/rewritten-packages/") ||
        state.context.includes("/rewritten-app")
      ) {
        // Fallback: construct implicit modules path
        const implicitModulesPath =
          state.context + "/-embroider-implicit-modules.js";
        if (!state.contextInfo) {
          state.contextInfo = { issuer: "" };
        }
        state.contextInfo.issuer = implicitModulesPath;
        debug(
          "Using constructed issuer %s for request %s from context %s",
          implicitModulesPath,
          state.request,
          state.context,
        );
      } else {
        // Not a virtual module import - let rspack handle it
        debug(
          "No virtual module found, letting rspack handle request: %s",
          state.request,
        );
        return undefined;
      }
    }

    // Only proceed if we have a valid issuer (either original or fixed)
    // OR if this is an implicit modules request (which can have empty issuer)
    const hasValidIssuer =
      typeof state.contextInfo?.issuer === "string" &&
      state.contextInfo.issuer !== "";
    const isImplicitModulesRequest = state.request.includes(
      "-embroider-implicit-",
    );

    if (
      typeof state.request === "string" &&
      typeof state.context === "string" &&
      (hasValidIssuer || isImplicitModulesRequest)
    ) {
      const issuerDisplay =
        state.contextInfo?.issuer || "(empty for implicit modules)";
      debug(
        "Creating RspackModuleRequest for %s from %s",
        state.request,
        issuerDisplay,
      );
      return new RspackModuleRequest(babelLoaderPrefix, appRoot, state);
    }

    // Fallback: let rspack handle it
    debug("Fallback: letting rspack handle request %s", state.request);
    return undefined;
  }

  constructor(
    private babelLoaderPrefix: string,
    private appRoot: string,
    public state: {
      request: string;
      context: string;
      contextInfo: {
        issuer: string;
        _embroiderMeta?: Record<string, any> | undefined;
      };
    },
    public isVirtual = false,
  ) {
    // these get copied here because we mutate the underlying state as we
    // convert one request into the next, and it seems better for debuggability
    // if the fields on the previous request don't change when you make a new
    // one (although it is true that only the newest one has a a valid `state`
    // that can actually be handed back to rspack)
    this.specifier = state.request;
    this.fromFile = state.contextInfo.issuer;
    this.meta = state.contextInfo._embroiderMeta
      ? { ...state.contextInfo._embroiderMeta }
      : undefined;
  }

  alias(newSpecifier: string) {
    this.state.request = newSpecifier;
    return new RspackModuleRequest(
      this.babelLoaderPrefix,
      this.appRoot,
      this.state,
    ) as this;
  }
  rehome(newFromFile: string) {
    if (this.fromFile === newFromFile) {
      return this;
    } else {
      this.state.contextInfo.issuer = newFromFile;
      this.state.context = dirname(newFromFile);
      return new RspackModuleRequest(
        this.babelLoaderPrefix,
        this.appRoot,
        this.state,
      ) as this;
    }
  }
  virtualize(filename: string) {
    let params = new URLSearchParams();
    params.set("f", filename);
    params.set("a", this.appRoot);
    let next = this.alias(
      `${this.babelLoaderPrefix}${virtualLoaderName}?${params.toString()}!`,
    );
    next.isVirtual = true;
    return next;
  }
  withMeta(meta: Record<string, any> | undefined): this {
    this.state.contextInfo._embroiderMeta = meta;
    return new RspackModuleRequest(
      this.babelLoaderPrefix,
      this.appRoot,
      this.state,
    ) as this;
  }
}
