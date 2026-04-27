import { createHash } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Parser } from 'htmlparser2';
import type { NextCompanyAccountConfig } from './types.js';

const DEFAULT_MAX_IMAGES = 5;
const DEFAULT_MAX_BYTES_PER_IMAGE = 8 * 1024 * 1024;
const DEFAULT_MAX_AGGREGATE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_AGGREGATE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 2;
const DEFAULT_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface ImageAttachmentConfig {
  enabled: boolean;
  allowExternalImages: boolean;
  allowedExternalHosts: string[];
  allowedMimeTypes: string[];
  maxImages: number;
  maxBytesPerImage: number;
  maxAggregateBytes: number;
  timeoutMs: number;
  aggregateTimeoutMs: number;
  maxRedirects: number;
}

export interface HtmlImageSource {
  url: string;
  normalizedUrl: string;
  alt?: string;
  title?: string;
  width?: string;
  height?: string;
  order: number;
  sourceKind: string;
}

export interface OpenClawImageAttachment {
  mimeType: string;
  content: string;
  fileName?: string;
  sourceUrl?: string;
  alt?: string;
  sizeBytes?: number;
  sha256?: string;
  sourceKind?: string;
}

export interface SkippedImageAttachment {
  sourceKind: string;
  reason: string;
  mimeType?: string;
  sizeBytes?: number;
  urlHost?: string;
  urlPath?: string;
}

export interface ResolvedImageAttachments {
  attachments: OpenClawImageAttachment[];
  skipped: SkippedImageAttachment[];
}

interface FetchResult {
  attachment?: OpenClawImageAttachment;
  skipped?: SkippedImageAttachment;
}

export function resolveImageAttachmentConfig(raw: Record<string, unknown> | undefined): ImageAttachmentConfig {
  const imageConfig = raw?.['imageAttachments'] as Record<string, unknown> | undefined;
  const allowedMimeTypes = Array.isArray(imageConfig?.['allowedMimeTypes'])
    ? imageConfig['allowedMimeTypes'].map((value) => String(value).toLowerCase()).filter((value) => DEFAULT_ALLOWED_MIME_TYPES.includes(value))
    : DEFAULT_ALLOWED_MIME_TYPES;

  return {
    enabled: imageConfig?.['enabled'] === undefined ? true : Boolean(imageConfig['enabled']),
    allowExternalImages: Boolean(imageConfig?.['allowExternalImages']),
    allowedExternalHosts: Array.isArray(imageConfig?.['allowedExternalHosts'])
      ? imageConfig['allowedExternalHosts'].map((value) => String(value).toLowerCase()).filter(Boolean)
      : [],
    allowedMimeTypes,
    maxImages: positiveInteger(imageConfig?.['maxImages'], DEFAULT_MAX_IMAGES),
    maxBytesPerImage: positiveInteger(imageConfig?.['maxBytesPerImage'], DEFAULT_MAX_BYTES_PER_IMAGE),
    maxAggregateBytes: positiveInteger(imageConfig?.['maxAggregateBytes'], DEFAULT_MAX_AGGREGATE_BYTES),
    timeoutMs: positiveInteger(imageConfig?.['timeoutMs'], DEFAULT_TIMEOUT_MS),
    aggregateTimeoutMs: positiveInteger(imageConfig?.['aggregateTimeoutMs'], DEFAULT_AGGREGATE_TIMEOUT_MS),
    maxRedirects: positiveInteger(imageConfig?.['maxRedirects'], DEFAULT_MAX_REDIRECTS),
  };
}

export function extractHtmlImageSources(html: string | undefined, baseUrl: string, sourceKind: string): HtmlImageSource[] {
  if (!html?.trim()) return [];

  const images: HtmlImageSource[] = [];
  let order = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name.toLowerCase() !== 'img') return;
      const rawSrc = attributes['src']?.trim();
      if (!rawSrc || rawSrc.toLowerCase().startsWith('data:')) return;

      try {
        const resolved = new URL(rawSrc, baseUrl);
        if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
        resolved.hash = '';
        images.push({
          url: resolved.toString(),
          normalizedUrl: normalizeUrlForDedupe(resolved),
          alt: trimOptional(attributes['alt']),
          title: trimOptional(attributes['title']),
          width: trimOptional(attributes['width']),
          height: trimOptional(attributes['height']),
          order: order++,
          sourceKind,
        });
      } catch {
        // Ignore malformed image references and keep processing the rest of the HTML.
      }
    },
  }, { decodeEntities: true });

  parser.write(html);
  parser.end();
  return images;
}

export function buildDirectImageSource(params: {
  url?: string;
  baseUrl: string;
  sourceKind: string;
  alt?: string;
}): HtmlImageSource | undefined {
  if (!params.url?.trim()) return undefined;
  try {
    const resolved = new URL(params.url, params.baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
    resolved.hash = '';
    return {
      url: resolved.toString(),
      normalizedUrl: normalizeUrlForDedupe(resolved),
      alt: trimOptional(params.alt),
      order: 0,
      sourceKind: params.sourceKind,
    };
  } catch {
    return undefined;
  }
}

export async function resolveImageAttachments(params: {
  account: NextCompanyAccountConfig;
  baseUrl: string;
  sources: HtmlImageSource[];
  config: ImageAttachmentConfig;
}): Promise<ResolvedImageAttachments> {
  if (!params.config.enabled || params.sources.length === 0) return { attachments: [], skipped: [] };

  const startedAt = Date.now();
  const attachments: OpenClawImageAttachment[] = [];
  const skipped: SkippedImageAttachment[] = [];
  const seenUrls = new Set<string>();
  const seenHashes = new Set<string>();
  let aggregateBytes = 0;

  for (const source of params.sources.sort((a, b) => a.order - b.order)) {
    if (attachments.length >= params.config.maxImages) {
      skipped.push(toSkipped(source, 'max_count'));
      continue;
    }
    if (Date.now() - startedAt > params.config.aggregateTimeoutMs) {
      skipped.push(toSkipped(source, 'aggregate_timeout'));
      continue;
    }
    if (seenUrls.has(source.normalizedUrl)) {
      skipped.push(toSkipped(source, 'duplicate_url'));
      continue;
    }
    seenUrls.add(source.normalizedUrl);

    const result = await fetchImageAttachment({
      account: params.account,
      baseUrl: params.baseUrl,
      source,
      config: params.config,
      remainingAggregateBytes: params.config.maxAggregateBytes - aggregateBytes,
    });

    if (result.skipped) {
      skipped.push(result.skipped);
      continue;
    }
    if (!result.attachment) continue;
    if (result.attachment.sha256 && seenHashes.has(result.attachment.sha256)) {
      skipped.push(toSkipped(source, 'duplicate_content', result.attachment.mimeType, result.attachment.sizeBytes));
      continue;
    }

    if (result.attachment.sha256) seenHashes.add(result.attachment.sha256);
    aggregateBytes += result.attachment.sizeBytes ?? 0;
    attachments.push(result.attachment);
  }

  return { attachments, skipped };
}

async function fetchImageAttachment(params: {
  account: NextCompanyAccountConfig;
  baseUrl: string;
  source: HtmlImageSource;
  config: ImageAttachmentConfig;
  remainingAggregateBytes: number;
}): Promise<FetchResult> {
  let currentUrl = params.source.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.config.timeoutMs);

  try {
    for (let redirect = 0; redirect <= params.config.maxRedirects; redirect++) {
      const policySkip = await validateUrlPolicy(currentUrl, params.baseUrl, params.config);
      if (policySkip) return { skipped: { ...toSkipped(params.source, policySkip), ...sanitizeUrlParts(currentUrl) } };

      const response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: authHeadersForUrl(currentUrl, params.baseUrl, params.account),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { skipped: toSkipped(params.source, 'redirect_without_location') };
        if (redirect >= params.config.maxRedirects) return { skipped: toSkipped(params.source, 'too_many_redirects') };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        return { skipped: toSkipped(params.source, response.status === 401 || response.status === 403 ? 'unauthorized' : 'download_error') };
      }

      const headerMime = normalizeMime(response.headers.get('content-type'));
      const contentLength = parseContentLength(response.headers.get('content-length'));
      if (contentLength !== undefined && contentLength > params.config.maxBytesPerImage) {
        return { skipped: toSkipped(params.source, 'too_large', headerMime, contentLength) };
      }
      if (contentLength !== undefined && contentLength > params.remainingAggregateBytes) {
        return { skipped: toSkipped(params.source, 'aggregate_too_large', headerMime, contentLength) };
      }

      const maxBytes = Math.min(params.config.maxBytesPerImage, Math.max(0, params.remainingAggregateBytes));
      const buffer = await readResponseLimited(response, maxBytes);
      const magicMime = detectImageMime(buffer);
      const finalMime = chooseMime(headerMime, magicMime, params.config.allowedMimeTypes);
      if (!finalMime) {
        return { skipped: toSkipped(params.source, 'unsupported_mime', headerMime, buffer.length) };
      }

      const sha256 = createHash('sha256').update(buffer).digest('hex');
      return {
        attachment: {
          mimeType: finalMime,
          content: buffer.toString('base64'),
          fileName: buildFileName(params.source.order + 1, currentUrl, finalMime),
          sourceUrl: sanitizeUrl(currentUrl),
          alt: params.source.alt,
          sizeBytes: buffer.length,
          sha256,
          sourceKind: params.source.sourceKind,
        },
      };
    }

    return { skipped: toSkipped(params.source, 'too_many_redirects') };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'timeout'
      : error instanceof Error && error.message === 'too_large'
        ? 'too_large'
        : error instanceof Error && error.message === 'aggregate_too_large'
          ? 'aggregate_too_large'
          : 'download_error';
    return { skipped: toSkipped(params.source, reason) };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseLimited(response: Response, maxBytes: number): Promise<Buffer> {
  if (maxBytes <= 0) throw new Error('aggregate_too_large');
  if (!response.body) return Buffer.from(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error('too_large');
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function validateUrlPolicy(url: string, baseUrl: string, config: ImageAttachmentConfig): Promise<string | undefined> {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(url);
    base = new URL(baseUrl);
  } catch {
    return 'invalid_url';
  }

  if (parsed.protocol === 'http:' && !isLocalhost(parsed.hostname)) return 'insecure_http';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost(parsed.hostname))) return 'unsupported_scheme';
  if (sameOrigin(parsed, base)) return undefined;
  if (!config.allowExternalImages) return 'external_url_blocked';
  if (!config.allowedExternalHosts.includes(parsed.hostname.toLowerCase())) return 'external_url_blocked';
  if (await resolvesToPrivateAddress(parsed.hostname)) return 'external_private_address_blocked';
  return undefined;
}

function authHeadersForUrl(url: string, baseUrl: string, account: NextCompanyAccountConfig): Record<string, string> {
  try {
    if (!sameOrigin(new URL(url), new URL(baseUrl))) return { Accept: DEFAULT_ALLOWED_MIME_TYPES.join(', ') };
  } catch {
    return { Accept: DEFAULT_ALLOWED_MIME_TYPES.join(', ') };
  }

  return {
    Accept: DEFAULT_ALLOWED_MIME_TYPES.join(', '),
    'X-Api-Key': account.apiKey,
    Authorization: `Bearer ${account.apiKey}`,
  };
}

function chooseMime(headerMime: string | undefined, magicMime: string | undefined, allowedMimeTypes: string[]): string | undefined {
  if (magicMime && allowedMimeTypes.includes(magicMime)) return magicMime;
  if (headerMime && allowedMimeTypes.includes(headerMime) && headerMime !== 'application/octet-stream') return headerMime;
  return undefined;
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6) {
    const sig = buffer.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return undefined;
}

function normalizeUrlForDedupe(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = '';
  return copy.toString();
}

function sanitizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function sanitizeUrlParts(url: string): { urlHost?: string; urlPath?: string } {
  try {
    const parsed = new URL(url);
    return { urlHost: parsed.hostname, urlPath: parsed.pathname };
  } catch {
    return {};
  }
}

function toSkipped(source: HtmlImageSource, reason: string, mimeType?: string, sizeBytes?: number): SkippedImageAttachment {
  return {
    sourceKind: source.sourceKind,
    reason,
    mimeType,
    sizeBytes,
    ...sanitizeUrlParts(source.url),
  };
}

function normalizeMime(value: string | null): string | undefined {
  const mime = value?.split(';')[0]?.trim().toLowerCase();
  return mime || undefined;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function trimOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname.toLowerCase() === b.hostname.toLowerCase() && a.port === b.port;
}

function isLocalhost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

async function resolvesToPrivateAddress(hostname: string): Promise<boolean> {
  if (isPrivateAddress(hostname)) return true;
  try {
    const records = await lookup(hostname, { all: true });
    return records.some((record) => isPrivateAddress(record.address));
  } catch {
    return true;
  }
}

function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const parts = address.split('.').map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || address === '0.0.0.0';
  }
  if (kind === 6) {
    const normalized = address.toLowerCase();
    return normalized === '::1'
      || normalized === '::'
      || normalized.startsWith('fe80:')
      || normalized.startsWith('fc')
      || normalized.startsWith('fd');
  }
  return isLocalhost(address);
}

function buildFileName(index: number, url: string, mimeType: string): string {
  try {
    const basename = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (basename && /\.[a-z0-9]{2,5}$/i.test(basename)) return basename;
  } catch {
    // Fall back to generated name.
  }

  const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.replace('image/', '');
  return `comment-image-${index}.${ext}`;
}
