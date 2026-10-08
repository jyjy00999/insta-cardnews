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

/** 텍스트 생성. 제공사는 키 앞글자로 자동 선택된다. */
async function callAI(apiKey, prompt, maxTokens = 8192) {
  const key = apiKey?.trim() || '';
  const provider = detectProvider(key);
  if (provider === 'gemini') return callGeminiText(key, prompt, maxTokens);
  if (provider === 'groq')   return callGroqText(key, prompt, maxTokens);
  if (provider === 'free')   return callPollinationsText(prompt);
  const client = new Anthropic({ apiKey: key });
  const r = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });
  return r.content[0]?.text || '';
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

/** 텍스트를 조각 단위로 흘려보낸다. 제공사는 키 앞글자로 자동 선택된다. */
async function* callAIStream(apiKey, systemPrompt, userPrompt) {
  const key = apiKey?.trim() || '';
  const provider = detectProvider(key);

  if (provider === 'gemini') { yield* streamGemini(key, systemPrompt, userPrompt); return; }
  if (provider === 'groq')   { yield* streamGroq(key, systemPrompt, userPrompt); return; }

  if (provider === 'free') {
    // Pollinations 는 스트리밍이 없다. 한 번에 받아서 통째로 넘긴다.
    yield await callPollinationsText(`${systemPrompt}\n\n${userPrompt}`);
    return;
  }

  const client = new Anthropic({ apiKey: key });
  const stream = await client.messages.create({
    model: 'claude-sonnet-4-5', max_tokens: 8192, system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }], stream: true
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
      yield event.delta.text;
    }
  }
}

/**
 * 이미지 분석. Gemini 와 Anthropic 만 지원한다.
 * Groq 의 gpt-oss 와 Pollinations 는 이미지 입력을 못 받으므로 null 을 돌려주고,
 * 호출한 쪽이 분석 없이 넘어가게 한다.
 */
async function callVision(apiKey, imageB64, mediaType, prompt, maxTokens = 1000) {
  const key = apiKey?.trim() || '';
  const provider = detectProvider(key);

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

/** 무료 모델이 붙이는 ```json 펜스와 앞뒤 설명을 걷어내고 JSON 만 뽑는다. */
function parseJson(raw, label = 'JSON') {
  const text = (raw || '').trim().replace(/```json/gi, '').replace(/```/g, '');
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`${label} 파싱 실패`);
  return JSON.parse(match[0]);
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
