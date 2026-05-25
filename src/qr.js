import { promises as fs } from 'node:fs';
import jpeg from 'jpeg-js';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

const DEFAULT_QR_WIDTH = parseInteger(
  process.env.LM_WEB_MCP_DEFAULT_QR_WIDTH,
  768,
);
const MAX_QR_TEXT_CHARS = parseInteger(
  process.env.LM_WEB_MCP_MAX_QR_TEXT_CHARS,
  4_000,
);
const MAX_QR_IMAGE_BYTES = parseInteger(
  process.env.LM_WEB_MCP_MAX_QR_IMAGE_BYTES,
  10_000_000,
);

const ERROR_CORRECTION_LEVELS = new Set(['L', 'M', 'Q', 'H']);

export async function generateQrCode({
  text,
  errorCorrectionLevel = 'M',
  margin = 4,
  width = DEFAULT_QR_WIDTH,
  darkColor = '#000000ff',
  lightColor = '#ffffffff',
}) {
  const qrText = normalizeQrText(text);
  const level = normalizeErrorCorrectionLevel(errorCorrectionLevel);
  const normalizedWidth = clamp(width, 128, 2_048);
  const normalizedMargin = clamp(margin, 0, 16);
  const buffer = await QRCode.toBuffer(qrText, {
    type: 'png',
    errorCorrectionLevel: level,
    margin: normalizedMargin,
    width: normalizedWidth,
    color: {
      dark: normalizeQrColor(darkColor, '#000000ff'),
      light: normalizeQrColor(lightColor, '#ffffffff'),
    },
  });
  const image = decodePng(buffer);

  return {
    text: qrText,
    mimeType: 'image/png',
    data: buffer.toString('base64'),
    width: image.width,
    height: image.height,
    sizeBytes: buffer.length,
    errorCorrectionLevel: level,
    margin: normalizedMargin,
  };
}

export async function scanQrCode({
  imageUrl,
  imagePath,
  imageBase64,
  mimeType,
}) {
  const sourceCount = [imageUrl, imagePath, imageBase64].filter(Boolean).length;

  if (sourceCount !== 1) {
    throw new Error('Provide exactly one of imageUrl, imagePath, or imageBase64.');
  }

  const sourceImage = await loadImageBytes({
    imageUrl,
    imagePath,
    imageBase64,
    mimeType,
  });
  const decoded = decodeImage(sourceImage.bytes, sourceImage.mimeType);
  const code = jsQR(
    Uint8ClampedArray.from(decoded.data),
    decoded.width,
    decoded.height,
    { inversionAttempts: 'attemptBoth' },
  );

  if (!code) {
    throw new Error('No QR code was found in the provided image.');
  }

  return {
    text: code.data,
    source: sourceImage.source,
    mimeType: decoded.mimeType,
    width: decoded.width,
    height: decoded.height,
    location: normalizeQrLocation(code.location),
  };
}

async function loadImageBytes({
  imageUrl,
  imagePath,
  imageBase64,
  mimeType,
}) {
  if (imageUrl) {
    return loadImageUrl(imageUrl);
  }

  if (imagePath) {
    const bytes = await fs.readFile(String(imagePath));
    assertImageSize(bytes.length);
    return {
      bytes,
      mimeType: sniffMimeType(bytes, mimeType),
      source: 'file',
    };
  }

  const parsed = parseBase64Image(imageBase64, mimeType);
  assertImageSize(parsed.bytes.length);

  return {
    ...parsed,
    source: 'base64',
  };
}

async function loadImageUrl(value) {
  const url = new URL(String(value));

  if (url.protocol === 'data:') {
    const parsed = parseBase64Image(url.toString());
    assertImageSize(parsed.bytes.length);
    return {
      ...parsed,
      source: 'data-url',
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('imageUrl must use http, https, or data URL.');
  }

  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: {
      accept: 'image/png,image/jpeg,image/jpg,*/*;q=0.8',
      'user-agent': 'local-web-mcp/0.1 (+https://github.com/modelcontextprotocol)',
    },
  });

  if (!response.ok) {
    throw new Error(`Image request failed with ${response.status} ${response.statusText}`.trim());
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_QR_IMAGE_BYTES) {
    throw new Error(
      `Refusing to download ${contentLength} bytes because it exceeds the ${MAX_QR_IMAGE_BYTES}-byte QR image limit.`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  assertImageSize(bytes.length);

  return {
    bytes,
    mimeType: sniffMimeType(bytes, response.headers.get('content-type')),
    source: 'url',
  };
}

function parseBase64Image(value, mimeType) {
  const raw = String(value ?? '').trim();
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
  const base64 = match ? match[2] : raw.replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');

  if (bytes.length === 0) {
    throw new Error('imageBase64 did not contain image bytes.');
  }

  return {
    bytes,
    mimeType: sniffMimeType(bytes, mimeType || match?.[1]),
  };
}

function decodeImage(bytes, mimeType) {
  const normalizedMimeType = sniffMimeType(bytes, mimeType);

  if (normalizedMimeType === 'image/png') {
    return {
      ...decodePng(bytes),
      mimeType: normalizedMimeType,
    };
  }

  if (normalizedMimeType === 'image/jpeg') {
    return {
      ...jpeg.decode(bytes, { useTArray: true }),
      mimeType: normalizedMimeType,
    };
  }

  throw new Error('Only PNG and JPEG QR images are supported.');
}

function decodePng(bytes) {
  try {
    return PNG.sync.read(bytes);
  } catch (error) {
    throw new Error(`Could not decode PNG image: ${errorMessage(error)}`);
  }
}

function sniffMimeType(bytes, mimeType) {
  const normalized = String(mimeType ?? '').split(';')[0].trim().toLowerCase();

  if (normalized === 'image/png' || normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  throw new Error('Unsupported image type. Use PNG or JPEG.');
}

function assertImageSize(sizeBytes) {
  if (sizeBytes <= 0) {
    throw new Error('Image is empty.');
  }

  if (sizeBytes > MAX_QR_IMAGE_BYTES) {
    throw new Error(
      `QR image is ${sizeBytes} bytes, which exceeds the ${MAX_QR_IMAGE_BYTES}-byte limit.`,
    );
  }
}

function normalizeQrText(value) {
  const text = String(value ?? '');

  if (!text) {
    throw new Error('QR text cannot be empty.');
  }

  if (text.length > MAX_QR_TEXT_CHARS) {
    throw new Error(
      `QR text is ${text.length} characters, which exceeds the ${MAX_QR_TEXT_CHARS}-character limit.`,
    );
  }

  return text;
}

function normalizeErrorCorrectionLevel(value) {
  const level = String(value ?? 'M').trim().toUpperCase();

  if (!ERROR_CORRECTION_LEVELS.has(level)) {
    throw new Error('errorCorrectionLevel must be one of L, M, Q, or H.');
  }

  return level;
}

function normalizeQrColor(value, fallback) {
  const color = String(value ?? '').trim();

  if (/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) {
    return color;
  }

  return fallback;
}

function normalizeQrLocation(location) {
  if (!location) {
    return null;
  }

  return {
    topLeft: normalizePoint(location.topLeftCorner),
    topRight: normalizePoint(location.topRightCorner),
    bottomRight: normalizePoint(location.bottomRightCorner),
    bottomLeft: normalizePoint(location.bottomLeftCorner),
  };
}

function normalizePoint(point) {
  return {
    x: Math.round(Number(point?.x ?? 0)),
    y: Math.round(Number(point?.y ?? 0)),
  };
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.min(Math.max(Math.trunc(number), min), max);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
