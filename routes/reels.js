// 릴스 영상 메이커 라우터  —  /api/reels/*
const express = require('express');
const { callAI, callVision, parseJson, proxyPollinationsImage, toClientError } = require('../lib/ai');

const router = express.Router();

// ── 릴스 스크립트 생성 ─────────────────────────────────────────
router.post('/generate-script', async (req, res) => {
  const { topic, duration = 15, style = 'trendy', characterDesc = '', videoRef = null, apiKey } = req.body;
  if (!topic?.trim()) return res.status(400).json({ error: '주제를 입력해주세요.' });

  const dur = parseInt(duration);
  const sceneCount = dur <= 15 ? 4 : dur <= 20 ? 5 : dur <= 25 ? 5 : 6;
  const secPerScene = parseFloat((dur / sceneCount).toFixed(1));

  const styleGuide = {
    trendy: '트렌디하고 세련된 MZ 감성, 임팩트 있는 짧은 문구, 강렬한 시각 구성',
    minimal: '깔끔하고 미니멀, 여백 활용, 핵심만 간결하게',
    dramatic: '극적이고 강렬한 감정 자극, 반전 포인트 활용',
    cute: '귀엽고 친근한 느낌, 이모지 풍부하게, 밝고 따뜻한 톤'
  };

  const charHint = characterDesc
    ? `\n🎭 등장 캐릭터/제품: ${characterDesc}\n→ imagePrompt에 이 캐릭터/제품을 배경 장면에 어울리도록 반드시 포함시켜.`
    : '';

  let videoHint = '';
  if (videoRef) {
    const sa = videoRef.styleAnalysis;
    if (sa) {
      videoHint = `
📹 벤치마킹 참고 영상: "${videoRef.title}" (${videoRef.author})
━━━ 이 영상 스타일을 그대로 복제해서 비슷한 퀄리티로 만들어 ━━━
• 컨셉: ${sa.concept || '-'}
• 분위기: ${sa.mood || '-'}
• 색감: ${sa.colorPalette || '-'}
• 조명: ${sa.lightingStyle || '-'}
• 구도: ${sa.compositionStyle || '-'}
• 편집: ${sa.editingVibe || '-'}
• 텍스트 스타일: ${sa.textStyle || '-'}
• 후킹 전략: ${sa.contentStrategy || '-'}
• imagePrompt 스타일 키워드 (반드시 포함): ${sa.imagePromptStyle || '-'}
→ imagePrompt는 위 스타일 키워드를 반드시 포함해서 참고 영상과 같은 비주얼로 만들어.
→ mainText·subText·narration 톤도 위 편집 느낌과 후킹 전략에 맞게 써.`;
    } else {
      videoHint = `
📹 벤치마킹 참고 영상: "${videoRef.title}" (${videoRef.author})
→ 이 영상의 컨셉/편집 스타일/분위기/후킹 방식을 분석해서 그대로 적용해.
→ 컨셉 자동 감지: 음식이면 클로즈업·따뜻한 조명, 여행이면 와이드샷·골든아워, 라이프스타일이면 밝은 인테리어·자연광.`;
    }
  }

  const prompt = `인스타그램 릴스 ${dur}초 영상 스크립트 — 주제: "${topic}"
장면: ${sceneCount}개 | 장면당: ${secPerScene}초 | 스타일: ${styleGuide[style] || styleGuide.trendy}
${charHint}${videoHint}

🎯 목표: 처음 1초에 시선 고정 → 끝까지 보게 만드는 구성

장면 구성 규칙:
- 1번(hook): 숫자/충격적 사실/강한 질문으로 즉시 시선 고정
- 중간(info): 장면마다 핵심 정보 1가지씩, 구체적인 내용
- 마지막(cta): 감성적 마무리 또는 공감 유도

텍스트 규칙:
- mainText: 8자 이내 (캔버스 크게 표시) — ⚠️ "저장", "팔로우", "공유", "구독" 단어 절대 금지
- subText: 18자 이내 (mainText 아래 설명)
- keyword: 3자 이내 강조 단어 (숫자나 핵심 키워드만)
- narration: 해당 장면에서 실제로 말할 나레이션 대사 (60자 이내, 자연스러운 구어체, 시청자에게 직접 말하는 말투)

imagePrompt 규칙:
- 반드시 영어로 작성
- 세로형(9:16) vertical composition
- 배경은 장면 내용/컨셉과 어울리는 분위기
- 사람 포함 금지
- 스타일: cinematic, high contrast, atmospheric lighting

JSON만 응답:
{
  "title": "릴스 제목(15자이내)",
  "concept": "음식|여행|라이프스타일|뷰티|운동|자기계발|반려동물|기타",
  "scenes": [
    {
      "id": 1,
      "type": "hook",
      "duration": ${secPerScene},
      "mainText": "메인텍스트(8자이내)",
      "keyword": "강조어(3자이내)",
      "subText": "부연설명(18자이내)",
      "emoji": "🔥",
      "narration": "실제 나레이션 대사 (60자이내, 구어체)",
      "imagePrompt": "English: vertical 9:16, cinematic, [vivid concept-matched scene], atmospheric lighting, no text, no people, ultra detailed"
    }
  ],
  "hashtags": ["#태그1","#태그2","#태그3","#태그4","#태그5"]
}`;

  try {
    res.json(parseJson(await callAI(apiKey, prompt, 4000), '스크립트'));
  } catch (err) {
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

// ── 이미지 분석 ────────────────────────────────────────────────
router.post('/analyze-image', async (req, res) => {
  const { imageBase64, mediaType = 'image/jpeg', apiKey } = req.body;
  if (!imageBase64) return res.status(400).json({ error: '이미지 데이터 필요' });

  try {
    const raw = await callVision(apiKey, imageBase64, mediaType,
`이 이미지를 분석해서 인스타그램 릴스 영상 배경 생성 프롬프트에 쓸 영어 설명을 작성해주세요.
JSON만 응답:
{
  "description": "영어: 외형/특징/스타일/분위기 묘사 (Pollinations.ai 프롬프트용, 50단어 이내)",
  "nameKo": "한국어 짧은 설명 (10자이내)"
}`, 400);

    if (raw === null) {
      return res.status(422).json({
        error: '이미지 분석은 Gemini(AIza…) 또는 Claude(sk-ant-…) 키에서만 됩니다. 설명을 직접 입력해주세요.',
        unsupported: true
      });
    }
    res.json(parseJson(raw, '이미지 분석'));
  } catch (err) {
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

// ── 주제 추천 ──────────────────────────────────────────────────
router.post('/suggest-topics', async (req, res) => {
  const { seed = '', apiKey } = req.body;
  const hint = seed?.trim() ? `키워드: "${seed}"` : '최신 한국 인스타그램 릴스 트렌드';

  const prompt = `한국 인스타그램 릴스 조회수 터지는 주제 10개.
${hint}

조건: 15-30초 영상으로 만들기 좋은 주제, 20-30대 공감, 시각적으로 흥미로운 것.

JSON만:
{"topics":["주제1","주제2","주제3","주제4","주제5","주제6","주제7","주제8","주제9","주제10"]}`;

  try {
    res.json(parseJson(await callAI(apiKey, prompt, 800), '주제 추천'));
  } catch (err) {
    const { status, msg } = toClientError(err);
    res.status(status).json({ error: msg });
  }
});

// ── 참고 영상 정보 + 썸네일 분석 ─────────────────────────────
const STYLE_SCHEMA = `{
  "concept": "이 영상의 메인 컨셉 (음식/여행/라이프스타일/뷰티/운동/자기계발/기타)",
  "mood": "전체적인 분위기 (예: 따뜻하고 감성적, 역동적이고 에너지 넘치는, 차갑고 세련된 등)",
  "colorPalette": "주요 색상 톤 (예: 따뜻한 오렌지·베이지, 시원한 블루·화이트, 다크·네온 등)",
  "lightingStyle": "조명 스타일 (예: 골든아워 자연광, 스튜디오 소프트박스, 로우키 드라마틱 등)",
  "compositionStyle": "구도 스타일 (예: 클로즈업 디테일 집중, 와이드샷 풍경 강조, 인물 중심 프레이밍 등)",
  "editingVibe": "편집 느낌 (예: 빠른 컷편집 에너지감, 느린 감성 무드, 깔끔한 미니멀 등)",
  "textStyle": "텍스트/자막 스타일 (예: 굵은 임팩트 폰트, 손글씨 감성, 깔끔한 고딕 등)",
  "imagePromptStyle": "Pollinations.ai 이미지 생성에 쓸 영어 스타일 키워드 (예: warm golden hour, bokeh, cinematic 등, 20단어이내)",
  "contentStrategy": "이 영상이 쓰는 후킹 전략 (예: 숫자 나열, 비포애프터, 공감 질문, 놀라운 사실 공개 등)"
}`;

router.post('/video-info', async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const r = await fetch(oembedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('YouTube 영상을 찾을 수 없습니다. URL을 확인해주세요.');
    const d = await r.json();

    // 고해상도 썸네일 시도 (maxresdefault → oEmbed 기본값 폴백)
    let thumbUrl = d.thumbnail_url || '';
    const vidIdMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
    if (vidIdMatch) {
      const hq = `https://img.youtube.com/vi/${vidIdMatch[1]}/maxresdefault.jpg`;
      try {
        const tr = await fetch(hq, { method: 'HEAD' });
        if (tr.ok) thumbUrl = hq;
      } catch {}
    }

    const info = { title: d.title, author: d.author_name, thumbnail: thumbUrl, platform: 'YouTube' };

    // Gemini·Claude 키면 썸네일을 직접 보고, 아니면 제목·채널명으로 추정한다.
    try {
      let raw = null;
      if (thumbUrl) {
        const imgR = await fetch(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (imgR.ok) {
          const imgB64 = Buffer.from(await imgR.arrayBuffer()).toString('base64');
          const ct = imgR.headers.get('content-type') || 'image/jpeg';
          raw = await callVision(apiKey, imgB64, ct,
`이 영상 썸네일을 분석해서 인스타그램 릴스 영상 제작에 활용할 스타일 가이드를 JSON으로 작성해주세요.

JSON만 응답:
${STYLE_SCHEMA}`, 600);
        }
      }

      if (raw === null) {
        raw = await callAI(apiKey,
`아래 유튜브 영상의 제목과 채널명만 보고, 이 영상이 어떤 스타일일지 추정해서
인스타그램 릴스 제작용 스타일 가이드를 JSON으로 작성해주세요.

제목: ${info.title}
채널: ${info.author}

JSON만 응답:
${STYLE_SCHEMA}`, 1200);
        info.styleGuessed = true; // 썸네일을 직접 못 봤다는 표시
      }

      info.styleAnalysis = parseJson(raw, '스타일 분석');
    } catch (e) {
      console.warn('[reels/video-info] 스타일 분석 실패:', e.message);
    }

    res.json(info);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── TTS (Google Translate 프록시) ─────────────────────────────
router.get('/tts', async (req, res) => {
  const { text, lang = 'ko' } = req.query;
  if (!text) return res.status(400).json({ error: 'text 필요' });
  const encoded = encodeURIComponent(text.slice(0, 200));
  const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encoded}&tl=${lang}&client=gtx&ttsspeed=0.9`;
  try {
    const r = await fetch(ttsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/',
        'Accept': 'audio/mpeg,audio/*;q=0.9,*/*;q=0.8'
      }
    });
    if (!r.ok) throw new Error(`TTS ${r.status}`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── 이미지 생성 (세로형) ───────────────────────────────────────
router.get('/generate-image', async (req, res) => {
  const { prompt, seed } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });
  const s = seed || Math.floor(Math.random() * 99999);
  const full = `${prompt}, vertical composition 9:16, ultra detailed, cinematic, high quality, instagram reel`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=576&height=1024&nologo=true&seed=${s}&model=flux&negative=${encodeURIComponent('text,watermark,logo,blurry,ugly,distorted,person,face,human')}`;
  await proxyPollinationsImage(res, url, '릴스 이미지');
});

module.exports = router;
