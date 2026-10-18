import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderChaiModule } from '../src/sandbox/chai-embed.js';

// Writes src/sandbox/chai-source.generated.ts from the installed chai bundle.
// Run from the repository root after changing chai's version:
//   node --import tsx packages/runner/scripts/embed-chai.ts

const packageDir = join(import.meta.dirname, '..');
const chaiDir = join(packageDir, 'node_modules', 'chai');
const bundle = readFileSync(join(chaiDir, 'index.js'), 'utf8');
const { version } = JSON.parse(readFileSync(join(chaiDir, 'package.json'), 'utf8')) as { version: string };
const target = join(packageDir, 'src', 'sandbox', 'chai-source.generated.ts');
writeFileSync(target, renderChaiModule(bundle, version));
console.log(`wrote ${target} (chai ${version})`);
