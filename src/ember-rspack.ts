/*
  Most of the work this module does is putting an HTML-oriented facade around
  Rspack. That is, we want both the input and output to be primarily HTML files
  with proper spec semantics, and we use rspack to optimize the assets referred
  to by those files.

  While there are webpack/rspack plugins for handling HTML, none of them handle
  multiple HTML entrypoints and apply correct HTML semantics (for example,
  getting script vs module context correct).
*/

import type {
  AppMeta,
  BundleSummary,
  Packager,
  PackagerConstructor,
  Variant,
  ResolverOptions,
} from "@embroider/core";
import {
  HTMLEntrypoint,
  getAppMeta,
  getPackagerCacheDir,
  getOrCreate,
} from "@embroider/core";
import {
  locateEmbroiderWorkingDir,
  RewrittenPackageCache,
  tmpdir,
} from "@embroider/shared-internals";
import type {
  Configuration,
  RuleSetUseItem,
  RspackPluginInstance,
  MultiStats,
  Stats as RspackStats,
  StatsChunk,
} from "@rspack/core";
import rspack from "@rspack/core";
import type { Stats as FsStats } from "fs-extra";
import {
  readFileSync,
  outputFileSync,
  copySync,
  statSync,
  readdirSync,
  readJSONSync,
} from "fs-extra";
import { join, dirname, relative, sep } from "path";
import isEqual from "lodash/isEqual";
import mergeWith from "lodash/mergeWith";
import flatMap from "lodash/flatMap";
import makeDebug from "debug";
import { format } from "util";
import type { Options, BabelLoaderOptions } from "./options";
import crypto from "crypto";
import supportsColor from "supports-color";
import type { Options as HbsLoaderOptions } from "@embroider/hbs-loader";
import type { Options as EmbroiderPluginOptions } from "./rspack-resolver-plugin";
import { EmbroiderPlugin } from "./rspack-resolver-plugin";

const debug = makeDebug("embroider:debug");

// This is a type-only import, so it gets compiled away. At runtime, we load
// terser lazily so it's only loaded for production builds that use it. Don't
// add any non-type-only imports here.
import type { MinifyOptions } from "terser";

interface AppInfo {
  entrypoints: HTMLEntrypoint[];
  otherAssets: string[];
  babel: AppMeta["babel"];
  rootURL: AppMeta["root-url"];
  publicAssetURL: string;
  resolverConfig: ResolverOptions;
  packageName: string;
}

// AppInfos are equal if they result in the same rspack config.
function equalAppInfo(left: AppInfo, right: AppInfo): boolean {
  return (
    isEqual(left.babel, right.babel) &&
    left.entrypoints.length === right.entrypoints.length &&
    left.entrypoints.every((e, index) =>
      isEqual(e.modules, right.entrypoints[index].modules),
    )
  );
}

import type { MultiCompiler } from "@rspack/core";
type MultiWatching = ReturnType<MultiCompiler["watch"]>;

// we want to ensure that not only does our instance conform to
// PackagerInstance, but our constructor conforms to Packager. So instead of
// just exporting our class directly, we export a const constructor of the
// correct type.
const Rspack: PackagerConstructor<Options> = class Rspack implements Packager {
  static annotation = "embroider-rspack";

  private pathToVanillaApp: string;
  private extraConfig: Configuration | undefined;
  private passthroughCache: Map<string, FsStats> = new Map();
  private publicAssetURL: string | undefined;
  private extraBabelLoaderOptions: BabelLoaderOptions | undefined;
  private extraCssLoaderOptions: object | undefined;
  private extraCssPluginOptions: object | undefined;
  private extraStyleLoaderOptions: object | undefined;
  private _bundleSummary: BundleSummary | undefined;

  // Watch-mode state. The watcher runs freely — rspack detects file changes via
  // its own watchpack integration. build() waits for the next completed build.
  private watcher: MultiWatching | undefined;
  private lastAppInfo: AppInfo | undefined;
  // Monotonically increasing counter: incremented each time a successful build
  // is fully written to disk. build() compares against lastSeenCount to decide
  // whether to wait or return immediately.
  private buildCompletionCount = 0;
  private lastSeenCompletionCount = 0;
  private pendingBuildResolvers: Array<{
    resolve: () => void;
    reject: (e: unknown) => void;
  }> = [];
  // Timestamp (ms) when the last successful handleBuildComplete callback fired.
  // Used to detect which files in pathToVanillaApp changed since then.
  private lastBuildTime = 0;

  constructor(
    private appRoot: string,
    private outputPath: string,
    private variants: Variant[],
    private consoleWrite: (msg: string) => void,
    options?: Options,
  ) {
    // Note: rspack.version returns webpack compatibility version (5.x), not rspack version (1.x)
    // The peerDependency on @rspack/core already enforces the correct version

    let packageCache = RewrittenPackageCache.shared("embroider", appRoot);
    this.pathToVanillaApp = packageCache.maybeMoved(
      packageCache.get(appRoot),
    ).root;
    this.extraConfig = options?.webpackConfig;
    this.publicAssetURL = options?.publicAssetURL;
    this.extraBabelLoaderOptions = options?.babelLoaderOptions;
    this.extraCssLoaderOptions = options?.cssLoaderOptions;
    this.extraCssPluginOptions = options?.cssPluginOptions;
    this.extraStyleLoaderOptions = options?.styleLoaderOptions;
  }

  get bundleSummary(): BundleSummary {
    let bundleSummary = this._bundleSummary;
    if (bundleSummary === undefined) {
      this._bundleSummary = bundleSummary = {
        entrypoints: new Map(),
        lazyBundles: new Map(),
        variants: this.variants,
      };
    }
    return bundleSummary;
  }

  async build(): Promise<void> {
    debug("Starting rspack build");
    let appInfo = this.examineApp();
    this.ensureWatcher(appInfo);

    // If a build has completed since we last returned from build(), the output
    // is already fresh — return immediately.
    if (this.buildCompletionCount > this.lastSeenCompletionCount) {
      this.lastSeenCompletionCount = this.buildCompletionCount;
      debug("Rspack build already complete, returning immediately");
      return;
    }

    // Otherwise wait for the next completed build.
    debug(`build() waiting: buildCompletionCount=${this.buildCompletionCount} lastSeen=${this.lastSeenCompletionCount}`);
    const waiting = new Promise<void>((resolve, reject) => {
      this.pendingBuildResolvers.push({ resolve, reject });
    }).then(() => {
      this.lastSeenCompletionCount = this.buildCompletionCount;
      debug("Rspack build complete");
    });
    // Explicitly kick off a rebuild. rspack's watchpack `aggregated` event can
    // miss the window between builds (it uses `once`). We scan pathToVanillaApp
    // for files newer than the last build and pass them explicitly so rspack's
    // Rust core knows which modules to recompile (empty modifiedFiles = cache hit).
    // Skip for the very first build: processQueueWorker auto-starts it.
    if (this.buildCompletionCount > 0) {
      const changedFiles = this.findChangedFiles(this.lastBuildTime);
      debug(`build() found ${changedFiles.size} changed file(s) since last build`);
      this.watcher!.invalidateWithChangesAndRemovals(changedFiles, new Set());
    }
    return waiting;
  }

  private ensureWatcher(appInfo: AppInfo): void {
    if (
      this.watcher &&
      this.lastAppInfo &&
      equalAppInfo(appInfo, this.lastAppInfo)
    ) {
      debug("reusing rspack compiler");
      // Update lastAppInfo so writeAllFiles uses the latest entrypoints/HTML
      this.lastAppInfo = appInfo;
      return;
    }

    debug("configuring new rspack compiler");
    if (this.watcher) {
      this.watcher.close(() => {});
      this.watcher = undefined;
    }

    this.lastAppInfo = appInfo;
    // Ensure the next build() call waits for this new compiler's first build.
    this.lastSeenCompletionCount = this.buildCompletionCount;

    let config = this.variants.map((variant, variantIndex) =>
      mergeWith(
        {},
        this.configureRspack(appInfo, variant, variantIndex),
        this.extraConfig,
        appendArrays,
      ),
    );
    let compiler = rspack(config);
    this.watcher = compiler.watch({}, (err, stats) =>
      this.handleBuildComplete(err, stats),
    );
  }

  private examineApp(): AppInfo {
    let meta = getAppMeta(this.pathToVanillaApp);
    let rootURL = meta["ember-addon"]["root-url"];
    let babel = meta["ember-addon"]["babel"];
    let entrypoints = [];
    let otherAssets = [];
    let publicAssetURL = this.publicAssetURL || rootURL;

    for (let relativePath of meta["ember-addon"].assets) {
      if (/\.html/i.test(relativePath)) {
        entrypoints.push(
          new HTMLEntrypoint(
            this.pathToVanillaApp,
            rootURL,
            publicAssetURL,
            relativePath,
          ),
        );
      } else {
        otherAssets.push(relativePath);
      }
    }

    let resolverConfig: EmbroiderPluginOptions = readJSONSync(
      join(locateEmbroiderWorkingDir(this.appRoot), "resolver.json"),
    );

    return {
      entrypoints,
      otherAssets,
      babel,
      rootURL,
      resolverConfig,
      publicAssetURL,
      packageName: meta.name,
    };
  }

  private configureRspack(
    appInfo: AppInfo,
    variant: Variant,
    _variantIndex: number,
  ): Configuration {
    const { entrypoints, babel, publicAssetURL, packageName, resolverConfig } =
      appInfo;

    let entry: { [name: string]: string } = {};
    for (let entrypoint of entrypoints) {
      for (let moduleName of entrypoint.modules) {
        entry[moduleName] = "./" + moduleName;
      }
    }

    let { plugins: stylePlugins, loaders: styleLoaders } =
      this.setupStyleConfig(variant);

    let babelLoaderOptions = makeBabelLoaderOptions(
      babel.majorVersion,
      variant,
      join(this.pathToVanillaApp, babel.filename),
      this.extraBabelLoaderOptions,
    );

    let babelLoaderPrefix = `babel-loader-9?${JSON.stringify(babelLoaderOptions.options)}!`;

    return {
      mode: variant.optimizeForProduction ? "production" : "development",
      context: this.pathToVanillaApp,
      entry,
      performance: {
        hints: false,
      },
      plugins: [
        ...stylePlugins,
        new EmbroiderPlugin(resolverConfig, babelLoaderPrefix),
      ],
      node: false,
      module: {
        rules: [
          {
            test: /\.hbs$/,
            use: nonNullArray([
              babelLoaderOptions,
              {
                loader: require.resolve("@embroider/hbs-loader"),
                options: (() => {
                  let options: HbsLoaderOptions = {
                    compatModuleNaming: {
                      rootDir: this.pathToVanillaApp,
                      modulePrefix: packageName,
                    },
                  };
                  return options;
                })(),
              },
            ]),
          },
          {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            test: require(join(this.pathToVanillaApp, babel.fileFilter)),
            use: nonNullArray([
              makeBabelLoaderOptions(
                babel.majorVersion,
                variant,
                join(this.pathToVanillaApp, babel.filename),
                this.extraBabelLoaderOptions,
              ),
            ]),
          },
          {
            test: isCSS,
            use: styleLoaders,
          },
        ],
      },
      output: {
        path: join(this.outputPath),
        filename: `assets/chunk.[chunkhash].js`,
        chunkFilename: `assets/chunk.[chunkhash].js`,
        publicPath: publicAssetURL,
      },
      optimization: {
        splitChunks: {
          chunks: "all",
        },
      },
      resolve: {
        extensions: resolverConfig.resolvableExtensions,
        // Allow fallback to mainFields when exports field doesn't have the requested subpath
        // This is needed for Embroider's virtual files like -embroider-implicit-test-modules.js
        mainFields: ["browser", "module", "main"],
        // For browser builds, prefer browser conditions over node
        // conditionNames: ['browser', 'import', 'require', 'default'],
      },
      resolveLoader: {
        alias: {
          // these loaders are our dependencies, not the app's dependencies. I'm
          // not overriding the default loader resolution rules in case the app also
          // wants to control those.
          "babel-loader-9": require.resolve("@embroider/babel-loader-9"),
          "css-loader": require.resolve("css-loader"),
          "style-loader": require.resolve("style-loader"),
        },
      },
    };
  }

  private handleBuildCallCount = 0;

  private handleBuildComplete(
    err: Error | null | undefined,
    stats: MultiStats | undefined,
  ): void {
    const callN = ++this.handleBuildCallCount;
    debug(`handleBuildComplete #${callN} called, pendingResolvers=${this.pendingBuildResolvers.length}`);
    this._bundleSummary = undefined;

    if (err) {
      debug(`handleBuildComplete #${callN} error: ${err.message}`);
      if (stats) {
        this.consoleWrite(stats.toString({}));
      }
      for (const { reject } of this.pendingBuildResolvers.splice(0)) reject(err);
      return;
    }
    if (!stats) {
      const e = new Error("bug: no stats and no err");
      debug(`handleBuildComplete #${callN} bug: no stats`);
      for (const { reject } of this.pendingBuildResolvers.splice(0)) reject(e);
      return;
    }
    if (stats.hasErrors()) {
      this.consoleWrite(
        stats.toString({
          colors: Boolean(supportsColor.stdout),
        }),
      );
      const e = this.findBestError(
        flatMap((stats as any).stats, (s) => s.compilation.errors),
      );
      debug(`handleBuildComplete #${callN} build errors`);
      for (const { reject } of this.pendingBuildResolvers.splice(0)) reject(e);
      return;
    }
    if (stats.hasWarnings() || process.env.VANILLA_VERBOSE) {
      this.consoleWrite(
        stats.toString({
          colors: Boolean(supportsColor.stdout),
        }),
      );
    }

    let allStats: RspackStats[] = (stats as any).stats;
    for (let [i, variantStats] of allStats.entries()) {
      this.summarizeStats(variantStats, this.variants[i]!, i);
    }

    // Capture bundleSummary now before any async work; splice resolvers AFTER
    // writeAllFiles so that any build() calls made during the write are also resolved.
    const bundleSummary = this.bundleSummary;
    debug(`handleBuildComplete #${callN} starting writeAllFiles`);
    this.writeAllFiles(bundleSummary, this.lastAppInfo!).then(
      () => {
        debug(`handleBuildComplete #${callN} writeAllFiles done, resolving ${this.pendingBuildResolvers.length} resolver(s)`);
        this.lastBuildTime = Date.now();
        this.buildCompletionCount++;
        for (const { resolve } of this.pendingBuildResolvers.splice(0)) resolve();
      },
      (e) => {
        debug(`handleBuildComplete #${callN} writeAllFiles error: ${e.message}`);
        for (const { reject } of this.pendingBuildResolvers.splice(0)) reject(e);
      },
    );
  }

  private findChangedFiles(since: number): Set<string> {
    const changed = new Set<string>();
    const scan = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(full);
        } else {
          try {
            if (statSync(full).mtimeMs > since) changed.add(full);
          } catch {
            // ignore stat errors (e.g. symlink targets that disappeared)
          }
        }
      }
    };
    scan(this.pathToVanillaApp);
    return changed;
  }

  private async writeScript(
    script: string,
    written: Set<string>,
    variant: Variant,
  ) {
    if (!variant.optimizeForProduction) {
      this.copyThrough(script);
      return script;
    }

    // loading these lazily here so they never load in non-production builds.
    // The node cache will ensures we only load them once.
    const [Terser, srcURL] = await Promise.all([
      import("terser"),
      import("source-map-url"),
    ]);

    let inCode = readFileSync(join(this.pathToVanillaApp, script), "utf8");
    let terserOpts: MinifyOptions = {};
    let fileRelativeSourceMapURL;
    let appRelativeSourceMapURL;
    if (srcURL.default.existsIn(inCode)) {
      fileRelativeSourceMapURL = srcURL.default.getFrom(inCode)!;
      appRelativeSourceMapURL = join(dirname(script), fileRelativeSourceMapURL);
      let content;
      try {
        content = readJSONSync(
          join(this.pathToVanillaApp, appRelativeSourceMapURL),
        );
      } catch (err) {
        // the script refers to a sourcemap that doesn't exist, so we just leave
        // the map out.
      }
      if (content) {
        terserOpts.sourceMap = { content, url: fileRelativeSourceMapURL };
      }
    }
    let { code: outCode, map: outMap } = await Terser.default.minify(
      inCode,
      terserOpts,
    );
    let finalFilename = this.getFingerprintedFilename(script, outCode!);
    outputFileSync(join(this.outputPath, finalFilename), outCode!);
    written.add(script);
    if (appRelativeSourceMapURL && outMap) {
      outputFileSync(join(this.outputPath, appRelativeSourceMapURL), outMap);
      written.add(appRelativeSourceMapURL);
    }
    return finalFilename;
  }

  private async writeStyle(
    style: string,
    written: Set<string>,
    variant: Variant,
  ) {
    if (!variant.optimizeForProduction) {
      this.copyThrough(style);
      written.add(style);
      return style;
    }

    const csso = await import("csso");
    const cssContent = readFileSync(join(this.pathToVanillaApp, style), "utf8");
    const minifiedCss = csso.minify(cssContent).css;

    let finalFilename = this.getFingerprintedFilename(style, minifiedCss);
    outputFileSync(join(this.outputPath, finalFilename), minifiedCss);
    written.add(style);
    return finalFilename;
  }

  private async provideErrorContext(
    message: string,
    messageParams: any[],
    fn: () => Promise<void>,
  ) {
    try {
      return await fn();
    } catch (err) {
      let context = format(message, ...messageParams);
      err.message = context + ": " + err.message;
      throw err;
    }
  }

  private async writeAllFiles(
    stats: BundleSummary,
    { entrypoints, otherAssets }: AppInfo,
  ) {
    // we're doing this ourselves because I haven't seen a webpack 4 HTML plugin
    // that handles multiple HTML entrypoints correctly.

    let written: Set<string> = new Set();
    // scripts (as opposed to modules) and stylesheets (as opposed to CSS
    // modules that are imported from JS modules) get passed through without
    // going through rspack.
    for (let entrypoint of entrypoints) {
      await this.provideErrorContext(
        "needed by %s",
        [entrypoint.filename],
        async () => {
          for (let script of entrypoint.scripts) {
            if (!stats.entrypoints.has(script)) {
              const mapping = [] as string[];
              try {
                // zero here means we always attribute passthrough scripts to the
                // first build variant
                stats.entrypoints.set(script, new Map([[0, mapping]]));
                mapping.push(
                  await this.writeScript(script, written, this.variants[0]),
                );
              } catch (err) {
                if (
                  err.code === "ENOENT" &&
                  err.path === join(this.pathToVanillaApp, script)
                ) {
                  this.consoleWrite(
                    `warning: in ${entrypoint.filename} <script src="${script
                      .split(sep)
                      .join(
                        "/",
                      )}"> does not exist on disk. If this is intentional, use a data-embroider-ignore attribute.`,
                  );
                } else {
                  throw err;
                }
              }
            }
          }
          for (let style of entrypoint.styles) {
            if (!stats.entrypoints.has(style)) {
              const mapping = [] as string[];
              try {
                // zero here means we always attribute passthrough styles to the
                // first build variant
                stats.entrypoints.set(style, new Map([[0, mapping]]));
                mapping.push(
                  await this.writeStyle(style, written, this.variants[0]),
                );
              } catch (err) {
                if (
                  err.code === "ENOENT" &&
                  err.path === join(this.pathToVanillaApp, style)
                ) {
                  this.consoleWrite(
                    `warning: in ${entrypoint.filename}  <link rel="stylesheet" href="${style
                      .split(sep)
                      .join(
                        "/",
                      )}"> does not exist on disk. If this is intentional, use a data-embroider-ignore attribute.`,
                  );
                } else {
                  throw err;
                }
              }
            }
          }
        },
      );
    }

    for (let entrypoint of entrypoints) {
      this.writeIfChanged(
        join(this.outputPath, entrypoint.filename),
        entrypoint.render(stats),
      );
      written.add(entrypoint.filename);
    }

    for (let relativePath of otherAssets) {
      if (!written.has(relativePath)) {
        written.add(relativePath);
        await this.provideErrorContext(
          `while copying app's assets`,
          [],
          async () => {
            this.copyThrough(relativePath);
          },
        );
      }
    }
  }

  private lastContents = new Map<string, string>();

  // The point of this caching isn't really performance (we generate the
  // contents either way, and the actual write is unlikely to be expensive).
  // It's helping ember-cli's traditional livereload system to avoid triggering
  // a full page reload when that wasn't really necessary.
  private writeIfChanged(filename: string, content: string) {
    if (this.lastContents.get(filename) !== content) {
      outputFileSync(filename, content, "utf8");
      this.lastContents.set(filename, content);
    }
  }

  private copyThrough(relativePath: string) {
    let sourcePath = join(this.pathToVanillaApp, relativePath);
    let newStats = statSync(sourcePath);
    let oldStats = this.passthroughCache.get(sourcePath);
    if (
      !oldStats ||
      oldStats.mtimeMs !== newStats.mtimeMs ||
      oldStats.size !== newStats.size
    ) {
      debug(`emitting ${relativePath}`);
      copySync(sourcePath, join(this.outputPath, relativePath));
      this.passthroughCache.set(sourcePath, newStats);
    }
  }

  private getFingerprintedFilename(filename: string, content: string): string {
    let md5 = crypto.createHash("md5");
    md5.update(content);
    let hash = md5.digest("hex");

    let fileParts = filename.split(".");
    fileParts.splice(fileParts.length - 1, 0, hash);
    return fileParts.join(".");
  }

  private summarizeStats(
    stats: RspackStats,
    variant: Variant,
    variantIndex: number,
  ): void {
    let output = this.bundleSummary;
    let { entrypoints, chunks } = stats.toJson({
      all: false,
      entrypoints: true,
      chunks: true,
    });

    // rspack's types are written rather loosely, implying that these two
    // properties may not be present. They really always are, as far as I can
    // tell, but we need to check here anyway to satisfy the type checker.
    if (!entrypoints) {
      throw new Error(`unexpected rspack output: no entrypoints`);
    }
    if (!chunks) {
      throw new Error(`unexpected rspack output: no chunks`);
    }

    for (let id of Object.keys(entrypoints)) {
      let { assets: entrypointAssets } = entrypoints[id];
      if (!entrypointAssets) {
        throw new Error(`unexpected rspack output: no entrypoint.assets`);
      }

      getOrCreate(output.entrypoints, id, () => new Map()).set(
        variantIndex,
        entrypointAssets.map((asset) => asset.name),
      );
      if (variant.runtime !== "browser") {
        // in the browser we don't need to worry about lazy assets (they will be
        // handled automatically by rspack as needed), but in any other runtime
        // we need the ability to preload them
        output.lazyBundles.set(
          id,
          flatMap(
            chunks.filter((chunk: StatsChunk) => chunk.runtime?.includes(id)),
            (chunk: StatsChunk) => chunk.files,
          ).filter(
            (file) => !entrypointAssets?.find((a) => a.name === file),
          ) as string[],
        );
      }
    }
  }

  private setupStyleConfig(variant: Variant): {
    loaders: RuleSetUseItem[];
    plugins: RspackPluginInstance[];
  } {
    let cssLoader = {
      loader: "css-loader",
      options: {
        url: true,
        import: true,
        modules: "global",
        ...this.extraCssLoaderOptions,
      },
    };

    if (!variant.optimizeForProduction && variant.runtime === "browser") {
      // in development builds that only need to work in the browser (not
      // fastboot), we can use style-loader because it's fast
      return {
        loaders: [
          {
            loader: "style-loader",
            options: {
              injectType: "styleTag",
              ...this.extraStyleLoaderOptions,
            },
          },
          cssLoader,
        ],
        plugins: [],
      };
    } else {
      // in any other build, we separate the CSS into its own bundles
      return {
        loaders: [rspack.CssExtractRspackPlugin.loader, cssLoader],
        plugins: [
          new rspack.CssExtractRspackPlugin({
            filename: `assets/chunk.[chunkhash].css`,
            chunkFilename: `assets/chunk.[chunkhash].css`,
            // in the browser, CssExtractRspackPlugin can manage it's own runtime
            // lazy loading of stylesheets.
            //
            // but in fastboot, we need to disable that in favor of doing our
            // own insertion of `<link>` tags in the HTML
            runtime: variant.runtime === "browser",
            // It's not reasonable to make assumptions about order when doing CSS via modules
            ignoreOrder: true,
            ...this.extraCssPluginOptions,
          }),
        ],
      };
    }
  }

  private findBestError(errors: any[]) {
    let error = errors[0];
    let file;
    if (error.module?.userRequest) {
      file = relative(this.pathToVanillaApp, error.module.userRequest);
    }

    if (!error.file) {
      error.file =
        file ||
        (error.loc ? error.loc.file : null) ||
        (error.location ? error.location.file : null);
    }
    if (error.line == null) {
      error.line =
        (error.loc ? error.loc.line : null) ||
        (error.location ? error.location.line : null);
    }
    if (typeof error.message === "string") {
      if (error.module?.context) {
        error.message = error.message.replace(
          error.module.context,
          error.module.userRequest,
        );
      }

      // the tmpdir on OSX is horribly long and makes error messages hard to
      // read. This is doing the same as String.prototype.replaceAll, which node
      // doesn't have yet.
      error.message = error.message.split(tmpdir).join("$TMPDIR");
    }
    return error;
  }
};

function appendArrays(objValue: any, srcValue: any) {
  if (Array.isArray(objValue)) {
    return objValue.concat(srcValue);
  }
}

function isCSS(filename: string) {
  return /\.css$/i.test(filename);
}

// typescript doesn't understand that regular use of array.filter(Boolean) does
// this.
function nonNullArray<T>(array: T[]): NonNullable<T>[] {
  return array.filter(Boolean) as NonNullable<T>[];
}

function makeBabelLoaderOptions(
  _majorVersion: 7,
  variant: Variant,
  appBabelConfigPath: string,
  extraOptions: BabelLoaderOptions | undefined,
) {
  const cacheDirectory = getPackagerCacheDir("rspack-babel-loader");
  const options: BabelLoaderOptions & {
    variant: Variant;
    appBabelConfigPath: string;
  } = {
    variant,
    appBabelConfigPath,
    cacheDirectory,
    ...extraOptions,
  };
  return {
    loader: "babel-loader-9",
    options,
  };
}

export { Rspack };
