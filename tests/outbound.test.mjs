import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  parseOutboundMediaMessage,
  uploadChatAttachment,
} from '../dist/outbound.js';

test('parseOutboundMediaMessage extracts MEDIA file directives and leaves caption text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-outbound-'));
  const filePath = join(dir, 'report.docx');
  writeFileSync(filePath, 'docx bytes');

  try {
    const parsed = parseOutboundMediaMessage(`Segue o ficheiro.\nMEDIA:${filePath}\nObrigado.`);

    assert.equal(parsed.text, 'Segue o ficheiro.\nObrigado.');
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].path, filePath);
    assert.equal(parsed.files[0].fileName, 'report.docx');
    assert.equal(parsed.files[0].mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(parsed.files[0].sizeBytes, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('uploadChatAttachment posts multipart file to NextCompany chat upload endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nc-upload-'));
  const filePath = join(dir, 'note.txt');
  writeFileSync(filePath, 'hello from agent');
  const [file] = parseOutboundMediaMessage(`MEDIA:${filePath}`).files;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://nextcompany.example/api/organizations/org-1/chat/channels/channel-1/messages/upload');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-Api-Key'], 'secret-api-key');
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.headers['Content-Type'], undefined);

    const request = new Request(url, init);
    const form = await request.formData();
    assert.equal(form.get('text'), 'caption');
    const uploaded = form.get('file');
    assert.equal(uploaded.name, 'note.txt');
    assert.equal(uploaded.type, 'text/plain');
    assert.equal(await uploaded.text(), 'hello from agent');

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await uploadChatAttachment({
      account: { id: 'default', apiKey: 'secret-api-key', url: 'wss://nextcompany.example/ws/agents' },
      organizationId: 'org-1',
      channelId: 'channel-1',
      file,
      text: 'caption',
    });
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
