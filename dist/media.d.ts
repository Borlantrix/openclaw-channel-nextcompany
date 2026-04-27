import type { NextCompanyAccountConfig } from './types.js';
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
export declare function resolveImageAttachmentConfig(raw: Record<string, unknown> | undefined): ImageAttachmentConfig;
export declare function extractHtmlImageSources(html: string | undefined, baseUrl: string, sourceKind: string): HtmlImageSource[];
export declare function buildDirectImageSource(params: {
    url?: string;
    baseUrl: string;
    sourceKind: string;
    alt?: string;
}): HtmlImageSource | undefined;
export declare function resolveImageAttachments(params: {
    account: NextCompanyAccountConfig;
    baseUrl: string;
    sources: HtmlImageSource[];
    config: ImageAttachmentConfig;
}): Promise<ResolvedImageAttachments>;
//# sourceMappingURL=media.d.ts.map