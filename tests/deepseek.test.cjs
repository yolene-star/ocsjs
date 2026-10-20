const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDeepSeekAnswer, requestDeepSeek, DeepSeekQuizController } = require('../packages/scripts/src/utils/deepseek-quiz.ts');
const { readDeepSeekQuestion, handleDeepSeekDialog } = require('../packages/scripts/src/utils/deepseek-quiz.ts');
const { hideWisdomNotifications } = require('../packages/scripts/src/utils/deepseek-quiz.ts');
const { parseDeepSeekConfigFile } = require('../packages/scripts/src/utils/deepseek-quiz.ts');
const { JSDOM } = require('jsdom');

const question = { title: '生命在于什么？', options: ['安全', '运动', '休息'], multiple: false };
const config = { enabled: true, apiKey: 'test-key-never-log', model: 'deepseek-flash' };
const result = (content, finish_reason = 'stop') => ({ choices: [{ finish_reason, message: { content } }] });

test('imports a local configuration without enabling submissions or accepting another API endpoint', () => {
  assert.deepEqual(parseDeepSeekConfigFile('\uFEFF{"apiKey":" test-key ","model":" deepseek-flash ","enabled":true}'), {
    apiKey: 'test-key', model: 'deepseek-flash'
  });
  for (const raw of ['{"apiKey":""}', '{"apiKey":"key with spaces","model":"m"}', '{"apiKey":"secret","model":"m","baseURL":"https://example.com"}', 'secret', '{"apiKey":123,"model":"m"}']) {
    assert.throws(() => parseDeepSeekConfigFile(raw), (error) => !error.message.includes('secret'));
  }
});

test('validates answers against the actual options and question type', () => {
  assert.deepEqual(parseDeepSeekAnswer(result('{"answers":["B"]}'), question), [1]);
  assert.deepEqual(parseDeepSeekAnswer(result('{"answers":["A","C"]}'), { ...question, multiple: true }), [0, 2]);
  for (const content of ['{"answers":["D"]}', '{"answers":["A","B"]}', '{"answers":[]}', '{"answers":["B","B"]}', 'B', '{"answers":[1]}']) {
    assert.throws(() => parseDeepSeekAnswer(result(content), question));
  }
  assert.throws(() => parseDeepSeekAnswer(result('{"answers":["B"]}', 'length'), question));
});

test('sends only the question and choices to the official authenticated JSON endpoint', async () => {
  let outgoing;
  const answers = await requestDeepSeek(question, config, (details) => {
    outgoing = details;
    details.onload({ status: 200, responseText: JSON.stringify(result('{"answers":["B"]}')) });
  });
  assert.deepEqual(answers, [1]);
  assert.equal(outgoing.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(outgoing.headers.Authorization, 'Bearer test-key-never-log');
  const data = JSON.parse(outgoing.data);
  assert.equal(data.response_format.type, 'json_object');
  assert.equal(data.model, 'deepseek-flash');
  assert.match(data.messages[1].content, /生命在于什么/);
  assert.match(data.messages[1].content, /B/);
  assert.doesNotMatch(outgoing.data, /test-key-never-log/);
});

test('never exposes credentials or raw server errors in failure messages', async () => {
  for (const fail of [
    (d) => d.onload({ status: 401, responseText: 'test-key-never-log' }),
    (d) => d.onerror({ message: 'test-key-never-log' }),
    (d) => d.ontimeout(),
    (d) => d.onload({ status: 200, responseText: 'not json' })
  ]) {
    await assert.rejects(requestDeepSeek(question, config, fail), (error) => !error.message.includes(config.apiKey));
  }
});

function effects(events, current = () => true) {
  return { stillCurrent: current, select: async (i) => events.push('select:' + i), submit: async () => events.push('submit'), close: async () => events.push('close'), notify: (s) => events.push(s) };
}

test('selects the returned answer before submitting and closes only after confirmed submission', async () => {
  const events = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  const fx = effects(events);
  fx.submit = async () => { events.push('submit'); return false; };
  await controller.run(question, config, fx);
  assert.ok(events.indexOf('select:1') < events.indexOf('submit'));
  assert.ok(!events.includes('close'));
});

test('does not submit when disabled, unconfigured, failed, or changed during the request', async () => {
  for (const setting of [{ ...config, enabled: false }, { ...config, apiKey: '' }, config]) {
    const events = [];
    const controller = new DeepSeekQuizController(async () => { throw new Error('failed'); });
    await controller.run(question, setting, effects(events));
    assert.ok(!events.includes('submit'));
    assert.ok(!events.some((s) => s.startsWith('select:')));
    assert.ok(!events.includes('close'));
  }
  const events = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  await controller.run(question, config, effects(events, () => false));
  assert.ok(!events.includes('submit'));
  assert.ok(!events.some((s) => s.startsWith('select:')));
});

test('an enabled bank pipeline can answer without an API key when the bank has the answer', async () => {
  const events = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  const fx = effects(events);
  fx.submit = async () => { events.push('submit'); return true; };
  await controller.run(question, { ...config, apiKey: '', allowBankLookup: true }, fx);
  assert.ok(events.includes('select:1'));
  assert.ok(events.includes('submit'));
});

test('deduplicates polls and overlapping requests; allows retry after configuration changes', async () => {
  let calls = 0;
  let release;
  const controller = new DeepSeekQuizController(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
  const events = [];
  const first = controller.run(question, config, effects(events));
  await controller.run(question, config, effects(events));
  assert.equal(calls, 1);
  release([1]);
  await first;
  await controller.run(question, config, effects(events));
  assert.equal(calls, 1);
  const retry = controller.run(question, { ...config, model: 'other-model' }, effects(events));
  assert.equal(calls, 2);
  release([1]);
  await retry;
});

function dialog() {
  const dom = new JSDOM('<div class="ai-class-exercise-dialog"><div class="ques-list"><div class="item"><h3>1.[单选题]</h3><p>生命在于什么？</p><div class="option">A 安全</div><div class="option">B 运动</div><div class="option">C 休息</div></div></div><div class="el-dialog__footer"><button class="el-button btn">提交作答</button></div><button class="header-icon">关闭</button></div>');
  const root = dom.window.document.querySelector('.ai-class-exercise-dialog');
  return { dom, root };
}

test('reads actual dialog text without mixing options into the question; refuses image or unsupported exercises', () => {
  const { root } = dialog();
  const q = readDeepSeekQuestion(root);
  assert.equal(q.title, '1.[单选题]生命在于什么？');
  assert.deepEqual(q.options, ['A 安全', 'B 运动', 'C 休息']);
  root.querySelector('p').innerHTML = '<img src="question.png">';
  assert.throws(() => readDeepSeekQuestion(root));
});

test('DOM adapter selects B, submits once, and closes only on platform feedback', async () => {
  const { root } = dialog();
  const actions = [];
  const click = async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') { el.textContent = '已提交'; el.disabled = true; }
    if (el.classList.contains('header-icon')) root.hidden = true;
  };
  const controller = new DeepSeekQuizController(async () => [1]);
  await handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动', '提交作答', '关闭']);
  await handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {});
  assert.equal(actions.length, 3);
});

test('already submitted exercise closes and resumes only after the dialog disappears', async () => {
  const { root } = dialog();
  root.querySelector('.btn').textContent = '已提交';
  root.querySelector('.btn').disabled = true;
  const actions = [];
  const controller = new DeepSeekQuizController(async () => { throw Error('must not query'); });
  await handleDeepSeekDialog(root, controller, () => config, async el => {
    actions.push(el.textContent);
    if (el.classList.contains('header-icon')) root.hidden = true;
  }, () => {}, async () => {}, undefined, async () => {
    assert.equal(root.hidden, true);
    actions.push('resume');
  });
  assert.deepEqual(actions, ['关闭', 'resume']);
});

test('late submission feedback is recovered on the next poll without resubmitting', async () => {
  const { root } = dialog();
  const actions = [];
  const feedback = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  const click = async el => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.classList.contains('header-icon')) root.remove();
  };
  const poll = () => handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {}, () => feedback.push('saved'), async () => actions.push('resume'));
  await poll();
  assert.deepEqual(actions, ['B 运动', '提交作答']);
  root.querySelector('.btn').textContent = '已提交';
  root.querySelector('.btn').disabled = true;
  await poll();
  await poll();
  assert.deepEqual(actions, ['B 运动', '提交作答', '关闭', 'resume']);
  assert.deepEqual(feedback, ['saved']);
});

test('submission exceptions and failed closing preserve the dialog and never resume', async () => {
  for (const failure of ['server-error', 'missing-close', 'close-no-effect']) {
    const { root, dom } = dialog();
    root.querySelector('.btn').textContent = '已提交';
    if (failure === 'server-error') {
      const alert = dom.window.document.createElement('div');
      alert.className = 'el-alert--error';
      alert.textContent = '提交异常';
      root.append(alert);
    }
    if (failure === 'missing-close') root.querySelector('.header-icon').remove();
    const messages = [];
    let resumed = 0;
    await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config,
      async () => {}, text => messages.push(text), async () => {}, undefined, async () => resumed++);
    assert.equal(root.isConnected, true);
    assert.equal(root.hidden, false);
    assert.equal(resumed, 0);
    assert.ok(messages.length > 0, failure);
  }
});

test('a manually interrupted submission stays open even when feedback arrives later', async () => {
  const { root, dom } = dialog();
  const actions = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  const click = async el => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') root.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  await handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {});
  root.querySelector('.btn').textContent = '已提交';
  await handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动', '提交作答']);
});

test('normal submission closes before resuming, including when the answer was wrong', async () => {
  const { root, dom } = dialog();
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async el => {
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') {
      el.textContent = '已提交';
      const correct = dom.window.document.createElement('p');
      correct.textContent = '正确答案：C';
      root.querySelector('.item').append(correct);
    }
    if (el.classList.contains('header-icon')) { actions.push('close'); root.hidden = true; }
  }, () => {}, async () => {}, () => actions.push('feedback'), async () => actions.push('play'));
  assert.deepEqual(actions, ['feedback', 'close', 'play']);
});

test('closing retries are bounded and never query or submit again', async () => {
  const { root } = dialog();
  root.querySelector('.btn').textContent = '已提交';
  let clicks = 0;
  let resumed = 0;
  const controller = new DeepSeekQuizController(async () => { throw Error('unexpected query'); });
  for (let i = 0; i < 6; i++) {
    await handleDeepSeekDialog(root, controller, () => config, async () => clicks++, () => {}, async () => {}, undefined, async () => resumed++);
  }
  assert.equal(clicks, 3);
  assert.equal(resumed, 0);
});

test('manual interaction during recovery prevents playback and later automatic closing', async () => {
  const { root, dom } = dialog();
  root.querySelector('.btn').textContent = '已提交';
  let clicks = 0;
  let resumed = 0;
  const controller = new DeepSeekQuizController(async () => [1]);
  const poll = () => handleDeepSeekDialog(root, controller, () => config, async () => {
    clicks++;
    root.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  }, () => {}, async () => {}, undefined, async () => resumed++);
  await poll();
  await poll();
  assert.equal(clicks, 1);
  assert.equal(resumed, 0);
});

test('closing may destroy the dialog contents before resuming the lesson', async () => {
  const { root } = dialog();
  root.querySelector('.btn').textContent = '已提交';
  let resumed = 0;
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async () => {
    root.hidden = true;
    root.innerHTML = '';
  }, () => {}, async () => {}, undefined, async () => resumed++);
  assert.equal(resumed, 1);
});

test('manual input between polls prevents late feedback from closing the exercise', async () => {
  const { root, dom } = dialog();
  const actions = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  const click = async el => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
  };
  const poll = () => handleDeepSeekDialog(root, controller, () => config, click, () => {}, async () => {}, undefined, async () => actions.push('play'));
  await poll();
  await poll();
  root.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  root.querySelector('.btn').textContent = '已提交';
  await poll();
  assert.deepEqual(actions, ['B 运动', '提交作答']);
});

test('manual input or question replacement during the request cancels every automated click', async () => {
  for (const mutate of [
    ({ root, dom }) => root.dispatchEvent(new dom.window.Event('input', { bubbles: true })),
    ({ root }) => { root.querySelector('p').textContent = '新的题目'; }
  ]) {
    const fixture = dialog();
    const actions = [];
    let release;
    const controller = new DeepSeekQuizController(() => new Promise((resolve) => { release = resolve; }));
    const work = handleDeepSeekDialog(fixture.root, controller, () => config, async () => actions.push('click'), () => {}, async () => {});
    mutate(fixture);
    release([1]);
    await work;
    assert.deepEqual(actions, []);
  }
});

test('user selecting another answer during a remote option click cancels submission', async () => {
  const { root, dom } = dialog();
  const actions = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  await handleDeepSeekDialog(root, controller, () => config, async (el) => {
    actions.push(el.textContent);
    if (el.textContent === 'B 运动') {
      root.querySelectorAll('.option')[2].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    }
  }, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动']);
});

test('manual action while waiting for submission feedback prevents closing the dialog', async () => {
  const { root, dom } = dialog();
  const actions = [];
  const controller = new DeepSeekQuizController(async () => [1]);
  await handleDeepSeekDialog(root, controller, () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') el.textContent = '已提交';
  }, () => {}, async (ms) => {
    if (ms === 250) root.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  assert.deepEqual(actions, ['B 运动', '提交作答']);
});

test('keyboard input on the option currently being clicked still cancels submission', async () => {
  const { root, dom } = dialog();
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) {
      el.classList.add('selected');
      el.dispatchEvent(new dom.window.Event('keydown', { bubbles: true }));
    }
  }, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动']);
});

test('extra clicks on the automated target cancel submission', async () => {
  const { root, dom } = dialog();
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) {
      el.classList.add('selected');
      for (let i = 0; i < 2; i++) el.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
    }
  }, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动']);
});

test('does not submit when a click failed to change the actual selection', async () => {
  const { root } = dialog();
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
  }, () => {}, async () => {});
  assert.deepEqual(actions, ['B 运动']);
});

test('rechecks the question after the selection render delay before submitting', async () => {
  const { root } = dialog();
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
  }, () => {}, async (ms) => {
    if (ms === 150) root.querySelector('p').textContent = '换成另一道题';
  });
  assert.deepEqual(actions, ['B 运动']);
});

test('startup notification cleanup preserves exercise dialogs for manual fallback', () => {
  const { root, dom } = dialog();
  root.classList.add('el-dialog');
  const overlay = dom.window.document.createElement('div');
  overlay.className = 'el-overlay';
  root.parentNode.insertBefore(overlay, root);
  overlay.append(root);
  const notice = dom.window.document.createElement('div');
  notice.className = 'el-dialog';
  dom.window.document.body.append(notice);
  hideWisdomNotifications(dom.window.document);
  assert.notEqual(root.style.display, 'none');
  assert.notEqual(overlay.style.display, 'none');
  assert.equal(notice.style.display, 'none');
});

test('published feedback is associated only with the captured question, not a reused dialog', async () => {
  const { root, dom } = dialog();
  const feedback = [];
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') el.textContent = '已提交';
  }, () => {}, async (ms) => {
    if (ms === 250) {
      root.querySelector('p').textContent = '另一个问题';
      const correct = dom.window.document.createElement('p');
      correct.textContent = '正确答案：C';
      root.querySelector('.item').append(correct);
    }
  }, () => feedback.push('verified'));
  assert.deepEqual(feedback, []);
  assert.deepEqual(actions, ['B 运动', '提交作答']);
});

test('can confirm feedback appended to the same question without changing question identity', async () => {
  const { root, dom } = dialog();
  const feedback = [];
  const actions = [];
  await handleDeepSeekDialog(root, new DeepSeekQuizController(async () => [1]), () => config, async (el) => {
    actions.push(el.textContent);
    if (el.classList.contains('option')) el.classList.add('selected');
    if (el.textContent === '提交作答') {
      el.textContent = '已提交';
      const correct = dom.window.document.createElement('p');
      correct.textContent = '正确答案：B';
      root.querySelector('.item').append(correct);
    }
  }, () => {}, async () => {}, () => feedback.push('verified'));
  assert.deepEqual(feedback, ['verified']);
  assert.equal(actions[actions.length - 1], '关闭');
});
