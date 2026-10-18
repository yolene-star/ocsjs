const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LocalQuestionBank, HybridAnswerer, matchChoiceAnswer, readPublishedAnswer } = require('../packages/scripts/src/utils/hybrid-answerer.ts');
const { pickOnlineAnswer } = require('../packages/scripts/src/utils/hybrid-answerer.ts');
const q = { title: '1.[单选题]生命在于什么？', options: ['A 安全', 'B 运动', 'C 休息'], multiple: false };
function storage() {
  let data = { version: 1, entries: [] };
  return { read: () => JSON.parse(JSON.stringify(data)), write: (value) => { data = JSON.parse(JSON.stringify(value)); } };
}

test('local answers persist across instances and remap reordered option labels', () => {
  const store = storage();
  new LocalQuestionBank(store).put(q, [1], 'DeepSeek', false);
  const saved = new LocalQuestionBank(store).find({ ...q, title: '2. [单选题]生命在于什么？', options: ['A 运动', 'B 休息', 'C 安全'] });
  assert.deepEqual(saved.indices, [0]);
  assert.equal(saved.verified, false);
});

test('never reuses a same-title answer with changed options, type or negation', () => {
  const bank = new LocalQuestionBank(storage());
  bank.put(q, [1], 'DeepSeek', false);
  assert.equal(bank.find({ ...q, options: ['安全', '休养', '休息'] }), undefined);
  assert.equal(bank.find({ ...q, multiple: true }), undefined);
  assert.equal(bank.find({ ...q, title: '生命不在于什么？' }), undefined);
});

test('local hit skips every remote and AI request', async () => {
  const bank = new LocalQuestionBank(storage());
  bank.put(q, [1], '题库', false);
  const answerer = new HybridAnswerer(bank);
  const forbidden = async () => { throw new Error('must not request'); };
  assert.equal((await answerer.answer(q, forbidden, forbidden)).source, '本地题库（题库）');
});

test('online hit saves locally and skips DeepSeek; miss calls DeepSeek then saves', async () => {
  const bank = new LocalQuestionBank(storage());
  const answerer = new HybridAnswerer(bank);
  const first = await answerer.answer(q, async () => ({ indices: [1], source: '在线题库', verified: false }), async () => { throw new Error('must not use AI'); });
  assert.deepEqual(first.indices, [1]);
  assert.equal(bank.find(q).source, '在线题库');
  const next = { ...q, title: '第二个问题' };
  const events = [];
  const second = await answerer.answer(next, async () => { events.push('online'); return undefined; }, async () => { events.push('ai'); return [2]; });
  assert.deepEqual(events, ['online', 'ai']);
  assert.equal(second.source, 'DeepSeek（未验证）');
  assert.deepEqual(bank.find(next).indices, [2]);
});

test('failures and invalid answers never pollute the bank; overlapping identical requests deduplicate', async () => {
  const bank = new LocalQuestionBank(storage());
  const answerer = new HybridAnswerer(bank);
  await assert.rejects(answerer.answer(q, async () => undefined, async () => [12]));
  assert.equal(bank.find(q), undefined);
  await assert.rejects(answerer.answer(q, async () => undefined, async () => { throw new Error('network'); }));
  assert.equal(bank.find(q), undefined);
  let calls = 0, release;
  const ai = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
  const a = answerer.answer(q, async () => undefined, ai);
  const b = answerer.answer(q, async () => undefined, ai);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release([1]);
  await Promise.all([a, b]);
});

test('platform-confirmed answers replace AI guesses and survive lower quality updates', () => {
  const bank = new LocalQuestionBank(storage());
  bank.put(q, [2], 'DeepSeek', false);
  bank.put(q, [1], '平台公布', true);
  bank.put(q, [0], 'DeepSeek', false);
  assert.deepEqual(bank.find(q).indices, [1]);
  assert.equal(bank.find(q).verified, true);
});

test('matches literal answer text before letters, supports multi-select and rejects ambiguity', () => {
  assert.deepEqual(matchChoiceAnswer('运动', q), [1]);
  assert.deepEqual(matchChoiceAnswer('B', q), [1]);
  assert.deepEqual(matchChoiceAnswer('A#C', { ...q, multiple: true }), [0, 2]);
  assert.equal(matchChoiceAnswer('选B可能吧', q), undefined);
  assert.equal(matchChoiceAnswer('D', q), undefined);
  assert.equal(matchChoiceAnswer('运动', { ...q, options: ['运动', '运动'] }), undefined);
});

test('imports valid bank entries atomically, exports no API configuration, and rejects corrupted files', () => {
  const original = new LocalQuestionBank(storage());
  original.put(q, [1], 'DeepSeek', false);
  const exported = original.export();
  assert.doesNotMatch(exported, /apiKey|Authorization/);
  const bank = new LocalQuestionBank(storage());
  bank.import(exported);
  assert.deepEqual(bank.find(q).indices, [1]);
  const bad = JSON.parse(exported);
  bad.entries.push({ title: 'broken' });
  assert.throws(() => bank.import(JSON.stringify(bad)));
  assert.equal(bank.entries().length, 1);
});

test('records a published answer only with an explicit correct-answer label', () => {
  assert.deepEqual(readPublishedAnswer('你选择了E 正确答案：B', q), [1]);
  assert.equal(readPublishedAnswer('你选择了 B 已提交', q), undefined);
});

test('overlapping reordered questions receive their own option indices', async () => {
  const answerer = new HybridAnswerer(new LocalQuestionBank(storage()));
  let release;
  const ai = () => new Promise((resolve) => { release = resolve; });
  const a = answerer.answer(q, async () => undefined, ai);
  const b = answerer.answer({ ...q, options: ['A 运动', 'B 休息', 'C 安全'] }, async () => undefined, ai);
  await new Promise((resolve) => setImmediate(resolve));
  release([1]);
  assert.deepEqual((await a).indices, [1]);
  assert.deepEqual((await b).indices, [0]);
});

test('does not mistake English answer text starting with A for an option label', () => {
  const bank = new LocalQuestionBank(storage());
  const english = { title: 'Which phrase?', multiple: false, options: ['A little', 'Not much', 'little'] };
  bank.put(english, [0], 'DeepSeek', false);
  assert.deepEqual(bank.find(english).indices, [0]);
  assert.deepEqual(matchChoiceAnswer('A little', english), [0]);
});

test('online search candidates must match the requested question, not just an option', () => {
  assert.equal(pickOnlineAnswer([{ name: '题库', results: [{ question: '另一道题', answer: 'B' }] }], q), undefined);
  assert.deepEqual(pickOnlineAnswer([{ name: '题库', results: [
    { question: '另一道题', answer: 'A' },
    { question: '生命在于什么？', answer: '运动' }
  ] }], q), { indices: [1], source: '题库', verified: false });
});
