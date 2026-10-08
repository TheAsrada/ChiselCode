import { basename, extname } from "node:path";

export interface LspLanguage {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly filenames?: readonly string[];
}
export type LspInstallation =
  | { readonly type: "bundled" }
  | {
      readonly type: "npm";
      readonly package: string;
      readonly entry: string;
      readonly args?: readonly string[];
    }
  | {
      readonly type: "release";
      readonly repository: string;
      readonly assets: Readonly<Record<string, string>>;
      readonly executable: string;
      readonly args?: readonly string[];
    }
  | { readonly type: "go"; readonly module: string; readonly version: string }
  | {
      readonly type: "jdtls";
      readonly asset: string;
      readonly launcher: string;
    }
  | { readonly type: "dart" }
  | {
      readonly type: "jvm";
      readonly repository: string;
      readonly asset: string;
      readonly main: string;
    }
  | {
      readonly type: "ruby";
      readonly gem: string;
      readonly version: string;
      readonly args: readonly string[];
    }
  | {
      readonly type: "sdk";
      readonly executable: string;
      readonly args: readonly string[];
    };
export interface LspServerDescriptor {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly languages: readonly LspLanguage[];
  readonly rootMarkers: readonly string[];
  readonly installation: LspInstallation;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
  readonly prerequisites?: string;
  readonly singleFileOnly?: boolean;
  /** OmniSharp 2 emits zero even before didOpen; zero is not revision evidence. */
  readonly zeroVersionUnconfirmed?: boolean;
  readonly configurationViaNotificationOnly?: boolean;
}
const language = (
  id: string,
  extensions: string[],
  filenames?: string[],
): LspLanguage => ({ id, extensions, ...(filenames ? { filenames } : {}) });
const platforms = (
  linux: string,
  darwin: string,
  windows: string,
  linuxArm?: string,
  darwinArm?: string,
  windowsArm?: string,
) => ({
  "linux-x64": linux,
  "darwin-x64": darwin,
  "win32-x64": windows,
  ...(linuxArm ? { "linux-arm64": linuxArm } : {}),
  ...(darwinArm ? { "darwin-arm64": darwinArm } : {}),
  ...(windowsArm ? { "win32-arm64": windowsArm } : {}),
});

/** Linked, reviewed descriptors. No discovery/import of executable project code. */
function freezeDescriptor<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeDescriptor(child);
    Object.freeze(value);
  }
  return value;
}
export const LSP_SERVER_CATALOG: readonly LspServerDescriptor[] =
  freezeDescriptor([
    {
      id: "auto",
      title: "TypeScript / JavaScript",
      version: "6.0.1",
      languages: [
        language("typescript", [".ts", ".mts", ".cts"]),
        language("typescriptreact", [".tsx"]),
        language("javascript", [".js", ".mjs", ".cjs"]),
        language("javascriptreact", [".jsx"]),
      ],
      rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
      installation: { type: "bundled" },
    },
    {
      id: "auto-python",
      title: "Python · Pyright",
      version: "1.1.414",
      languages: [language("python", [".py", ".pyi"])],
      rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.cfg"],
      installation: {
        type: "npm",
        package: "pyright",
        entry: "langserver.index.js",
      },
      settings: {
        python: {
          analysis: {
            diagnosticMode: "openFilesOnly",
            autoSearchPaths: false,
            useLibraryCodeForTypes: false,
          },
        },
        pyright: { disableOrganizeImports: true },
      },
    },
    {
      id: "auto-go",
      title: "Go · gopls",
      version: "0.23.0",
      languages: [
        language("go", [".go"]),
        language("gomod", [], ["go.mod"]),
        language("gowork", [], ["go.work"]),
      ],
      rootMarkers: ["go.work", "go.mod"],
      installation: {
        type: "go",
        module: "golang.org/x/tools/gopls",
        version: "v0.23.0",
      },
      settings: { gopls: { telemetryPrompt: false, staticcheck: false } },
      prerequisites:
        "Go 1.27.1 готовится автоматически; project dependencies не скачиваются",
    },
    {
      id: "auto-rust",
      title: "Rust · rust-analyzer",
      version: "2026-10-05",
      languages: [language("rust", [".rs"])],
      rootMarkers: ["Cargo.toml", "rust-project.json"],
      installation: {
        type: "release",
        repository: "rust-analyzer",
        assets: platforms(
          "rust-analyzer-x86_64-unknown-linux-gnu.gz",
          "rust-analyzer-x86_64-apple-darwin.gz",
          "rust-analyzer-x86_64-pc-windows-msvc.zip",
          "rust-analyzer-aarch64-unknown-linux-gnu.gz",
          "rust-analyzer-aarch64-apple-darwin.gz",
          "rust-analyzer-aarch64-pc-windows-msvc.zip",
        ),
        executable: "rust-analyzer",
      },
      settings: {
        "rust-analyzer": {
          cargo: { buildScripts: { enable: false }, autoreload: true },
          diagnostics: { experimental: { enable: true } },
          procMacro: { enable: false },
          checkOnSave: false,
          check: { enable: false },
        },
      },
      prerequisites:
        "Rust SDK готовится автоматически; build scripts/proc macros и загрузка crates выключены",
    },
    {
      id: "auto-cpp",
      title: "C / C++ · clangd",
      version: "23.1.0",
      languages: [
        language("c", [".c", ".h"]),
        language("cpp", [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"]),
        language("objective-c", [".m"]),
        language("objective-cpp", [".mm"]),
      ],
      rootMarkers: [
        "compile_commands.json",
        "compile_flags.txt",
        "CMakeLists.txt",
      ],
      installation: {
        type: "release",
        repository: "clangd",
        assets: platforms(
          "clangd-linux-23.1.0.zip",
          "clangd-mac-23.1.0.zip",
          "clangd-windows-23.1.0.zip",
          undefined,
          "clangd-mac-23.1.0.zip",
        ),
        executable: "clangd",
        args: [
          "--background-index=false",
          "--clang-tidy=false",
          "--enable-config=false",
          "--log=error",
        ],
      },
    },
    {
      id: "auto-csharp",
      zeroVersionUnconfirmed: true,
      title: "C# · OmniSharp",
      version: "2.0.0",
      languages: [language("csharp", [".cs", ".csx"])],
      rootMarkers: [
        "global.json",
        "Directory.Build.props",
        "*.sln",
        "*.slnx",
        "*.csproj",
      ],
      installation: {
        type: "release",
        repository: "omnisharp-roslyn",
        assets: platforms(
          "omnisharp-linux-x64.tar.gz",
          "omnisharp-osx-x64.tar.gz",
          "omnisharp-win-x64.zip",
          "omnisharp-linux-arm64.tar.gz",
          "omnisharp-osx-arm64.tar.gz",
          "omnisharp-win-arm64.zip",
        ),
        executable: "OmniSharp",
        args: ["-lsp", "--stdio", "--encoding", "utf-8"],
      },
      settings: {
        RoslynExtensionsOptions: { EnableAnalyzersSupport: false },
        MSBuild: { EnablePackageAutoRestore: false },
        FormattingOptions: { EnableEditorConfigSupport: false },
      },
      prerequisites:
        ".NET 10 SDK готовится автоматически; NuGet restore выключен",
    },
    {
      id: "auto-java",
      title: "Java · Eclipse JDT LS",
      version: "1.61.0",
      languages: [language("java", [".java"])],
      rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", ".project"],
      installation: {
        type: "jdtls",
        asset: "jdt-language-server-1.61.0-202609031315.tar.gz",
        launcher: "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar",
      },
      settings: {
        java: {
          import: { gradle: { enabled: false }, maven: { enabled: false } },
          autobuild: { enabled: false },
          configuration: { updateBuildConfiguration: "disabled" },
        },
      },
      prerequisites:
        "JDT LS и Java 21 готовятся автоматически; Gradle/Maven import выключен",
    },
    {
      id: "auto-kotlin",
      title: "Kotlin · Kotlin Language Server",
      version: "1.3.13",
      languages: [language("kotlin", [".kt", ".kts"])],
      rootMarkers: ["settings.gradle.kts", "settings.gradle", "pom.xml"],
      installation: {
        type: "jvm",
        repository: "kotlin-language-server",
        asset: "server.zip",
        main: "org.javacs.kt.MainKt",
      },
      singleFileOnly: true,
      prerequisites:
        "Standalone .kt · без Gradle/Maven/classpath scripts; полный проект через свой LSP",
    },
    {
      id: "auto-php",
      title: "PHP · Intelephense",
      version: "1.18.5",
      languages: [language("php", [".php", ".phtml", ".php8"])],
      rootMarkers: ["composer.json"],
      installation: {
        type: "npm",
        package: "intelephense",
        entry: "lib/intelephense.js",
      },
      settings: {
        intelephense: {
          telemetry: { enabled: false },
          environment: { includePaths: [] },
        },
      },
    },
    {
      id: "auto-ruby",
      title: "Ruby · Solargraph",
      version: "0.61.0",
      languages: [
        language("ruby", [".rb", ".rake", ".gemspec"], ["Gemfile", "Rakefile"]),
      ],
      rootMarkers: ["Gemfile", ".solargraph.yml"],
      installation: {
        type: "ruby",
        gem: "solargraph",
        version: "0.61.0",
        args: ["stdio"],
      },
      settings: {
        solargraph: {
          diagnostics: true,
          formatting: false,
          useBundler: false,
        },
      },
      prerequisites:
        "Ruby ≥3.2 / RubyGems SDK с headers и build tools вне проекта",
    },
    {
      id: "auto-swift",
      title: "Swift · SourceKit-LSP",
      version: "toolchain",
      languages: [language("swift", [".swift"])],
      rootMarkers: ["Package.swift"],
      installation: { type: "sdk", executable: "sourcekit-lsp", args: [] },
      initializationOptions: { backgroundIndexing: false },
      prerequisites:
        "Установленный Swift toolchain / Xcode; SDK определяется автоматически",
    },
    {
      id: "auto-lua",
      title: "Lua · LuaLS",
      version: "3.19.1",
      languages: [language("lua", [".lua"])],
      rootMarkers: [".luarc.json"],
      installation: {
        type: "release",
        repository: "lua-language-server",
        assets: platforms(
          "lua-language-server-3.19.1-linux-x64.tar.gz",
          "lua-language-server-3.19.1-darwin-x64.tar.gz",
          "lua-language-server-3.19.1-win32-x64.zip",
          "lua-language-server-3.19.1-linux-arm64.tar.gz",
          "lua-language-server-3.19.1-darwin-arm64.tar.gz",
        ),
        executable: "lua-language-server",
        args: ["--loglevel=error"],
      },
      settings: {
        Lua: {
          workspace: { checkThirdParty: false, library: [] },
          telemetry: { enable: false },
          runtime: { version: "Lua 5.4" },
        },
      },
    },
    {
      id: "auto-dart",
      title: "Dart / Flutter",
      version: "3.13.5",
      languages: [language("dart", [".dart"])],
      rootMarkers: ["pubspec.yaml"],
      installation: { type: "dart" },
      prerequisites:
        "Dart SDK готовится автоматически; Flutter SDK для Flutter проектов, pub get не запускается",
    },
    {
      id: "auto-html",
      title: "HTML",
      version: "4.10.0",
      languages: [language("html", [".html", ".htm"])],
      rootMarkers: ["package.json"],
      installation: {
        type: "npm",
        package: "vscode-langservers-extracted",
        entry: "bin/vscode-html-language-server",
      },
    },
    {
      id: "auto-css",
      title: "CSS / SCSS / Less",
      version: "4.10.0",
      languages: [
        language("css", [".css"]),
        language("scss", [".scss"]),
        language("less", [".less"]),
      ],
      rootMarkers: ["package.json"],
      installation: {
        type: "npm",
        package: "vscode-langservers-extracted",
        entry: "bin/vscode-css-language-server",
      },
    },
    {
      id: "auto-json",
      title: "JSON / JSONC",
      version: "4.10.0",
      languages: [language("json", [".json"]), language("jsonc", [".jsonc"])],
      rootMarkers: [],
      installation: {
        type: "npm",
        package: "vscode-langservers-extracted",
        entry: "bin/vscode-json-language-server",
      },
      initializationOptions: { provideFormatter: false },
      settings: {
        json: { schemaDownload: { enable: false }, validate: { enable: true } },
      },
    },
    {
      id: "auto-yaml",
      title: "YAML",
      version: "1.24.0",
      languages: [language("yaml", [".yaml", ".yml"])],
      rootMarkers: [],
      installation: {
        type: "npm",
        package: "yaml-language-server",
        entry: "bin/yaml-language-server",
      },
      settings: {
        yaml: { schemaStore: { enable: false }, schemas: {}, validate: true },
      },
    },
    {
      id: "auto-bash",
      title: "Shell / Bash",
      version: "5.8.1",
      languages: [
        language(
          "shellscript",
          [".sh", ".bash"],
          [".bashrc", ".bash_profile", ".profile"],
        ),
      ],
      rootMarkers: [],
      installation: {
        type: "npm",
        package: "bash-language-server",
        entry: "out/cli.js",
        args: ["start"],
      },
      settings: {
        bashIde: {
          shellcheckPath: "",
          shfmtPath: "",
          explainshellEndpoint: "",
        },
      },
    },
    {
      id: "auto-docker",
      configurationViaNotificationOnly: true,
      title: "Dockerfile",
      version: "0.15.0",
      languages: [language("dockerfile", [], ["Dockerfile", "Containerfile"])],
      rootMarkers: [],
      installation: {
        type: "npm",
        package: "dockerfile-language-server-nodejs",
        entry: "bin/docker-langserver",
      },
    },
  ]);
export function catalogServer(id: string): LspServerDescriptor | undefined {
  return LSP_SERVER_CATALOG.find((server) => server.id === id);
}
export function catalogLanguage(
  path: string,
): { server: LspServerDescriptor; language: LspLanguage } | undefined {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  for (const server of LSP_SERVER_CATALOG)
    for (const language of server.languages)
      if (
        language.filenames?.includes(name) ||
        language.extensions.includes(extension)
      )
        return { server, language };
  if (/^(?:Dockerfile|Containerfile)\./.test(name)) {
    const server = catalogServer("auto-docker");
    const language = server?.languages[0];
    if (server && language) return { server, language };
  }
  return undefined;
}

export function catalogPlatformAvailable(server: LspServerDescriptor): boolean {
  const recipe = server.installation;
  return (
    recipe.type !== "release" ||
    !!recipe.assets[`${process.platform}-${process.arch}`]
  );
}
