/**
 * Renders the driver images from their SVG sources in `.src-images/`.
 *
 * 🔴 The three sizes have to come from one source. The first submission was
 * rejected under App Store guideline 1.4 because the NAS and switch images sat on
 * a coloured background, and a hand-edited set is exactly how one size gets fixed
 * and the other two do not. Run this, commit what it writes, and the three stay
 * in step.
 *
 * The background is flattened to opaque white rather than left transparent: the
 * store accepts either, but a transparent PNG shows the *pairing view's* own
 * background through the device, which is not white everywhere.
 *
 *   node tools/render-driver-images.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What Homey asks a driver for, and at exactly these sizes. */
const SIZES = { small: 75, large: 500, xlarge: 1000 };

/** Only the two the review rejected. The UPS image is a photograph, not an SVG. */
const DRIVERS = ['nas', 'netswitch'];

for (const driver of DRIVERS) {
  const svg = await readFile(join(root, '.src-images', `${driver}-source.svg`));

  for (const [name, size] of Object.entries(SIZES)) {
    const png = await sharp(svg, { density: 384 })
      .resize(size, size, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await writeFile(join(root, 'drivers', driver, 'assets', 'images', `${name}.png`), png);
    console.log(`drivers/${driver}/assets/images/${name}.png  ${size}×${size}`);
  }
}
