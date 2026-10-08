// 세 앱(카드뉴스·릴스·파이프라인)이 함께 쓰는 AI 호출 계층.
// API 키 앞글자로 제공사를 판별한다. 키가 없으면 Pollinations 로 떨어진다.

const Anthropic = require('@anthropic-ai/sdk');

const GEMINI_MODEL = 'gemini-2.5-flash';

// Groq 는 모델을 수시로 내린다. 폐기된 모델이면 조용히 다음 걸로 넘어간다.
const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'qwen/qwen3.6-27b'
];

// Pollinations 무료 티어 메모 (2026-10 확인):
//   · 분당 호출 제한이 있고 넘기면 402 를 준다. 쉬면 저절로 풀린다.
//   · GET 방식뿐이라 프롬프트가 URL 에 들어간다. 한글은 인코딩에서 약 9배로
//     불어나므로 긴 프롬프트는 아예 통과하지 못한다.
//   · openai 외 모델(openai-large·mistral)은 404/402.
const POLLINATIONS_MAX_ENCODED = 4000;

const NEED_KEY_MSG =
  '키 없이 쓰는 무료 API 로는 이 요청이 너무 깁니다.\n' +
  '⚙️ 설정에 Groq 키(gsk_…)를 넣어주세요 — console.groq.com 에서 무료로 발급됩니다.\n' +
  '(Gemini 키 AIza… 도 됩니다)';

const RATE_LIMIT_MSG =
  '무료 Pollinations 사용량을 잠시 초과했습니다. 1~2분 뒤에 다시 시도해주세요.\n' +
  '기다리기 싫으면 ⚙️ 설정에 무료 Groq 키(gsk_…)를 넣으면 바로 됩니다 — console.groq.com';

function detectProvider(apiKey) {
  if (!apiKey) return 'free';
  if (apiKey.startsWith('sk-ant-')) return 'anthropic';
  if (apiKey.startsWith('AIza'))    return 'gemini';
  if (apiKey.startsWith('gsk_'))    return 'groq';
  if (apiKey === 'free' || apiKey === 'FREE') return 'free';
  return 'anthropic';
}

const PROVIDER_NAME = {
  anthropic: 'Claude', gemini: 'Gemini', groq: 'Groq', free: 'Pollinations'
};

// 이미지를 볼 수 있는 제공사. Groq 의 gpt-oss 와 Pollinations 는 못 받는다.
const VISION_PROVIDERS = new Set(['gemini', 'anthropic']);

/**
 * 키 목록을 받아 순서대로 쓸 수 있게 다듬는다.
 * 설정창에서 줄바꿈으로 여러 개를 받으므로 공백·쉼표 모두 구분자로 본다.
 * 키 자체에는 공백이나 쉼표가 들어가지 않는다.
 */
function parseKeys(input) {
  if (Array.isArray(input)) input = input.join('\n');
  const seen = new Set();
  return String(input || '')
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(k => k && k !== 'free' && k !== 'FREE')
    .filter(k => (seen.has(k) ? false : (seen.add(k), true)));
}

/** 이 오류면 이 키는 포기하고 다음 키로 넘어간다. */
function shouldTryNextKey(err) {
  const s = err?.status || 0;
  if ([401, 403, 402, 429, 404, 529].includes(s)) return true;
  return /credit balance|insufficient|quota|depleted|RESOURCE_EXHAUSTED|invalid.*key|api.?key|billing|rate.?limit|overloaded|decommission/i
    .test(err?.message || '');
}

/** 키를 전부 써버렸을 때, 어느 키가 왜 안 됐는지 한눈에 알려준다. */
function allKeysFailedError(failures) {
  const lines = failures.map(f => {
    const name = PROVIDER_NAME[f.provider] || f.provider;
    const why = /credit balance|insufficient|billing/i.test(f.err.message) ? '크레딧 소진'
      : /quota|depleted|RESOURCE_EXHAUSTED/i.test(f.err.message)           ? '사용 한도 초과'
      : /invalid|api.?key|authentication/i.test(f.err.message) || f.err.status === 401 ? '키가 올바르지 않음'
      : /rate.?limit/i.test(f.err.message) || f.err.status === 429         ? '요청 한도 초과'
      : (f.err.message || '오류').split('\n')[0].slice(0, 60);
    return `  · ${name} (${f.hint}) — ${why}`;
  });
  const err = new Error(
    `등록한 키 ${failures.length}개가 모두 실패했습니다.\n` + lines.join('\n') +
    '\n⚙️ 설정에서 키를 확인하거나, 무료 Groq 키를 추가해주세요 — console.groq.com'
  );
  err.status = failures[failures.length - 1]?.err?.status || 502;
  return err;
}

/** 로그와 안내에 쓸 키 식별자. 키 전체를 남기지 않는다. */
function keyHint(k) {
  return k.length <= 10 ? k.slice(0, 4) + '…' : k.slice(0, 7) + '…' + k.slice(-3);
}

async function callGeminiText(apiKey, prompt, maxTokens) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.9 }
    })
  });
  if (!r.ok) {
    const t = await r.text();
    let msg = t;
    try { msg = JSON.parse(t)?.error?.message || t } catch {}
    const err = new Error(msg || `Gemini ${r.status}`); err.status = r.status; throw err;
  }
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callGroqText(apiKey, prompt, maxTokens) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  for (const model of GROQ_MODELS) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({})))?.error?.message || '';
      if (/does not exist|not found|access|decommission|deprecat|no longer supported/i.test(msg)) {
        console.log(`[Groq] 모델 ${model} 미사용, 다음 시도...`);
        continue;
      }
      const err = new Error(msg || `Groq ${r.status}`); err.status = r.status; throw err;
    }
    const d = await r.json();
    console.log(`[Groq] 모델 사용: ${model}`);
    return d.choices?.[0]?.message?.content || '';
  }
  throw new Error('쓸 수 있는 Groq 모델이 없습니다. Gemini 키(AIza…)를 넣거나 키를 비워두세요.');
}

async function callPollinationsText(prompt) {
  const encoded = encodeURIComponent(prompt);
  if (encoded.length > POLLINATIONS_MAX_ENCODED) {
    const err = new Error(NEED_KEY_MSG); err.status = 413; throw err;
  }

  let rateLimited = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = `https://text.pollinations.ai/${encoded}?model=openai&seed=${Math.floor(Math.random() * 9999)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.ok) {
        const text = await r.text();
        if (text?.trim()) return text;
      }
      if (r.status === 402 || r.status === 429) {
        rateLimited = true;
        if (attempt < 2) { await new Promise(s => setTimeout(s, 3000 * (attempt + 1))); continue; }
      }
    } catch { /* 네트워크 오류 — 재시도 */ }
  }

  const err = new Error(rateLimited ? RATE_LIMIT_MSG : NEED_KEY_MSG);
  err.status = rateLimited ? 429 : 503;
  throw err;
}

/**
 * 텍스트 생성. 키를 여러 개 받아 앞에서부터 쓰고, 막히면 다음 키로 넘어간다.
 * 크레딧 소진·한도 초과·잘못된 키는 넘어가고, 그 밖의 오류는 바로 올린다.
 * 키가 전부 떨어지면 마지막으로 Pollinations 를 시도한다.
 */
async function callAI(apiKeys, prompt, maxTokens = 8192) {
  const keys = parseKeys(apiKeys);
  const failures = [];

  for (const key of keys) {
    const provider = detectProvider(key);
    try {
      if (provider === 'gemini') return await callGeminiText(key, prompt, maxTokens);
      if (provider === 'groq')   return await callGroqText(key, prompt, maxTokens);
      const client = new Anthropic({ apiKey: key });
      const r = await client.messages.create({
        model: 'claude-sonnet-4-5', max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return r.content[0]?.text || '';
    } catch (err) {
      if (!shouldTryNextKey(err)) throw err;
      failures.push({ provider, hint: keyHint(key), err });
      console.warn(`[AI] ${PROVIDER_NAME[provider]} ${keyHint(key)} 실패 → 다음 키 시도: ${(err.message || '').slice(0, 120)}`);
    }
  }

  // 키가 없거나 전부 막혔다 → 무료 Pollinations 로 한 번 더
  try {
    return await callPollinationsText(prompt);
  } catch (pollErr) {
    // 키를 넣었는데 다 실패한 거라면, 그쪽 사정을 알려주는 편이 쓸모 있다.
    if (failures.length) throw allKeysFailedError(failures);
    throw pollErr;
  }
}

// ─── 스트리밍 ───────────────────────────────────────────────────────────────
// 파이프라인은 생성 중인 글을 실시간으로 흘려보내므로 스트리밍이 필요하다.

async function* streamGemini(apiKey, systemPrompt, userPrompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.9 }
    })
  });
  if (!r.ok) {
    const t = await r.text();
    let msg = t;
    try { msg = JSON.parse(t)?.error?.message || t } catch {}
    const err = new Error(msg || `Gemini ${r.status}`); err.status = r.status; throw err;
  }
  yield* readSSE(r, json => JSON.parse(json).candidates?.[0]?.content?.parts?.[0]?.text || '');
}

async function* streamGroq(apiKey, systemPrompt, userPrompt) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  for (const model of GROQ_MODELS) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, max_tokens: 8192, stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });
    if (!r.ok) {
      const msg = (await r.json().catch(() => ({})))?.error?.message || '';
      if (/does not exist|not found|access|decommission|deprecat|no longer supported/i.test(msg)) {
        console.log(`[Groq] 모델 ${model} 미사용, 다음 시도...`);
        continue;
      }
      const err = new Error(msg || `Groq ${r.status}`); err.status = r.status; throw err;
    }
    console.log(`[Groq] 모델 사용: ${model}`);
    yield* readSSE(r, json => JSON.parse(json).choices?.[0]?.delta?.content || '');
    return;
  }
  throw new Error('쓸 수 있는 Groq 모델이 없습니다. Gemini 키(AIza…)를 넣거나 키를 비워두세요.');
}

/** SSE 응답에서 data: 줄만 뽑아 텍스트 조각으로 흘려보낸다. */
async function* readSSE(response, extract) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (json === '[DONE]') return;
      try {
        const text = extract(json);
        if (text) yield text;
      } catch {}
    }
  }
}

/**
 * 텍스트를 조각 단위로 흘려보낸다. 키를 여러 개 받아 막히면 다음 키로 넘어간다.
 * 키 문제는 첫 요청에서 드러나므로, 글자가 하나라도 나간 뒤에는 키를 바꾸지 않는다.
 * (이미 화면에 찍힌 글 뒤에 다른 키의 결과를 이어 붙이면 내용이 뒤섞인다)
 */
async function* callAIStream(apiKeys, systemPrompt, userPrompt) {
  const keys = parseKeys(apiKeys);
  const failures = [];

  for (const key of keys) {
    const provider = detectProvider(key);
    let started = false;
    try {
      let inner;
      if (provider === 'gemini')      inner = streamGemini(key, systemPrompt, userPrompt);
      else if (provider === 'groq')   inner = streamGroq(key, systemPrompt, userPrompt);
      else {
        const client = new Anthropic({ apiKey: key });
        const stream = await client.messages.create({
          model: 'claude-sonnet-4-5', max_tokens: 8192, system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }], stream: true
        });
        inner = (async function* () {
          for await (const ev of stream) {
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              yield ev.delta.text;
            }
          }
        })();
      }

      for await (const chunk of inner) { started = true; yield chunk; }
      return;

    } catch (err) {
      if (started || !shouldTryNextKey(err)) throw err;
      failures.push({ provider, hint: keyHint(key), err });
      console.warn(`[AI] ${PROVIDER_NAME[provider]} ${keyHint(key)} 실패 → 다음 키 시도: ${(err.message || '').slice(0, 120)}`);
    }
  }

  try {
    // Pollinations 는 스트리밍이 없다. 한 번에 받아서 통째로 넘긴다.
    yield await callPollinationsText(`${systemPrompt}\n\n${userPrompt}`);
  } catch (pollErr) {
    if (failures.length) throw allKeysFailedError(failures);
    throw pollErr;
  }
}

/**
 * 이미지 분석. Gemini 와 Anthropic 만 지원한다.
 * Groq 의 gpt-oss 와 Pollinations 는 이미지 입력을 못 받으므로 null 을 돌려주고,
 * 호출한 쪽이 분석 없이 넘어가게 한다.
 */
async function callVision(apiKeys, imageB64, mediaType, prompt, maxTokens = 1000) {
  // 이미지를 볼 수 있는 키만 추린다. 하나도 없으면 호출한 쪽이 건너뛰도록 null.
  const keys = parseKeys(apiKeys).filter(k => VISION_PROVIDERS.has(detectProvider(k)));
  if (!keys.length) return null;

  const failures = [];
  for (const key of keys) {
    const provider = detectProvider(key);
    try {
      return await callVisionOnce(key, provider, imageB64, mediaType, prompt, maxTokens);
    } catch (err) {
      if (!shouldTryNextKey(err)) throw err;
      failures.push({ provider, hint: keyHint(key), err });
      console.warn(`[Vision] ${PROVIDER_NAME[provider]} ${keyHint(key)} 실패 → 다음 키 시도: ${(err.message || '').slice(0, 120)}`);
    }
  }
  throw allKeysFailedError(failures);
}

async function callVisionOnce(key, provider, imageB64, mediaType, prompt, maxTokens) {
  if (provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { inline_data: { mime_type: mediaType, data: imageB64 } },
          { text: prompt }
        ]}],
        generationConfig: { maxOutputTokens: maxTokens * 2 }
      })
    });
    if (!r.ok) {
      const t = await r.text();
      let msg = t;
      try { msg = JSON.parse(t)?.error?.message || t } catch {}
      const err = new Error(msg || `Gemini ${r.status}`); err.status = r.status; throw err;
    }
    const d = await r.json();
    return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: key });
    const r = await client.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: maxTokens,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageB64 } },
        { type: 'text', text: prompt }
      ]}]
    });
    return r.content[0]?.text || '';
  }

  return null;
}

/**
 * 토큰 한도에 걸려 중간에 끊긴 JSON 을 살려낸다.
 * 마지막으로 온전하게 닫힌 요소까지만 남기고 열린 괄호를 닫아준다.
 * 슬라이드 8~10장처럼 응답이 길어지면 뒤가 잘려 통째로 버려지던 걸 막는다.
 */
function repairTruncatedJson(text) {
  let inStr = false, esc = false;
  const stack = [];
  let cutAt = -1, stackAtCut = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;

    if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']');
    } else if (c === '}' || c === ']') {
      stack.pop();
      // 바깥 괄호가 아직 남아 있다 = 배열/객체 안의 요소 하나가 온전히 끝났다.
      // 여기서 자르면 유효한 JSON 을 만들 수 있다.
      if (stack.length >= 1) { cutAt = i + 1; stackAtCut = stack.slice(); }
    }
  }

  if (cutAt < 0 || !stackAtCut) return null;
  return text.slice(0, cutAt) + stackAtCut.reverse().join('');
}

/** 무료 모델이 붙이는 ```json 펜스와 앞뒤 설명을 걷어내고 JSON 만 뽑는다. */
function parseJson(raw, label = 'JSON') {
  const text = (raw || '').trim().replace(/```json/gi, '').replace(/```/g, '');
  const start = text.search(/[{[]/);
  if (start < 0) throw new Error(`${label} 응답에 JSON 이 없습니다.`);

  const body = text.slice(start);
  try {
    return JSON.parse(body);
  } catch (firstErr) {
    // 끝에 설명이 붙은 경우: 마지막 닫는 괄호까지만 떼어 다시 시도
    const lastClose = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
    if (lastClose > 0) {
      try { return JSON.parse(body.slice(0, lastClose + 1)); } catch {}
    }
    // 잘린 응답 복구
    const repaired = repairTruncatedJson(body);
    if (repaired) {
      try {
        const data = JSON.parse(repaired);
        console.warn(`[${label}] 응답이 중간에 잘려 복구했습니다. 일부 항목이 빠질 수 있습니다.`);
        return data;
      } catch {}
    }
    const err = new Error(
      `${label} 응답을 읽지 못했습니다. 다시 시도하거나, 슬라이드 수를 줄여보세요.`
    );
    err.status = 502;
    throw err;
  }
}

/**
 * Pollinations 이미지 생성 프록시.
 * 무료 티어가 몰아치는 호출에 402 를 주므로 재시도를 넣는다.
 * 카드뉴스는 한 번에 6~10장, 릴스는 4~6장을 연달아 뽑기 때문에 재시도가 없으면
 * 뒤쪽 이미지가 통째로 깨진다.
 */
async function proxyPollinationsImage(res, url, label = '이미지') {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (r.ok) {
        res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(Buffer.from(await r.arrayBuffer()));
      }
      lastStatus = r.status;
      if (r.status === 402 || r.status === 429 || r.status >= 500) {
        await new Promise(x => setTimeout(x, 4000 * (attempt + 1)));
        continue;
      }
      break;
    } catch {
      lastStatus = 0;
      await new Promise(x => setTimeout(x, 3000));
    }
  }
  res.status(502).json({
    error: (lastStatus === 402 || lastStatus === 429)
      ? `${label} 생성 사용량을 잠시 초과했습니다. 1~2분 뒤 다시 시도해주세요.`
      : `${label} 생성 실패 (Pollinations ${lastStatus || '응답없음'})`
  });
}

/** 제공사별 오류를 사용자가 바로 손쓸 수 있는 문구로 다듬는다. */
function toClientError(err) {
  const raw = err.message || '오류';
  let msg = raw;
  const status0 = err.status >= 400 && err.status < 600 ? err.status : 500;

  // 우리가 직접 쓴 한국어 안내(레이트 리밋·키 요청 등)는 이미 충분히 친절하다.
  // 아래 분기가 그걸 덮어쓰지 않도록 여기서 그대로 돌려준다.
  if (/[가-힣]/.test(raw)) return { status: status0, msg: raw };

  // Anthropic 크레딧 소진. 영어 JSON 이 그대로 노출되던 자리라 제일 먼저 거른다.
  if (/credit balance is too low|insufficient.*credit|billing/i.test(raw)) {
    msg = 'Claude(Anthropic) 크레딧이 떨어졌습니다.\n' +
          '⚙️ 설정에서 무료 Groq 키로 바꿔주세요 — console.groq.com 에서 바로 발급됩니다.\n' +
          '(키 앞이 gsk_ 로 시작합니다)';
  } else if (/quota|prepayment credits are depleted|RESOURCE_EXHAUSTED/i.test(raw)) {
    msg = 'Gemini 사용 한도를 넘었습니다.\n' +
          '⚙️ 설정에서 무료 Groq 키(gsk_…)로 바꾸거나 내일 다시 시도해주세요.';
  } else if (err.status === 401 || err.status === 403 || /api.?key|authentication|invalid.*key/i.test(raw)) {
    msg = 'API 키가 올바르지 않습니다. ⚙️ 설정에서 키를 확인해주세요.';
  } else if (err.status === 429) {
    msg = '요청이 몰렸습니다. 1~2분 뒤에 다시 시도해주세요.';
  }

  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  return { status, msg };
}

module.exports = {
  detectProvider, callAI, callAIStream, callVision, parseJson,
  proxyPollinationsImage, toClientError
};
