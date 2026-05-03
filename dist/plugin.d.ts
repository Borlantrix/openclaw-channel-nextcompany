import { type NextCompanyAccountConfig } from './types.js';
export declare const plugin: {
    id: string;
    meta: {
        id: string;
        label: string;
        selectionLabel: string;
        detailLabel: string;
        blurb: string;
        docsPath: string;
    };
    capabilities: {
        messaging: boolean;
        reactions: boolean;
        threads: boolean;
        groups: boolean;
        streaming: boolean;
    };
    config: {
        resolveAccount: (raw: unknown) => NextCompanyAccountConfig;
        validateAccount: (raw: unknown) => {
            ok: false;
            error: string;
            account?: undefined;
        } | {
            ok: true;
            account: NextCompanyAccountConfig;
            error?: undefined;
        };
    };
    gateway: {
        startAccount: (ctx: {
            accountId: string;
            account: NextCompanyAccountConfig;
            dispatch: (envelope: unknown) => void;
        }) => Promise<void>;
        stopAccount: (ctx: {
            accountId: string;
        }) => Promise<void>;
    };
    outbound: {
        sendMessage: (ctx: {
            accountId: string;
            text: string;
            replyToMessageId?: string;
        }) => Promise<void>;
    };
    heartbeat: {
        checkReady: (ctx: {
            accountId: string;
        }) => Promise<{
            ok: boolean;
            reason: string;
        }>;
    };
};
//# sourceMappingURL=plugin.d.ts.map