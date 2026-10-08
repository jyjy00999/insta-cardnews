// 인스타그램 콘텐츠 파이프라인 라우터  —  /api/pipeline/*
// 주제 하나를 리서치 → 기획 → 작성 → 검토 → 퍼블리싱 5단계로 흘려보낸다.
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { callAI, callAIStream, detectProvider, proxyPollinationsImage, toClientError } = require('../lib/ai');
const { STAGES } = require('./pipeline-stages');

const router = express.Router();

const jobs = new Map();

// Render 의 디스크는 재시작하면 날아간다. 결과는 job 객체에도 들고 있으므로
// 파일 쓰기는 거들 뿐이고, 실패해도 파이프라인을 멈추지 않는다.
const outputDir = path.join(__dirname, '..', 'output');
try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

// 오래된 job 이 메모리에 쌓이지 않도록 2시간마다 정리한다.
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000).unref();

function emit(job, type, data = {}) {
  const event = { type, ...data };
  job.events.push(event);
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  job.clients.forEach(c => { try { c.write(msg); } catch {} });
}

async function runPipeline(job, apiKey) {
  emit(job, 'pipeline_start', { topic: job.topic });

  let skipUntilFound = !!job.startFrom;

  for (const stage of STAGES) {
    if (skipUntilFound) {
      if (stage.id === job.startFrom) {
        skipUntilFound = false;
      } else {
        if (job.outputs[stage.id]) {
          emit(job, 'stage_skip', { stage: stage.id, content: job.outputs[stage.id] });
        }
        continue;
      }
    }

    emit(job, 'stage_start', { stage: stage.id });
    let success = false;
    let attempts = 0;
    const MAX_RETRIES = 5;

    while (!success && attempts < MAX_RETRIES) {
      attempts++;
      try {
        let content = '';
        const systemPrompt = stage.getSystem(job.style);
        const userPrompt   = stage.getPrompt(job.topic, job.outputs, job.style, job.postType);

        for await (const text of callAIStream(apiKey, systemPrompt, userPrompt)) {
          content += text;
          emit(job, 'chunk', { stage: stage.id, text });
        }

        job.outputs[stage.id] = content;
        try {
          fs.writeFileSync(path.join(outputDir, `${job.id}_${stage.file}`), content, 'utf-8');
        } catch (e) {
          console.warn('[pipeline] 결과 파일 저장 실패(무시):', e.message);
        }
        emit(job, 'stage_complete', { stage: stage.id, file: stage.file });
        success = true;

      } catch (err) {
        const status = err.status || 0;
        console.error(`[pipeline/${stage.id}] 오류 (시도 ${attempts}/${MAX_RETRIES}):`, err.message?.slice(0, 300));

        if ((status === 529 || status === 429 || /overloaded|rate.limit/i.test(err.message || '')) && attempts < MAX_RETRIES) {
          const waitSec = Math.min(30 * attempts, 120);
          emit(job, 'stage_retry', { stage: stage.id, attempt: attempts, waitSec,
            message: `서버 과부하/할당량 초과 — ${waitSec}초 후 자동 재시도 (${attempts}/${MAX_RETRIES})` });
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }

        // 크레딧 소진·한도 초과 같은 건 공용 매퍼가 한국어 안내로 바꿔준다.
        let msg = toClientError(err).msg;
        if (status === 401 || status === 403 || /api.?key|invalid|authentication/i.test(err.message || '')) {
          const provider = detectProvider(apiKey);
          const keyGuide = provider === 'gemini' ? 'Google Gemini API 키(AIza...)' :
                           provider === 'groq'   ? 'Groq API 키(gsk_...)' :
                           provider === 'free'   ? 'Pollinations 서버' :
                           'Anthropic API 키(sk-ant-...)';
          msg = `API 키가 올바르지 않습니다. ⚙️ 설정에서 ${keyGuide}를 확인해주세요.`;
        } else if (status === 529) {
          msg = 'AI 서버가 일시적으로 과부하 상태입니다. 잠시 후 재시도해주세요.';
        } else if (status === 404) {
          msg = '모델을 찾을 수 없습니다.';
        }
        emit(job, 'stage_error', { stage: stage.id, message: msg });
        job.status = 'error';
        return;
      }
    }
  }
  job.status = 'complete';
  emit(job, 'pipeline_complete', {});
}

// ─── 파이프라인 시작 / 스트림 ─────────────────────────────────────────────
router.post('/start', async (req, res) => {
  const { topic, apiKey, style, postType, previousOutputs, startFrom } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: '주제를 입력해주세요.' });

  const jobId = `job_${Date.now()}`;
  const job = {
    id: jobId,
    topic: topic.trim(),
    style: style?.trim() || '',
    postType: postType || '단일 포스트',
    outputs: previousOutputs || {},
    startFrom: startFrom || null,
    events: [],
    clients: [],
    status: 'running',
    createdAt: Date.now()
  };
  jobs.set(jobId, job);
  runPipeline(job, apiKey?.trim() || '').catch(err => {
    emit(job, 'error', { message: err.message });
    job.status = 'error';
  });
  res.json({ jobId });
});

router.get('/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  job.events.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
  if (job.status === 'complete' || job.status === 'error') { res.end(); return; }
  job.clients.push(res);
  req.on('close', () => { job.clients = job.clients.filter(c => c !== res); });
});

router.get('/output/:jobId/:stage', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const content = job.outputs[req.params.stage];
  if (content === undefined) return res.status(404).json({ error: 'Not yet available' });
  res.json({ content });
});

// ─── 추천 주제 ────────────────────────────────────────────────────────────
router.post('/suggest-topics', async (req, res) => {
  const { topic, apiKey, postType } = req.body;

  const prompt = `인스타그램 포스트 타입: **${postType || '단일 포스트'}**
키워드/주제: **${topic || '(없음)'}**

위 키워드와 관련하여 인스타그램에서 조회수가 폭발하고 저장/공유가 엄청나게 많이 될 만한 구체적인 포스트 주제 10개를 추천해주세요.

조건:
- 클릭과 저장을 유도하는 강렬한 제목/주제
- 한국 인스타그램 트렌드 반영
- 너무 평범하지 않고 독특한 각도
- 숫자, 비교, 비밀, 반전, 공감 등의 훅 요소 활용
- 각 주제는 실제 포스트 캡션 첫 줄처럼 구체적으로

반드시 다음 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
["주제1", "주제2", "주제3", "주제4", "주제5", "주제6", "주제7", "주제8", "주제9", "주제10"]`;

  try {
    const text = await callAI(apiKey, prompt, 2000);
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('응답 파싱 실패');
    res.json({ topics: JSON.parse(match[0]) });
  } catch (err) {
    console.error('[pipeline/suggest-topics]', err.message);
    { const e = toClientError(err); res.status(e.status).json({ error: e.msg }); }
  }
});

// ─── 카드뉴스 슬라이드 프롬프트 생성 ──────────────────────────────────────
router.post('/generate-slide-prompts', async (req, res) => {
  const { topic, writerContent, numSlides, apiKey, artStyle } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: '주제 필요' });

  const n = Math.min(Math.max(parseInt(numSlides) || 6, 5), 8);
  const style = artStyle || '만화/웹툰';

  // 키워드 기반 강제 분류 — 모델 판단보다 우선한다.
  const FOOD_KW = ['김밥','라면','치킨','피자','파스타','초밥','삼겹살','떡볶이','냉면','순대','갈비','삼계탕','된장','찌개','음식','요리','맛집','레시피','칼로리','식당','카페','커피','음료','디저트','케이크','빵','과자','스낵','제품','상품','화장품','스킨케어'];
  const PLACE_KW = ['여행','풍경','관광','장소','호텔','카페투어','길거리','거리','자연','바다','산','도시','거리뷰'];
  const forcedNoChar = FOOD_KW.some(k => topic.includes(k)) || PLACE_KW.some(k => topic.includes(k));

  const needsCharHint = forcedNoChar
    ? `\n⚠️ 이 주제(${topic})는 음식/장소/제품 주제이므로 characterDesc는 반드시 빈 문자열 ""이고, needsCharacter는 반드시 false여야 합니다. 절대로 사람을 등장시키지 마세요.`
    : `\n주제 분류 기준 (characterDesc 결정):
- 음식/요리/맛집/음료/제품/상품/도구 → characterDesc: "" (사람 불필요, 음식/제품 자체가 주인공)
- 장소/여행/풍경 → characterDesc: "" (배경/풍경 자체가 주인공)
- 생활 팁/운동/공부/감정/스토리텔링 등 → 사람 캐릭터 필요 시 characterDesc 작성`;

  const prompt = `인스타그램 카드뉴스 주제: **${topic}**
슬라이드 수: ${n}장
아트 스타일: ${style}

${writerContent ? `작성된 캡션/슬라이드 내용 참고:\n${writerContent.slice(0, 2000)}` : ''}
${needsCharHint}

위 주제로 인스타그램 카드뉴스 ${n}장을 위한 구성을 만들어주세요.

핵심 요구사항:
1. 이 주제에 사람 캐릭터가 필요한지 스스로 판단하세요
2. 필요 없으면 characterDesc를 빈 문자열 ""로 남기세요
3. 필요하다면 모든 슬라이드에서 외모가 동일하도록 상세히 영어로 정의하세요
4. 각 슬라이드 prompt는 해당 슬라이드의 "장면/피사체/구도"를 구체적으로 묘사하세요
5. slide 1: 표지(제목+훅), slide 2~${n-1}: 핵심 내용, slide ${n}: 마무리+CTA

반드시 아래 JSON 형식만 응답 (다른 텍스트 없이):
{
  "needsCharacter": true/false,
  "characterDesc": "사람 불필요 주제면 빈 문자열. 필요하면: detailed English description of the consistent character appearance for all slides",
  "slides": [
    {
      "slide": 1,
      "title": "슬라이드 제목 (한국어, 15자 이내, 임팩트 있게)",
      "text": "핵심 메시지 (한국어, 40자 이내, 독자에게 직접 말하듯)",
      "prompt": "English image prompt: specific visual description — if no character, describe the food/product/scene in vivid detail (close-up, lighting, texture, presentation, background). If character present, describe scene/action only (not appearance)"
    }
  ]
}`;

  try {
    const raw = (await callAI(apiKey, prompt, 4000)).trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('파싱 실패: ' + raw.slice(0, 300));
    const data = JSON.parse(match[0]);
    if (!data.slides || !Array.isArray(data.slides)) throw new Error('slides 배열 없음');

    // forcedNoChar 이면 모델이 뭐라 하든 캐릭터 금지
    const needsCharacter = !forcedNoChar && !!data.needsCharacter && !!data.characterDesc;

    const slides = data.slides.map(s => ({
      ...s,
      prompt: needsCharacter
        ? s.prompt
        : `${s.prompt}, NO humans, NO people, NO person, NO face, NO character, NO anime girl, NO body, food/product/place only`
    }));

    res.json({ characterDesc: needsCharacter ? (data.characterDesc || '') : '', needsCharacter, slides });
  } catch (err) {
    console.error('[pipeline/generate-slide-prompts]', err.message);
    { const e = toClientError(err); res.status(e.status).json({ error: e.msg }); }
  }
});

// ─── 이미지 생성 ──────────────────────────────────────────────────────────
router.get('/generate-image', async (req, res) => {
  const { prompt, style = 'comic', width = '1080', height = '1080', seed, noHumans = 'false' } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });

  const stylePrefix = {
    'comic':   'comic book style, manga webtoon illustration, vibrant colors, clean bold lines, korean webtoon art,',
    'anime':   'anime style illustration, studio ghibli inspired, soft colors, detailed background,',
    'flat':    'flat design illustration, modern infographic style, clean minimal, bold colors,',
    'sketch':  'pencil sketch illustration, hand-drawn style, black and white with color accents,',
    'photo':   'ultra realistic photography, professional DSLR, 8K resolution, sharp focus, perfect studio lighting, photorealistic, hyperrealistic,'
  };

  const noHumanFlag = noHumans === 'true';
  const prefix = stylePrefix[style] || stylePrefix['comic'];

  const foodPrefix = noHumanFlag
    ? (style === 'photo'
        ? 'ultra realistic food photography, professional studio lighting, macro lens, 8K resolution, mouth-watering, appetizing presentation, award-winning food photo,'
        : `${style} style illustration, beautiful food photography inspired, close-up macro shot, appetizing presentation,`)
    : prefix;

  const noHumanSuffix = noHumanFlag
    ? ', no humans, no people, no person, no face, no character, no body parts'
    : '';

  // "no text" 같은 부정문은 긍정 프롬프트에 넣으면 안 된다.
  // 확산 모델은 부정을 이해하지 못해서 오히려 글자를 그려 넣는다.
  // 실제로 카드 배경에 깨진 한글이 잔뜩 생겼었다. 억제는 negative 쪽에서 한다.
  const fullPrompt = `${foodPrefix} ${prompt}, high quality, detailed${noHumanSuffix}`;

  const noTextNeg = 'text, letters, words, writing, typography, caption, subtitle, ' +
    'korean text, hangul, chinese characters, japanese text, alphabet, numbers, ' +
    'signage, poster text, watermark, logo, signature, gibberish text, garbled text';

  const negative = noHumanFlag
    ? `human, person, people, face, girl, boy, man, woman, body, hands, anime character, anime girl, portrait, character, figure, silhouette, torso, skin, hair, ${noTextNeg}`
    : `blurry, low quality, ${noTextNeg}`;

  const s = seed || Math.floor(Math.random() * 99999);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=${width}&height=${height}&nologo=true&seed=${s}&model=flux&negative=${encodeURIComponent(negative)}`;

  res.setHeader('X-Seed', String(s));
  await proxyPollinationsImage(res, url, '파이프라인 이미지');
});

// ─── 이미지 검색 ──────────────────────────────────────────────────────────
router.get('/images/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q 파라미터가 필요합니다.' });
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  try {
    const initR = await fetch(`https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=images`, { headers: { 'User-Agent': UA } });
    const initHtml = await initR.text();
    const vqdMatch = initHtml.match(/vqd=['"]([^'"]+)['"]/);
    if (!vqdMatch) throw new Error('DuckDuckGo 토큰 획득 실패');
    const vqd = vqdMatch[1];
    const imgR = await fetch(`https://duckduckgo.com/i.js?l=kr-kr&o=json&q=${encodeURIComponent(q)}&vqd=${encodeURIComponent(vqd)}&f=,,,,,&p=1`,
      { headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/' } });
    const data = await imgR.json();
    const images = (data.results || []).slice(0, 6).map((img, i) => ({
      id: i, thumb: img.thumbnail || img.image, large: img.image,
      photographer: img.source || '', alt: img.title || q
    }));
    res.json({ images, total: data.results?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/images/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://search.naver.com/' } });
    if (!r.ok) throw new Error(`${r.status}`);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

// ─── 모델 선택 ────────────────────────────────────────────────────────────
let currentModel = 'claude-sonnet-4-5';

const CLAUDE_MODELS = [
  { id: 'claude-opus-5-20251101',        name: 'Claude Opus 5 (최강)' },
  { id: 'claude-sonnet-4-5-20251101',    name: 'Claude Sonnet 4.5 (권장)' },
  { id: 'claude-sonnet-4-5',             name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001',     name: 'Claude Haiku 4.5 (빠름)' },
  { id: 'claude-opus-4-5',               name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-20250514',      name: 'Claude Sonnet 4' },
  { id: 'claude-haiku-3-5-20241022',     name: 'Claude Haiku 3.5 (경제적)' }
];

router.post('/set-model', (req, res) => {
  const { model } = req.body;
  if (!model) return res.status(400).json({ error: 'model 필요' });
  const m = model.trim();
  if (m.startsWith('gemini')) {
    return res.status(400).json({ error: 'Gemini 모델은 지원하지 않습니다. Claude 모델을 선택해주세요.' });
  }
  currentModel = m;
  STAGES.forEach(s => s.model = currentModel);
  res.json({ model: currentModel });
});

router.get('/get-model', (req, res) => res.json({ model: currentModel }));

router.get('/list-models', (req, res) => {
  res.json({ models: CLAUDE_MODELS.map(m => m.id), modelDetails: CLAUDE_MODELS });
});

// ─── 네이버 이미지 검색 ───────────────────────────────────────────────────
router.get('/naver-image-search', async (req, res) => {
  const { query, clientId, clientSecret } = req.query;
  if (!query) return res.status(400).json({ error: 'query 필요' });
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'Naver API 키 필요' });
  try {
    const url = `https://openapi.naver.com/v1/search/image?query=${encodeURIComponent(query)}&display=6&sort=sim`;
    const r = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': clientId.trim(),
        'X-Naver-Client-Secret': clientSecret.trim()
      }
    });
    const data = await r.json();
    if (data.errorCode) return res.status(400).json({ error: data.errorMessage });
    res.json({ items: (data.items || []).map(i => ({ url: i.link || i.thumbnail, thumb: i.thumbnail, title: i.title?.replace(/<[^>]+>/g, '') })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 네트워크 정보 ────────────────────────────────────────────────────────
router.get('/network-info', (req, res) => {
  if (process.env.RENDER_EXTERNAL_URL) {
    const url = process.env.RENDER_EXTERNAL_URL;
    return res.json({ ip: 'cloud', port: 443, url, localUrl: url, tunnelUrl: null, tunnelReady: false });
  }
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  outer: for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break outer; }
  const port = process.env.PORT || 3003;
  const url = `http://${ip}:${port}`;
  res.json({ ip, port, url, localUrl: url, tunnelUrl: null, tunnelReady: false });
});

module.exports = router;
