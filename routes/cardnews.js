// 카드뉴스 / 인스타툰 생성 라우터  —  /api/cardnews/*
const express = require('express');
const { callAI, callVision, parseJson, proxyPollinationsImage, toClientError } = require('../lib/ai');

const router = express.Router();

const FOOD_KW = ['김밥','라면','치킨','피자','파스타','초밥','삼겹살','떡볶이','냉면','순대','갈비','삼계탕','된장','찌개','음식','요리','맛집','레시피','칼로리','식당','카페','커피','음료','디저트','케이크','빵','과자','스낵','제품','화장품','스킨케어','짜장','쌀국수','고기','채소','과일','반찬','소주','막걸리'];
const PLACE_KW = ['여행','풍경','관광','장소','호텔','카페투어','길거리','자연','바다','산','도시','거리','공원','건물','스팟','뷰','경치'];

// ── 스토리/콘텐츠 생성 ──────────────────────────────────────────
router.post('/generate-story', async (req, res) => {
  const { topic, numSlides = 6, artStyle = 'webtoon', character = '', apiKey } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: '주제를 입력해주세요.' });

  const n = Math.min(Math.max(parseInt(numSlides) || 6, 4), 10);
  const forceNoChar = [...FOOD_KW, ...PLACE_KW].some(k => topic.includes(k));

  const charHint = forceNoChar
    ? '⚠️ 음식/장소 주제. needsCharacter: false, characterDesc: "" 고정.'
    : character
    ? `캐릭터 힌트: "${character}" — 이를 기반으로 일관된 캐릭터 설정.`
    : '주제에 어울리는 귀여운 한국 인스타툰 캐릭터 자유롭게 설정.';

  const prompt = `인스타툰/카드뉴스 제작 — 주제: "${topic}"
슬라이드 수: ${n}장 | 아트 스타일: ${artStyle}
${charHint}

한국 인스타그램 저장/공유 폭발 인스타툰으로 구성. 각 슬라이드는 독립적인 정보 단위.

슬라이드 구성:
- 1번(hook): 강렬한 훅 제목, 핵심 메시지 1개
- 중간(info/steps): 각 슬라이드마다 구체적 정보 포인트 3~5개
- 마지막(cta): 저장/공유 유도

⚠️ 중요: 각 슬라이드의 points는 실제로 유용하고 구체적인 정보여야 함.
title은 10자 이내, titleAccent는 title 안에 포함된 강조어(색상 다르게 표시됨).
points 각 항목은 30자 이내 한 줄로.
speechBubble은 캐릭터 말풍선 (15자 이내, 없으면 빈 문자열).
tip은 하단 결론 박스 (40자 이내).
imagePrompt는 Pollinations.ai 이미지 생성용 영어 (캐릭터+장면, 흰 배경 수채화 스타일 지정).

반드시 아래 JSON만 응답 (설명 없이):
{
  "needsCharacter": true,
  "characterDesc": "영어 캐릭터 외모 묘사 (예: cute Korean housewife, short wavy brown hair, big expressive eyes, wearing yellow sweater and white apron, watercolor illustration style, white background)",
  "slides": [
    {
      "slide": 1,
      "layout": "hook",
      "title": "제목(10자이내)",
      "titleAccent": "강조어",
      "subtitle": "부제목(20자이내)",
      "speechBubble": "말풍선(15자이내또는빈문자열)",
      "points": ["포인트1(30자이내)", "포인트2", "포인트3"],
      "tip": "결론/팁(40자이내)",
      "imagePrompt": "English: watercolor illustration, white background, [character description], [scene/action related to topic], korean webtoon style, no text in image"
    }
  ]
}`;

  try {
    const data = parseJson(await callAI(apiKey, prompt, 8000), '스토리');

    const needsCharacter = !forceNoChar && !!data.needsCharacter && !!data.characterDesc;
    const characterDesc = needsCharacter ? (data.characterDesc || '') : '';

    const slides = (data.slides || []).slice(0, n).map(s => ({
      slide: s.slide,
      layout: s.layout || 'info',
      title: s.title || '',
      titleAccent: s.titleAccent || '',
      subtitle: s.subtitle || '',
      speechBubble: s.speechBubble || '',
      points: Array.isArray(s.points) ? s.points : (s.text ? [s.text] : []),
      tip: s.tip || '',
      imagePrompt: needsCharacter
        ? (s.imagePrompt || '')
        : `${s.imagePrompt || ''}, NO humans, NO people, NO face, NO character, food or place scenery only`
    }));

    res.json({ needsCharacter, characterDesc, slides });
  } catch (err) {
    console.error('[cardnews/generate-story]', err.message);
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

// ── 이미지 생성 ────────────────────────────────────────────────
router.get('/generate-image', async (req, res) => {
  const { prompt, style = 'webtoon', noHumans = 'false', characterDesc = '', seed } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });

  const noHumanFlag = noHumans === 'true';

  const styleMap = {
    webtoon: 'korean webtoon watercolor illustration, white paper background, clean line art, cute expressive characters, hand-drawn style, soft colors, no text,',
    minimal: 'minimalist flat illustration, white background, clean simple shapes, modern graphic,',
    bold:    'bold comic illustration, white background, strong vivid colors, dynamic comic style, clean lineart,',
    pastel:  'soft pastel watercolor illustration, white background, gentle kawaii style, warm dreamy tones,'
  };

  const prefix = noHumanFlag
    ? 'beautiful detailed illustration, white background, no people, food or scenery only, watercolor style,'
    : (styleMap[style] || styleMap.webtoon);

  const charPart = (!noHumanFlag && characterDesc) ? `character: ${characterDesc},` : '';
  const noHumanSuffix = noHumanFlag ? ', NO humans, NO face, NO body, NO character, NO anime girl' : '';
  const negative = noHumanFlag
    ? 'human,person,face,girl,boy,body,anime,character,text,watermark,logo,background,dark'
    : 'text,watermark,logo,bad anatomy,blurry,dark background,photorealistic,photo,3d render';

  const fullPrompt = `${prefix} ${charPart} ${prompt}, high quality, detailed illustration${noHumanSuffix}`;
  const s = seed || Math.floor(Math.random() * 99999);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1080&height=1080&nologo=true&seed=${s}&model=flux&negative=${encodeURIComponent(negative)}`;

  res.setHeader('X-Seed', String(s));
  await proxyPollinationsImage(res, url, '카드뉴스 이미지');
});

// ── 떡상 주제 추천 ─────────────────────────────────────────────
router.post('/suggest-topics', async (req, res) => {
  const { seed = '', apiKey } = req.body;
  const seedHint = seed?.trim()
    ? `참고 키워드: "${seed}"`
    : '트렌디하고 공감 가는 한국 인스타그램 인기 주제';

  const prompt = `한국 인스타그램에서 저장수·공유수 폭발하는 인스타툰/카드뉴스 주제 10개 추천.
${seedHint}

조건: 20~30대 한국인 공감, 클릭/저장 욕구 유발, 구체적인 정보형 주제.
카테고리: 청소/정리, 요리, 직장생활, 건강, 절약, 자기계발, 연애, 육아, 반려동물, 뷰티 등.

JSON만 응답:
{"topics": ["주제1", "주제2", "주제3", "주제4", "주제5", "주제6", "주제7", "주제8", "주제9", "주제10"]}`;

  try {
    res.json(parseJson(await callAI(apiKey, prompt, 800), '주제 추천'));
  } catch (err) {
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

// ── 캐릭터 분석 ───────────────────────────────────────────────
router.post('/analyze-character', async (req, res) => {
  const { imageBase64, mediaType = 'image/jpeg', apiKey } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지 데이터 필요' });

  try {
    const raw = await callVision(apiKey, imageBase64, mediaType,
`이 캐릭터 이미지를 분석해서 Pollinations.ai 이미지 생성용 영어 프롬프트를 만들어주세요.
JSON만 응답:
{
  "description": "영어 캐릭터 외모 묘사. 헤어, 눈, 의상, 체형, 아트 스타일 포함. watercolor illustration style, white background 포함",
  "nameKo": "캐릭터 짧은 한국어 설명"
}`, 600);

    if (raw === null) {
      return res.status(422).json({
        error: '이미지 분석은 Gemini(AIza…) 또는 Claude(sk-ant-…) 키에서만 됩니다. 캐릭터 설명을 직접 입력해주세요.',
        unsupported: true
      });
    }
    res.json(parseJson(raw, '캐릭터 분석'));
  } catch (err) {
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

module.exports = router;
