import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(packageRoot, '../..', 'keytar-svgrepo-com.svg');
const outputDirectory = path.join(packageRoot, 'assets/icons');
const sizes = [16, 32, 48, 128];
const source = (await readFile(sourcePath, 'utf8')).replace(/(<svg\b[^>]*?)\stransform="[^"]*"/, '$1');

await mkdir(outputDirectory, { recursive: true });
for (const size of sizes) {
    const image = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render();
    await writeFile(path.join(outputDirectory, `keetar-${size}.png`), image.asPng());
}