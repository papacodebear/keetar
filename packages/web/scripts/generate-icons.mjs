import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.resolve(packageRoot, '../..', 'keytar-svgrepo-com.svg');
const outputDirectory = path.join(packageRoot, 'assets/icons');
const sizes = [16, 32, 48, 128];

const raw = await readFile(sourcePath, 'utf8');
const svgOpenTag = raw.match(/<svg\b[^>]*>/)?.[0];
if (!svgOpenTag) {
    throw new Error(`no <svg> tag found in ${sourcePath}`);
}
// The root <svg> carries a transform. Browsers rendering it via <img> (as README.md does) apply this
// as a CSS transform, which rotates/flips around the box's *center* by default. Resvg has no such
// root-element handling — a transform attribute on an inner element is plain SVG matrix math, anchored
// at the coordinate-system origin, not the visual center. Naively moving the attribute onto a wrapping
// <g> reproduces the origin-anchored math instead, which pushes the artwork mostly off-canvas. Pre-composing
// translate(center) * transform * translate(-center) reproduces the CSS center-anchored rotation Resvg-side,
// so the generated icons actually match what the README/GitHub page shows instead of just not crashing.
const transform = svgOpenTag.match(/\stransform="([^"]*)"/)?.[1];
const svgOpenTagNoTransform = svgOpenTag.replace(/\stransform="[^"]*"/, '');
const [minX, minY, vbWidth, vbHeight] = svgOpenTagNoTransform.match(/\sviewBox="([^"]*)"/)?.[1].split(/\s+/).map(Number) ?? [];
const centerX = minX + vbWidth / 2;
const centerY = minY + vbHeight / 2;
const bodyStart = raw.indexOf(svgOpenTag) + svgOpenTag.length;
const bodyEnd = raw.lastIndexOf('</svg>');
const body = raw.slice(bodyStart, bodyEnd);

function buildSvg({ grayscale }) {
    const transformAttr = transform
        ? ` transform="translate(${centerX},${centerY}) ${transform} translate(${-centerX},${-centerY})"`
        : '';
    if (!grayscale) {
        return `${svgOpenTagNoTransform}<g${transformAttr}>${body}</g></svg>`;
    }
    // feColorMatrix saturate=0 desaturates using the standard luminance-preserving formula —
    // no extra image-processing dependency needed for the toolbar's "not connected" icon state.
    const filterDefs = '<defs><filter id="keetar-desaturate"><feColorMatrix type="saturate" values="0"/></filter></defs>';
    return `${svgOpenTagNoTransform}${filterDefs}<g${transformAttr} filter="url(#keetar-desaturate)">${body}</g></svg>`;
}

const color = buildSvg({ grayscale: false });
const gray = buildSvg({ grayscale: true });

await mkdir(outputDirectory, { recursive: true });
for (const size of sizes) {
    const colorPng = new Resvg(color, { fitTo: { mode: 'width', value: size } }).render().asPng();
    await writeFile(path.join(outputDirectory, `keetar-${size}.png`), colorPng);
    const grayPng = new Resvg(gray, { fitTo: { mode: 'width', value: size } }).render().asPng();
    await writeFile(path.join(outputDirectory, `keetar-${size}-gray.png`), grayPng);
}
