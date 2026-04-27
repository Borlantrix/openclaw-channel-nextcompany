import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractHtmlImageSources,
  resolveImageAttachmentConfig,
  resolveImageAttachments,
} from '../dist/media.js';

const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/luzlkgAAAABJRU5ErkJggg==',
  'base64',
);

test('extractHtmlImageSources resolves relative img URLs and ignores data URLs', () => {
  const sources = extractHtmlImageSources(
    '<p>hi<img src="/media/a.png?token=secret#frag" alt="screen"><img src="data:image/png;base64,abc"></p>',
    'https://nextcompany.example/app',
    'card_comment_inline',
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, 'https://nextcompany.example/media/a.png?token=secret');
  assert.equal(sources[0].alt, 'screen');
  assert.equal(sources[0].sourceKind, 'card_comment_inline');
});

test('resolveImageAttachments downloads same-origin images as base64 attachments', async () => {
  const baseUrl = 'https://nextcompany.example';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, `${baseUrl}/comment-image.png`);
    assert.equal(init.headers['X-Api-Key'], 'secret-api-key');
    assert.equal(init.headers.Authorization, 'Bearer secret-api-key');
    return new Response(pngBytes, {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': String(pngBytes.length),
      },
    });
  };

  try {
    const [source] = extractHtmlImageSources(
      '<img src="/comment-image.png" alt="chart">',
      baseUrl,
      'card_comment_inline',
    );
    const result = await resolveImageAttachments({
      account: { id: 'default', apiKey: 'secret-api-key', url: `${baseUrl}/ws/agents` },
      baseUrl,
      sources: [source],
      config: resolveImageAttachmentConfig({}),
    });

    assert.equal(result.skipped.length, 0);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0].mimeType, 'image/png');
    assert.equal(result.attachments[0].content, pngBytes.toString('base64'));
    assert.equal(result.attachments[0].sourceUrl, `${baseUrl}/comment-image.png`);
    assert.equal(result.attachments[0].alt, 'chart');
    assert.equal(typeof result.attachments[0].sha256, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
