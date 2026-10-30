import sharp from 'sharp';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
<rect width="128" height="128" rx="28" fill="#2563eb"/>
<text x="64" y="90" font-family="Arial, Helvetica, sans-serif" font-size="78" font-weight="bold" fill="#fff" text-anchor="middle">W</text>
<rect x="24" y="100" width="80" height="10" rx="5" fill="#facc15"/></svg>`;
for (const s of [16, 48, 128]) await sharp(Buffer.from(svg)).resize(s, s).png().toFile(`public/icons/${s}.png`);
console.log('icons done');
