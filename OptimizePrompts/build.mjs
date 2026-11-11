/**
 * dsh-optimize-prompts build.
 *
 * Both halves are plain JavaScript, so this script has no dependencies. It
 * inlines `src/shared.js` into the Host bundle and into the browser factory,
 * injects the package version, and writes the two files `package.json` exports.
 *
 *   node build.mjs
 *
 * The browser artifact is wrapped in the module-loader envelope DSH's client
 * module system serves: `factory(require) → exports`. A bundle that leaves an
 * `export` statement in place would be a classic script with ESM-only syntax
 * and never reach the loader.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFile(join(root, relative), 'utf8');

const pkg = JSON.parse(await read('package.json'));
const [shared, host, client] = await Promise.all([
  read('src/shared.js'),
  read('src/host.js'),
  read('src/client.js'),
]);

const banner = (half) =>
  `/* ${pkg.name} v${pkg.version} — generated ${half}. Edit src/ and run "node build.mjs". */\n`;

/** The plugin version, injected where the browser half renders it. */
const versionConst = `const PLUGIN_VERSION = ${JSON.stringify(pkg.version)};\n`;

/**
 * Translate the sources' ESM surface into the factory-form CJS the client
 * module loader materializes.
 *
 * @param source - `src/client.js` text.
 * @returns the factory body: `require` bindings plus the source without
 *   `import`/`export` statements.
 */
function toFactoryBody(source) {
  const imports = new Map();
  const withoutImports = source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*'([^']+)';$/gm,
    (match, names, specifier) => {
      const bindings = names.split(',').map((name) => name.trim()).filter((name) => name !== '');
      imports.set(specifier, [...(imports.get(specifier) ?? []), ...bindings]);
      return '';
    },
  );
  const importLines = [...imports.entries()]
    .map(([specifier, names]) => `const { ${names.join(', ')} } = require(${JSON.stringify(specifier)});`)
    .join('\n');
  const withoutExports = withoutImports.replace(
    /^export\s*\{([^}]*)\};$/m,
    (match, names) => names.split(',').map((name) => name.trim()).filter((name) => name !== '')
      .map((name) => `exports.${name} = ${name};`)
      .join('\n'),
  );
  return `\t\t${importLines.split('\n').join('\n\t\t')}\n${withoutExports}`;
}

/* The Host half is an ordinary ES module: shared constants + Host body. */
const hostArtifact = `${banner('Host half')}${shared}\n${host}`;

/* The browser half only registers a factory; the loader materializes it later.
   Same-origin `fetch` is a page global, not a module import. */
const clientArtifact = `${banner('browser half')}window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${versionConst}${shared}${toFactoryBody(client)}
\t\treturn module.exports;
\t}
});
`;

await mkdir(join(root, 'lib'), { recursive: true });
await writeFile(join(root, 'lib', 'index.js'), hostArtifact, 'utf8');
await writeFile(join(root, 'lib', 'client.js'), clientArtifact, 'utf8');

process.stdout.write(
  `${pkg.name}: wrote lib/index.js, lib/client.js — ${hostArtifact.length} + ${clientArtifact.length} characters\n`,
);
