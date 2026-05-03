import { readFileSync, statSync } from 'fs';
import { basename } from 'path';
const MEDIA_DIRECTIVE_RE = /(^|\n)[ \t]*MEDIA:([^\r\n]+)(?=\r?\n|$)/gi;
export function parseOutboundMediaMessage(text) {
    const files = [];
    const withoutDirectives = text.replace(MEDIA_DIRECTIVE_RE, (_match, _prefix, rawPath) => {
        const filePath = rawPath.trim();
        if (filePath)
            files.push(resolveOutboundMediaFile(filePath));
        return '';
    });
    return {
        text: cleanupCaptionText(withoutDirectives),
        files,
    };
}
export async function uploadChatAttachment(params) {
    const form = new FormData();
    const bytes = readFileSync(params.file.path);
    const blob = new Blob([bytes], { type: params.file.mimeType });
    form.append('file', blob, params.file.fileName);
    if (params.text?.trim())
        form.append('text', params.text.trim());
    const response = await fetch(buildNextCompanyApiUrl(params.account, `/api/organizations/${encodeURIComponent(params.organizationId)}/chat/channels/${encodeURIComponent(params.channelId)}/messages/upload`), {
        method: 'POST',
        headers: {
            'X-Api-Key': params.account.apiKey,
            Accept: 'application/json',
        },
        body: form,
    });
    if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`NextCompany chat upload failed: ${response.status}${responseText ? ` ${responseText}` : ''}`);
    }
}
function resolveOutboundMediaFile(filePath) {
    const stat = statSync(filePath);
    if (!stat.isFile())
        throw new Error(`Outbound media path is not a file: ${filePath}`);
    const fileName = basename(filePath);
    return {
        path: filePath,
        fileName,
        mimeType: guessContentType(fileName),
        sizeBytes: stat.size,
    };
}
function cleanupCaptionText(value) {
    return value
        .replace(/[ \t]+\r?\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function buildNextCompanyApiUrl(account, path) {
    const baseUrl = account.url
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://')
        .replace(/\/ws\/agents\/?$/, '')
        .replace(/\/+$/, '');
    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
function guessContentType(fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    switch (ext) {
        case 'pdf':
            return 'application/pdf';
        case 'doc':
            return 'application/msword';
        case 'docx':
            return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'xls':
            return 'application/vnd.ms-excel';
        case 'xlsx':
            return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case 'ppt':
            return 'application/vnd.ms-powerpoint';
        case 'pptx':
            return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        case 'gif':
            return 'image/gif';
        case 'webp':
            return 'image/webp';
        case 'txt':
            return 'text/plain';
        case 'csv':
            return 'text/csv';
        case 'json':
            return 'application/json';
        case 'zip':
            return 'application/zip';
        default:
            return 'application/octet-stream';
    }
}
