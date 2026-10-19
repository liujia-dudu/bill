import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Store } from '../src/storage/store.mjs';
import { Attachments } from '../src/core/attachments.mjs';
import { configuration, ROOT } from '../src/server/config.mjs';

const sampleOptions = (caseId, catalog = false) => ({
  skip:
    !existsSync(path.join(ROOT, 'data/samples', caseId, 'input.jpg')) ||
    (catalog && !existsSync(path.join(ROOT, 'data/samples/invoice-cases.json')))
      ? 'Private local QR sample is not distributed'
      : false,
});

async function environment() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'invoice-qr-'));
  const config = configuration({ dataDir });
  const store = new Store(dataDir);
  const conversation = store.createConversation();
  const attachments = new Attachments(store, config);
  return {
    store,
    config,
    conversation,
    attachments,
    upload: async (caseId) =>
      attachments.upload(conversation.id, {
        // The upload name must not supply the sample identity or decoded address.
        originalname: 'photo.jpg',
        buffer: await readFile(path.join(ROOT, 'data/samples', caseId, 'input.jpg')),
      }),
  };
}

test(
  'uploaded t3 is decoded from its bytes with validated repair evidence',
  sampleOptions('t3', true),
  async () => {
    const e = await environment();
    try {
      const input = await e.upload('t3');
      const result = await e.attachments.read(e.conversation.id, input.id);
      const catalog = JSON.parse(
        await readFile(path.join(ROOT, 'data/samples/invoice-cases.json')),
      );
      const expected = catalog.cases
        .find((item) => item.id === 't3')
        .qr_candidates.find((item) => item.decode_valid).original_url;
      assert.deepEqual(result.urls, [expected]);
      assert.equal(result.decodeError, null);
      assert.equal(result.decodeMethod, 'version5_fixed_pattern_repair');
      const stored = e.store.get('inputs', input.id);
      assert.equal(stored.decodeEvidence.valid, true);
      assert.equal(String(stored.decodeEvidence.decoderMetadata.Version), '5');
      assert.equal(stored.decodeEvidence.attempts, 750);
      assert.ok(stored.decodeEvidence.consistentSuccesses >= 3);
      assert.equal(stored.decodeEvidence.formatBitsReplaced, false);
      assert.equal(stored.decodeEvidence.dataModulesReplaced, false);
      // Successful reads use the cache without launching a decoder again.
      e.config.python = 'nonexistent-qr-test-python';
      assert.deepEqual(await e.attachments.read(e.conversation.id, input.id), result);
    } finally {
      e.store.close();
    }
  },
);

test(
  'a failed t3 attachment from the old decoder is retried without uploading again',
  sampleOptions('t3'),
  async () => {
    const e = await environment();
    try {
      const input = await e.upload('t3');
      e.store.write('inputs', {
        ...input,
        decoded: true,
        urls: [],
        decodeError: '旧版本解码失败',
      });
      assert.equal(e.attachments.needsDecode(e.store.get('inputs', input.id)), true);
      const result = await e.attachments.read(e.conversation.id, input.id);
      assert.equal(result.urls.length, 1);
      assert.equal(new URL(result.urls[0]).hostname, 'fpkj.vpiaotong.com');
      assert.equal(result.decodeError, null);
      assert.equal(e.store.get('inputs', input.id).file, input.file);
      assert.equal(e.attachments.needsDecode(e.store.get('inputs', input.id)), false);
    } finally {
      e.store.close();
    }
  },
);

test(
  'normal QR images keep direct decoding and old successful results remain usable',
  sampleOptions('t2'),
  async () => {
    const e = await environment();
    try {
      const input = await e.upload('t2');
      const result = await e.attachments.read(e.conversation.id, input.id);
      assert.equal(result.decodeMethod, 'direct_zxing_cpp');
      assert.equal(result.urls.length, 1);
      const cached = e.store.get('inputs', input.id);
      delete cached.decodeRevision;
      e.store.write('inputs', cached);
      e.config.python = 'nonexistent-qr-test-python';
      assert.equal(e.attachments.needsDecode(cached), false);
      assert.deepEqual(await e.attachments.read(e.conversation.id, input.id), result);
    } finally {
      e.store.close();
    }
  },
);

test('synthetic QR uploads decode without private invoice samples', async () => {
  const e = await environment();
  try {
    const buffer = execFileSync(
      e.config.python,
      [path.join(ROOT, 'tests/fixtures/qr/synthetic.py')],
      {
        windowsHide: true,
      },
    );
    const input = await e.attachments.upload(e.conversation.id, {
      originalname: 'photo.png',
      buffer,
    });
    const result = await e.attachments.read(e.conversation.id, input.id);
    assert.deepEqual(result.urls, ['https://example.invalid/invoice?order=synthetic']);
    assert.equal(result.decodeMethod, 'direct_zxing_cpp');
    assert.equal(result.decodeError, null);
  } finally {
    e.store.close();
  }
});

test('an image with no QR is rejected and its current failure is cached', async () => {
  const e = await environment();
  try {
    const input = await e.attachments.upload(e.conversation.id, {
      originalname: 'photo.png',
      buffer: await sharp({
        create: { width: 160, height: 160, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer(),
    });
    const result = await e.attachments.read(e.conversation.id, input.id);
    assert.deepEqual(result.urls, []);
    assert.ok(result.decodeError);
    const stored = e.store.get('inputs', input.id);
    assert.equal(stored.decodeEvidence.valid, false);
    assert.equal(stored.decodeEvidence.error, 'OpenCV could not locate the QR code');
    assert.equal(e.attachments.needsDecode(stored), false);
    e.config.python = 'nonexistent-qr-test-python';
    assert.deepEqual(await e.attachments.read(e.conversation.id, input.id), result);
  } finally {
    e.store.close();
  }
});
