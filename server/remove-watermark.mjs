import sharp from 'sharp';
const input = '.tmp/current.jpg';
const img = sharp(input);
const meta = await img.metadata();
const w = meta.width, h = meta.height;
// blur bottom-right watermark
const brW = Math.round(w * 0.28);
const brH = Math.round(h * 0.07);
const brLeft = w - brW;
const brTop = h - brH;
const brBlurred = await sharp(input).extract({ left: brLeft, top: brTop, width: brW, height: brH }).blur(25).toBuffer();
// blur center watermark (小红书 text in middle)
const cW = Math.round(w * 0.35);
const cH = Math.round(h * 0.08);
const cLeft = Math.round((w - cW) / 2);
const cTop = Math.round(h * 0.45);
const cBlurred = await sharp(input).extract({ left: cLeft, top: cTop, width: cW, height: cH }).blur(30).toBuffer();
await sharp(input)
  .composite([
    { input: brBlurred, left: brLeft, top: brTop },
    { input: cBlurred, left: cLeft, top: cTop }
  ])
  .jpeg({ quality: 95 })
  .toFile('.tmp/current-clean.jpg');
console.log('done');
