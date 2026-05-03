import type { NextCompanyAccountConfig } from './types.js';
export interface OutboundMediaFile {
    path: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
}
export interface ParsedOutboundMediaMessage {
    text: string;
    files: OutboundMediaFile[];
}
export declare function parseOutboundMediaMessage(text: string): ParsedOutboundMediaMessage;
export declare function uploadChatAttachment(params: {
    account: NextCompanyAccountConfig;
    organizationId: string;
    channelId: string;
    file: OutboundMediaFile;
    text?: string;
}): Promise<void>;
//# sourceMappingURL=outbound.d.ts.map