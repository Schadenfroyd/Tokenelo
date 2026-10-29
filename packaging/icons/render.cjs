'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, nativeImage, session } = require('electron');

const EXPECTED_ELECTRON = '44.6.0';
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const MACOS_ICONSET_FRAMES = [
  { name: 'icon_16x16.png', size: 16 }, { name: 'icon_16x16@2x.png', size: 32 },
  { name: 'icon_32x32.png', size: 32 }, { name: 'icon_32x32@2x.png', size: 64 },
  { name: 'icon_128x128.png', size: 128 }, { name: 'icon_128x128@2x.png', size: 256 },
  { name: 'icon_256x256.png', size: 256 }, { name: 'icon_256x256@2x.png', size: 512 },
  { name: 'icon_512x512.png', size: 512 }, { name: 'icon_512x512@2x.png', size: 1024 },
];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let activeWindow = null;
let blockedNetworkRequests = 0;
let rejectedNavigations = 0;
let rejectedWindowOpens = 0;
let showAttempts = 0;
let focusAttempts = 0;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fail(message) {
  throw new Error(message);
}

function readPngDimensions(png, label) {
  if (!Buffer.isBuffer(png) || png.length < 33 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${label} is not a PNG`);
  }
  const firstChunkLength = png.readUInt32BE(8);
  if (png.subarray(12, 16).toString('ascii') !== 'IHDR' || firstChunkLength !== 13) {
    fail(`${label} has no canonical PNG IHDR`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  if (bitDepth !== 8 || colorType !== 6) fail(`${label} must be 8-bit RGBA PNG`);
  return { width, height, bitDepth, colorType };
}

function assertExactPngSize(png, size, label) {
  const dimensions = readPngDimensions(png, label);
  if (dimensions.width !== size || dimensions.height !== size) {
    fail(`${label} dimensions ${dimensions.width}x${dimensions.height} differ from ${size}x${size}`);
  }
  return dimensions;
}

function nativePixel(image, x, y) {
  const { width, height } = image.getSize();
  if (x < 0 || y < 0 || x >= width || y >= height) fail('pixel sample is outside the icon image');
  const bitmap = image.toBitmap();
  const offset = (y * width + x) * 4;
  const first = [bitmap[offset], bitmap[offset + 1], bitmap[offset + 2], bitmap[offset + 3]];
  return { rgba: first, bgra: [first[2], first[1], first[0], first[3]] };
}

function matchesRgb(pixel, expected) {
  return pixel.rgba[3] === 255 && pixel.rgba.slice(0, 3).every((value, index) => value === expected[index])
    || pixel.bgra[3] === 255 && pixel.bgra.slice(0, 3).every((value, index) => value === expected[index]);
}

function alphaAt(image, x, y) {
  const sample = nativePixel(image, x, y);
  return sample.rgba[3];
}

function encodeIco(frames) {
  if (frames.length === 0 || frames.length > 255) fail('ICO frame count is invalid');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(frames.length * 16);
  let imageOffset = header.length + directory.length;
  for (let index = 0; index < frames.length; index++) {
    const { size, png } = frames[index];
    assertExactPngSize(png, size, `ICO ${size}px frame`);
    const offset = index * 16;
    directory[offset] = size === 256 ? 0 : size;
    directory[offset + 1] = size === 256 ? 0 : size;
    directory[offset + 2] = 0;
    directory[offset + 3] = 0;
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(png.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += png.length;
  }
  return Buffer.concat([header, directory, ...frames.map(frame => frame.png)]);
}

function writeNewFile(filePath, content) {
  const fd = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function makeDataUrl(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function renderMasterPng(svgText, expectedSvgHash) {
  const actualSvgHash = sha256(Buffer.from(svgText, 'utf8'));
  if (actualSvgHash !== expectedSvgHash) fail('source SVG hash did not match the pinned extraction');

  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:; '
    + 'style-src \'unsafe-inline\'; connect-src \'none\'; font-src \'none\'; object-src \'none\'">'
    + '<style>html,body{margin:0;width:1px;height:1px;background:transparent;overflow:hidden}</style>'
    + '<title>Tokenelo icon render</title></head><body></body></html>';
  const initialUrl = makeDataUrl(html);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('data:') || details.url.startsWith('blob:');
    if (!allowed) {
      blockedNetworkRequests++;
      callback({ cancel: true });
      return;
    }
    callback({});
  });

  const win = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, show: false, focusable: false,
    skipTaskbar: true, offscreen: true, transparent: true, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  activeWindow = win;
  win.on('show', event => { showAttempts++; event.preventDefault(); });
  win.on('focus', event => { focusAttempts++; event.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => { rejectedWindowOpens++; return { action: 'deny' }; });
  let initialNavigationAllowed = true;
  win.webContents.on('will-navigate', (event, url) => {
    if (initialNavigationAllowed && url === initialUrl) {
      initialNavigationAllowed = false;
      return;
    }
    rejectedNavigations++;
    event.preventDefault();
  });

  await win.loadURL(initialUrl);
  const svgJson = JSON.stringify(svgText);
  const pngDataUrl = await win.webContents.executeJavaScript(`(async () => {
    const source = ${svgJson};
    const image = new Image();
    const objectUrl = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml;charset=utf-8' }));
    image.src = objectUrl;
    try { await image.decode(); }
    catch (error) { URL.revokeObjectURL(objectUrl); throw error; }
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 1024;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) { URL.revokeObjectURL(objectUrl); throw new Error('software canvas context unavailable'); }
    context.clearRect(0, 0, 1024, 1024);
    context.drawImage(image, 0, 0, 1024, 1024);
    const result = canvas.toDataURL('image/png');
    URL.revokeObjectURL(objectUrl);
    return result;
  })()`, true);
  if (typeof pngDataUrl !== 'string' || !pngDataUrl.startsWith('data:image/png;base64,')) {
    fail('software renderer did not return a PNG data URL');
  }
  const png = Buffer.from(pngDataUrl.slice('data:image/png;base64,'.length), 'base64');
  assertExactPngSize(png, 1024, 'master PNG');
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty() || image.getSize().width !== 1024 || image.getSize().height !== 1024) {
    fail('Electron nativeImage did not decode the exact 1024x1024 master PNG');
  }
  if (alphaAt(image, 0, 0) !== 0) fail('master PNG corner is not transparent');
  if (!matchesRgb(nativePixel(image, 400, 512), [93, 225, 196])) fail('master PNG misses the exact mint interior pixel');
  if (!matchesRgb(nativePixel(image, 512, 600), [17, 27, 52])) fail('master PNG misses the exact navy glyph pixel');
  if (blockedNetworkRequests !== 0 || rejectedNavigations !== 0 || rejectedWindowOpens !== 0
    || showAttempts !== 0 || focusAttempts !== 0 || win.isVisible() || win.isFocused()) {
    fail('renderer exceeded its offline, hidden and non-focusable guards');
  }
  return { png, image, sourceSha256: actualSvgHash };
}

async function main() {
  if (process.versions.electron !== EXPECTED_ELECTRON) fail(`expected Electron ${EXPECTED_ELECTRON}, got ${process.versions.electron}`);
  const sourcePath = process.env.TOKENELO_ICON_SOURCE;
  const outputDir = process.env.TOKENELO_ICON_OUTPUT_DIR;
  const expectedSvgHash = process.env.TOKENELO_ICON_SOURCE_SHA256;
  if (!sourcePath || !outputDir || !expectedSvgHash || !path.isAbsolute(sourcePath) || !path.isAbsolute(outputDir)) {
    fail('absolute task-owned SVG/output paths and the source pin are required');
  }
  if (!fs.statSync(outputDir).isDirectory()) fail('icon output path is not a directory');
  const svgText = fs.readFileSync(sourcePath, 'utf8');
  const { png: masterPng, image: masterImage, sourceSha256 } = await renderMasterPng(svgText, expectedSvgHash);

  const allSizes = [...new Set([...ICO_SIZES, ...MACOS_ICONSET_FRAMES.map(frame => frame.size)])].sort((a, b) => a - b);
  const pngFrames = new Map([[1024, masterPng]]);
  const frameRecords = [];
  for (const size of allSizes) {
    let png = pngFrames.get(size);
    if (!png) {
      const resized = masterImage.resize({ width: size, height: size, quality: 'best' });
      const dimensions = resized.getSize();
      if (dimensions.width !== size || dimensions.height !== size) fail(`nativeImage resize returned ${dimensions.width}x${dimensions.height} for ${size}px`);
      png = resized.toPNG();
      assertExactPngSize(png, size, `resized ${size}px frame`);
      if (alphaAt(resized, 0, 0) !== 0 || resized.toBitmap().length !== size * size * 4) {
        fail(`resized ${size}px frame lost transparent corners or exact pixels`);
      }
      pngFrames.set(size, png);
    }
    frameRecords.push({ size, pngSha256: sha256(png), pngBytes: png.length });
  }

  const icoFrames = ICO_SIZES.map(size => ({ size, png: pngFrames.get(size) }));
  const ico = encodeIco(icoFrames);
  const linuxPng = pngFrames.get(512);
  const macosIconsetDir = path.join(outputDir, 'tokenelo-macos.iconset');
  fs.mkdirSync(macosIconsetDir, { recursive: false });
  const macosIconsetFrames = MACOS_ICONSET_FRAMES.map(({ name, size }) => {
    const png = pngFrames.get(size);
    if (!png) fail(`native PNG frame ${size}px is unavailable for ${name}`);
    assertExactPngSize(png, size, `macOS iconset ${name}`);
    writeNewFile(path.join(macosIconsetDir, name), png);
    return { name, size, pngBytes: png.length, sha256: sha256(png) };
  });
  const outputs = [
    ['tokenelo-1024.png', masterPng],
    ['tokenelo-linux-512.png', linuxPng],
    ['tokenelo-windows.ico', ico],
  ];
  for (const [name, data] of outputs) writeNewFile(path.join(outputDir, name), data);
  const result = {
    status: 'PASS_RENDERER',
    electronVersion: process.versions.electron,
    chromiumVersion: process.versions.chrome,
    sourceSha256,
    renderer: 'Electron offscreen BrowserWindow, hidden, focusable=false, software Canvas, GPU disabled',
    networkNavigationWindowFocusCounts: { blockedNetworkRequests, rejectedNavigations, rejectedWindowOpens, showAttempts, focusAttempts },
    sourceSamples: { transparentCorner: true, exactMintInterior: true, exactNavyGlyph: true },
    icoFrames: ICO_SIZES,
    macosIconset: { directory: 'tokenelo-macos.iconset', fileCount: macosIconsetFrames.length },
    macosIconsetFrames,
    nativeMacosIcns: {
      status: 'REQUIRES_PINNED_NATIVE_ICONUTIL_ARTIFACT',
      binding: '../native/native-iconutil-binding.json',
      rendererCreatesIcns: false,
    },
    pngFrames: frameRecords,
    outputs: outputs.map(([name, data]) => ({ name, bytes: data.length, sha256: sha256(data) })),
  };
  writeNewFile(path.join(outputDir, 'renderer-manifest.json'), Buffer.from(`${JSON.stringify(result, null, 2)}\n`, 'utf8'));
  console.log(JSON.stringify(result));
  if (activeWindow && !activeWindow.isDestroyed()) activeWindow.close();
  activeWindow = null;
}

const userDataRoot = process.env.TOKENELO_ICON_USER_DATA_DIR;
if (!userDataRoot || !path.isAbsolute(userDataRoot)) fail('task-owned Electron user-data root is missing');
for (const [name, relative] of Object.entries({ userData: 'user-data', sessionData: 'session', cache: 'cache' })) {
  const directory = path.join(userDataRoot, relative);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(main).then(() => app.quit()).catch(error => {
  console.error(error?.stack ?? String(error));
  if (activeWindow && !activeWindow.isDestroyed()) activeWindow.close();
  app.exit(1);
});
