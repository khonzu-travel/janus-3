import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';

import {
  ADAPTERS_AND_SOURCES,
  COMPOSITION_ROOT,
  BROWSER_ONLY_GLOBALS,
  NODE_GLOBALS,
  PACKAGE_RULES,
  type DirectoryRule,
  type PackageRule,
} from './rules.js';

export interface SourceFile {
  /** Path relative to the package directory, with forward slashes, e.g. "src/index.ts". */
  readonly path: string;
  readonly contents: string;
}

export interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackage {
  readonly name: string;
  /** Directory relative to the workspace root, with forward slashes, e.g. "packages/core". */
  readonly dir: string;
  readonly manifest: PackageManifest;
  /** Production source files (tests already excluded). */
  readonly files: readonly SourceFile[];
}

export interface Workspace {
  readonly packages: readonly WorkspacePackage[];
}

export type RuleId =
  | 'unknown-package'
  | 'core-node-import'
  | 'core-node-global'
  | 'core-browser-global'
  | 'third-party'
  | 'core-dynamic-specifier'
  | 'browser-node-import'
  | 'browser-node-global'
  | 'janus-edge'
  | 'server-only-wires'
  | 'manifest-edge'
  | 'manifest-missing'
  | 'relative-escape'
  | 'deep-import'
  | 'asset-import'
  | 'asset-resolve'
  | 'directory-import';

export interface Violation {
  readonly package: string;
  /** Path relative to the package directory; "package.json" for manifest violations. */
  readonly file: string;
  readonly line: number;
  readonly rule: RuleId;
  readonly specifier: string;
  readonly message: string;
}

export type ImportKind = 'static' | 'dynamic' | 'require' | 'type';

export interface ImportRecord {
  /** Module specifier, or null for a dynamic import / require whose argument is not a string literal. */
  readonly specifier: string | null;
  readonly kind: ImportKind;
  /**
   * True when the import is erased from the emitted JavaScript: `import type`,
   * `export type … from`, `import type x = require()`, and `import('x')` types.
   */
  readonly typeOnly: boolean;
  readonly line: number;
}

export interface GlobalReference {
  readonly name: string;
  readonly line: number;
}

export function formatViolation(violation: Violation): string {
  return `${violation.package}: ${violation.file}:${String(violation.line)} — ${violation.rule} — ${violation.specifier} (${violation.message})`;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.split('/')[0] ?? name]));

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function parse(file: SourceFile): ts.SourceFile {
  const scriptKind = file.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file.path, file.contents, ts.ScriptTarget.Latest, true, scriptKind);
}

/** Collects every module reference in a file using the TypeScript parser, so comments and strings never count. */
export function extractImports(file: SourceFile): ImportRecord[] {
  const sourceFile = parse(file);
  const imports: ImportRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Only `import type` is erased. Under verbatimModuleSyntax, `import { type A } from 'x'`
      // still emits `import {} from 'x'`, which loads the module, so it is not type-only.
      const typeOnly = node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      imports.push({
        specifier: stringLiteralText(node.moduleSpecifier),
        kind: typeOnly ? 'type' : 'static',
        typeOnly,
        line: lineOf(sourceFile, node),
      });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      // Likewise only `export type { A } from 'x'` is erased; `export { type A } from 'x'` emits `export {} from 'x'`.
      const typeOnly = node.isTypeOnly;
      imports.push({
        specifier: stringLiteralText(node.moduleSpecifier),
        kind: typeOnly ? 'type' : 'static',
        typeOnly,
        line: lineOf(sourceFile, node),
      });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      imports.push({
        specifier: stringLiteralText(node.moduleReference.expression),
        kind: node.isTypeOnly ? 'type' : 'require',
        typeOnly: node.isTypeOnly,
        line: lineOf(sourceFile, node),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push({
        specifier: stringLiteralText(node.arguments[0]),
        kind: 'dynamic',
        typeOnly: false,
        line: lineOf(sourceFile, node),
      });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      imports.push({
        specifier: stringLiteralText(node.arguments[0]),
        kind: 'require',
        typeOnly: false,
        line: lineOf(sourceFile, node),
      });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imports.push({
        specifier: stringLiteralText(node.argument.literal),
        kind: 'type',
        typeOnly: true,
        line: lineOf(sourceFile, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

export interface NamedImport {
  readonly specifier: string;
  /** The imported names, or null when the import takes the whole module (default, namespace, require). */
  readonly names: readonly string[] | null;
  readonly line: number;
}

/** What each import declaration takes from its module, for directories that allow only some names. */
export function extractNamedImports(file: SourceFile): NamedImport[] {
  const sourceFile = parse(file);
  const imports: NamedImport[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = stringLiteralText(statement.moduleSpecifier);
    if (specifier === null) continue;
    let names: string[] | null = null;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (clause === undefined) names = [];
      else if (clause.name === undefined && bindings !== undefined && ts.isNamedImports(bindings)) {
        names = bindings.elements.map((element) => (element.propertyName ?? element.name).text);
      }
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      names = statement.exportClause.elements.map((element) => (element.propertyName ?? element.name).text);
    }
    imports.push({ specifier, names, line: lineOf(sourceFile, statement) });
  }
  return imports;
}

export interface ResolveRecord {
  /** The argument of `import.meta.resolve`, or null when it is not a string literal. */
  readonly specifier: string | null;
  readonly line: number;
}

/** Collects every `import.meta.resolve(…)` call. */
export function extractResolves(file: SourceFile): ResolveRecord[] {
  const sourceFile = parse(file);
  const resolves: ResolveRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'resolve' &&
      ts.isMetaProperty(node.expression.expression) &&
      node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    ) {
      resolves.push({ specifier: stringLiteralText(node.arguments[0]), line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return resolves;
}

type IdentifierRole = 'reference' | 'declaration' | 'property';

/** Tells a variable reference apart from a declared name and from a property or member name. */
function identifierRole(node: ts.Identifier): IdentifierRole {
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isQualifiedName(parent) && parent.right === node) ||
    ((ts.isBindingElement(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
      parent.propertyName === node)
  ) {
    return 'property';
  }
  if ((parent as { name?: ts.Node }).name !== node) return 'reference';
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isGetAccessorDeclaration(parent) ||
    ts.isSetAccessorDeclaration(parent) ||
    ts.isEnumMember(parent) ||
    ts.isJsxAttribute(parent)
  ) {
    return 'property';
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isInterfaceDeclaration(parent) ||
    ts.isTypeAliasDeclaration(parent) ||
    ts.isEnumDeclaration(parent) ||
    ts.isModuleDeclaration(parent) ||
    ts.isTypeParameterDeclaration(parent) ||
    ts.isBindingElement(parent) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent)
  ) {
    return 'declaration';
  }
  return 'reference';
}

/**
 * Finds references to Node and browser-only globals. Property names are ignored, and a name the
 * file declares itself (for example a local `process` variable) shadows the
 * global, so its references are not reported either.
 */
export function findPlatformGlobalReferences(
  file: SourceFile,
  globals: readonly string[] = [...NODE_GLOBALS, ...BROWSER_ONLY_GLOBALS],
): GlobalReference[] {
  const sourceFile = parse(file);
  const references: ts.Identifier[] = [];
  const declared = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && globals.includes(node.text)) {
      const role = identifierRole(node);
      if (role === 'declaration') declared.add(node.text);
      else if (role === 'reference') references.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references
    .filter((identifier) => !declared.has(identifier.text))
    .map((identifier) => ({ name: identifier.text, line: lineOf(sourceFile, identifier) }));
}

type Specifier =
  | { readonly type: 'relative' }
  | { readonly type: 'node'; readonly name: string }
  | { readonly type: 'janus'; readonly packageName: string; readonly deep: boolean }
  | { readonly type: 'third-party'; readonly packageName: string };

function classify(specifier: string): Specifier {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return { type: 'relative' };
  if (specifier.startsWith('node:')) return { type: 'node', name: specifier };
  const segments = specifier.split('/');
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
  if (packageName.startsWith('@janus/')) {
    return { type: 'janus', packageName, deep: packageName !== specifier };
  }
  if (NODE_BUILTINS.has(specifier) || NODE_BUILTINS.has(packageName)) return { type: 'node', name: specifier };
  return { type: 'third-party', packageName };
}

function manifestJanusDeps(manifest: PackageManifest): [name: string, version: string][] {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].flatMap((deps) =>
    Object.entries(deps ?? {}).filter(([name]) => name.startsWith('@janus/')),
  );
}

function checkPackage(pkg: WorkspacePackage, rule: PackageRule, violations: Violation[]): void {
  const report = (file: string, line: number, id: RuleId, specifier: string, message: string): void => {
    violations.push({ package: pkg.name, file, line, rule: id, specifier, message });
  };

  // Manifest edges.
  const declared = manifestJanusDeps(pkg.manifest);
  const declaredNames = new Set(declared.map(([name]) => name));
  const assetDeps = rule.assetDeps ?? [];
  for (const [name, version] of declared) {
    if (!rule.janusDeps.includes(name) && !assetDeps.includes(name)) {
      report('package.json', 0, 'manifest-edge', name, `not an allowed edge (rule ${rule.dependencyRule})`);
    } else if (version !== 'workspace:*') {
      report('package.json', 0, 'manifest-edge', name, `Janus dependencies must be "workspace:*", got "${version}"`);
    }
  }

  const janusDepsUsed = new Set([...declaredNames].filter((name) => !assetDeps.includes(name)));
  for (const file of pkg.files) {
    const directory = directoryRule(rule, file.path);
    const fileRule: PackageRule = {
      ...rule,
      ...(directory?.browser === undefined ? {} : { browser: directory.browser }),
      ...(directory?.janusDeps === undefined ? {} : { janusDeps: directory.janusDeps }),
      ...(directory?.thirdPartyAllowlist === undefined ? {} : { thirdPartyAllowlist: directory.thirdPartyAllowlist }),
    };
    const only = directory?.onlyImports;
    if (only !== undefined) {
      for (const { specifier, names, line } of extractNamedImports(file)) {
        if (classify(specifier).type === 'relative') continue;
        const allowed = only[specifier];
        if (allowed === undefined) {
          report(file.path, line, 'directory-import', specifier, 'not an import this directory allows (rules.ts)');
        } else if (names === null || names.some((name) => !allowed.includes(name))) {
          report(file.path, line, 'directory-import', specifier, `import only ${allowed.join(', ')} from it`);
        }
      }
    }
    for (const { specifier, line } of extractImports(file)) {
      if (specifier === null) {
        if (fileRule.platformNeutral === true) {
          report(
            file.path,
            line,
            'core-dynamic-specifier',
            '<non-literal>',
            'module specifier must be a string literal',
          );
        }
        continue;
      }
      const target = classify(specifier);
      switch (target.type) {
        case 'relative': {
          const resolved = posix.normalize(posix.join(pkg.dir, posix.dirname(file.path), specifier));
          if (specifier.startsWith('/') || !(resolved === pkg.dir || resolved.startsWith(`${pkg.dir}/`))) {
            report(file.path, line, 'relative-escape', specifier, 'relative import leaves the package directory');
          }
          break;
        }
        case 'node':
          if (fileRule.platformNeutral === true) {
            report(file.path, line, 'core-node-import', specifier, 'Node built-ins are not allowed (rule 1)');
          } else if (fileRule.browser === true) {
            report(file.path, line, 'browser-node-import', specifier, 'browser code cannot use Node built-ins');
          }
          break;
        case 'janus': {
          if (target.deep) {
            report(file.path, line, 'deep-import', specifier, 'import only the package root export');
          }
          if (target.packageName === pkg.name) break;
          if (assetDeps.includes(target.packageName)) {
            report(
              file.path,
              line,
              'asset-import',
              specifier,
              `an asset dependency is never imported; locate its files with import.meta.resolve('${target.packageName}/dist/…')`,
            );
            break;
          }
          janusDepsUsed.add(target.packageName);
          if (!fileRule.janusDeps.includes(target.packageName)) {
            report(file.path, line, 'janus-edge', specifier, `not an allowed edge (rule ${fileRule.dependencyRule})`);
          } else if (!declaredNames.has(target.packageName)) {
            report(file.path, line, 'manifest-missing', specifier, 'imported but not declared in package.json');
          }
          break;
        }
        case 'third-party': {
          if (
            fileRule.thirdPartyAllowlist !== undefined &&
            !fileRule.thirdPartyAllowlist.includes(target.packageName)
          ) {
            report(file.path, line, 'third-party', specifier, 'not on the third-party allowlist in rules.ts');
          }
          break;
        }
      }
    }
    for (const { specifier, line } of extractResolves(file)) {
      if (specifier === null) continue;
      const target = classify(specifier);
      if (target.type !== 'janus' || target.packageName === pkg.name) continue;
      if (!assetDeps.includes(target.packageName) || !specifier.startsWith(`${target.packageName}/dist/`)) {
        report(file.path, line, 'asset-resolve', specifier, "only an asset dependency's dist/ files may be resolved");
      } else if (!declaredNames.has(target.packageName)) {
        report(file.path, line, 'manifest-missing', specifier, 'resolved but not declared in package.json');
      }
    }
    if (fileRule.browser === true) {
      for (const reference of findPlatformGlobalReferences(file, NODE_GLOBALS)) {
        report(
          file.path,
          reference.line,
          'browser-node-global',
          reference.name,
          'browser code cannot use Node globals',
        );
      }
    }
    if (fileRule.platformNeutral === true) {
      for (const reference of findPlatformGlobalReferences(file)) {
        if (NODE_GLOBALS.includes(reference.name)) {
          report(
            file.path,
            reference.line,
            'core-node-global',
            reference.name,
            'Node globals are not allowed (rule 1)',
          );
        } else {
          report(
            file.path,
            reference.line,
            'core-browser-global',
            reference.name,
            'browser-only globals are not allowed (rule 1)',
          );
        }
      }
    }
  }

  // Rule 5: nothing depends on the composition root, and only it wires several adapters or sources.
  // Rule 7: a package whose rule lists the composition root (the desktop app) may run it.
  if (pkg.name !== COMPOSITION_ROOT) {
    if (janusDepsUsed.has(COMPOSITION_ROOT) && !rule.janusDeps.includes(COMPOSITION_ROOT)) {
      report('package.json', 0, 'server-only-wires', COMPOSITION_ROOT, 'nothing may depend on the server (rule 5)');
    }
    const wired = [...janusDepsUsed].filter((name) => ADAPTERS_AND_SOURCES.includes(name)).sort();
    if (wired.length > 1) {
      report(
        'package.json',
        0,
        'server-only-wires',
        wired.join(', '),
        'only the server may depend on more than one adapter or source (rule 5)',
      );
    }
  }
}

/** The directory rule for a file: the longest matching prefix. */
function directoryRule(rule: PackageRule, path: string): DirectoryRule | undefined {
  const prefixes = Object.keys(rule.directories ?? {})
    .filter((prefix) => path.startsWith(prefix))
    .sort((a, b) => b.length - a.length);
  const prefix = prefixes[0];
  return prefix === undefined ? undefined : rule.directories?.[prefix];
}

/** Checks a workspace against the dependency rules. Pure: reads nothing but its argument. */
export function checkBoundaries(
  workspace: Workspace,
  rules: Readonly<Record<string, PackageRule>> = PACKAGE_RULES,
): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of workspace.packages) {
    const rule = rules[pkg.name];
    if (rule === undefined) {
      violations.push({
        package: pkg.name,
        file: 'package.json',
        line: 0,
        rule: 'unknown-package',
        specifier: pkg.name,
        message: 'add an entry to tests/boundaries/rules.ts',
      });
      continue;
    }
    checkPackage(pkg, rule, violations);
  }
  return violations;
}
