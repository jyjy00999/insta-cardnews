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

  // 나레이션이 장면보다 길면 다음 장면 음성과 겹쳐 두 사람이 말하는 것처럼 들린다.
  // 실측: 45자 7.68초, 17자 3.17초 → 초당 약 5.3자. 띄어쓰기와 문장 끝 쉼까지
  // 감안해 5.0 으로 잡고, 말 앞뒤 여유 0.8초를 뺀 만큼만 쓰게 한다.
  const narrLimit = Math.max(10, Math.floor((secPerScene - 0.8) * 5.0));

  const styleGuide = {
    trendy: '트렌디하고 세련된 MZ 감성, 임팩트 있는 짧은 문구, 강렬한 시각 구성',
    minimal: '깔끔하고 미니멀, 여백 활용, 핵심만 간결하게',
    dramatic: '극적이고 강렬한 감정 자극, 반전 포인트 활용',
    cute: '귀엽고 친근한 느낌, 이모지 풍부하게, 밝고 따뜻한 톤'
  };

  const hasChar = !!(characterDesc || '').trim();
  const charHint = hasChar
    ? `\n🎭 주인공 캐릭터/제품: ${characterDesc}
→ 이 캐릭터가 영상의 주인공이다. 모든 장면의 imagePrompt 맨 앞에 이 캐릭터를 넣고,
  장면마다 무엇을 하고 있는지(동작·표정·위치)를 이어서 써라.
→ 장면이 바뀌어도 같은 캐릭터로 보이도록 생김새 묘사를 매번 그대로 반복해라.`
    : '';

  let videoHint = '';
  if (videoRef) {
    const sa = videoRef.styleAnalysis;
    // 인스타 참고 글은 캡션을 통째로 들고 온다. 말투를 그대로 배우게 넘긴다.
    const capHint = videoRef.caption
      ? `\n━━━ 참고 게시물의 실제 캡션 ━━━\n${String(videoRef.caption).slice(0, 600)}\n→ 이 글의 말투·호흡·후킹 방식을 그대로 따라 써라. 내용은 베끼지 말고 방식만 가져와라.`
      : '';
    if (sa) {
      videoHint = `
📹 벤치마킹 참고 영상: "${videoRef.title}" (${videoRef.author} · ${videoRef.platform || ''})${capHint}
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
📹 벤치마킹 참고 영상: "${videoRef.title}" (${videoRef.author} · ${videoRef.platform || ''})${capHint}
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
- narration: 해당 장면에서 실제로 말할 나레이션 대사 (⚠️ ${narrLimit}자 이내, 자연스러운 구어체, 시청자에게 직접 말하는 말투)
  ⚠️ 글자 수를 반드시 지켜라. 한국어 음성은 1초에 약 5.5자를 읽는다.
     장면이 ${secPerScene}초뿐이라 ${narrLimit}자를 넘으면 다음 장면 음성과 겹쳐서 영상을 못 쓴다.
     길게 쓰지 말고, 한 장면에 한 가지만 짧게 말해라.

imagePrompt 규칙:
- 반드시 영어로 작성
- 세로형(9:16) vertical composition
- 배경은 장면 내용/컨셉과 어울리는 분위기
${hasChar
  ? '- 위 주인공 캐릭터를 매 장면 맨 앞에 넣고, 그 캐릭터가 하는 행동을 이어서 묘사'
  : '- 사람 포함 금지'}
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
    res.json(parseJson(await callAI(apiKey, prompt, 8000), '스크립트'));
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

/** &amp; &#x1f440; 같은 엔티티를 되돌린다. 인스타 og 태그가 전부 이렇게 인코딩돼 있다. */
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * 인스타그램 게시물 정보.
 * 공개 oEmbed 는 임베드 HTML 만 주고 제목·썸네일은 토큰을 요구한다.
 * 다만 링크 미리보기용 og 태그는 크롤러 UA 로 받으면 그대로 내려온다.
 */
async function fetchInstagramInfo(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error(`인스타그램 게시물을 불러오지 못했습니다 (${r.status}). 공개 게시물인지 확인해주세요.`);
  const html = await r.text();

  const pick = p => decodeEntities(
    (html.match(new RegExp(`<meta\\s+property="og:${p}"\\s+content="([^"]*)"`)) || [])[1] || ''
  );
  const ogTitle = pick('title'), ogDesc = pick('description'), thumbnail = pick('image');
  if (!ogTitle && !ogDesc) {
    throw new Error('인스타그램에서 정보를 읽지 못했습니다. 비공개 게시물이거나 삭제됐을 수 있습니다.');
  }

  // og:description 형태: `476 likes, 6 comments - health_tip_mag on October 2, 2026: "본문..."`
  const m = ogDesc.match(/^.*?-\s*([^\s]+)\s+on\s+[^:]+:\s*"?([\s\S]*?)"?$/);
  const author  = m ? m[1] : (ogTitle.split(' on Instagram')[0] || '');
  const caption = (m ? m[2] : ogDesc).trim();

  return {
    title: caption.split('\n')[0].slice(0, 60) || ogTitle.slice(0, 60),
    author, caption, thumbnail, platform: 'Instagram'
  };
}

router.post('/video-info', async (req, res) => {
  const { url, apiKey } = req.body;
  if (!url) return res.status(400).json({ error: 'URL 필요' });

  const isInstagram = /instagram\.com\/(reel|p|tv)\//i.test(url);

  try {
    let info, thumbUrl;

    if (isInstagram) {
      info = await fetchInstagramInfo(url);
      thumbUrl = info.thumbnail;
    } else {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const r = await fetch(oembedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('영상을 찾을 수 없습니다. 유튜브 또는 인스타그램 주소인지 확인해주세요.');
      const d = await r.json();

      // 고해상도 썸네일 시도 (maxresdefault → oEmbed 기본값 폴백)
      thumbUrl = d.thumbnail_url || '';
      const vidIdMatch = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
      if (vidIdMatch) {
        const hq = `https://img.youtube.com/vi/${vidIdMatch[1]}/maxresdefault.jpg`;
        try {
          const tr = await fetch(hq, { method: 'HEAD' });
          if (tr.ok) thumbUrl = hq;
        } catch {}
      }
      info = { title: d.title, author: d.author_name, thumbnail: thumbUrl, platform: 'YouTube' };
    }

    // Gemini·Claude 키면 썸네일을 직접 보고, 아니면 제목·채널명으로 추정한다.
    try {
      let raw = null;
      if (thumbUrl) {
        const imgR = await fetch(thumbUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (imgR.ok) {
          const imgB64 = Buffer.from(await imgR.arrayBuffer()).toString('base64');
          const ct = imgR.headers.get('content-type') || 'image/jpeg';
          // 인스타는 캡션을 통째로 받아올 수 있다. 썸네일과 같이 주면
          // 말투와 후킹 방식까지 훨씬 정확하게 읽어낸다.
          const capPart = info.caption
            ? `\n\n이 게시물의 실제 캡션:\n"""${info.caption.slice(0, 700)}"""\n→ 캡션의 말투와 후킹 방식도 같이 읽어서 contentStrategy 에 반영해줘.`
            : '';
          raw = await callVision(apiKey, imgB64, ct,
`이 ${info.platform} 게시물의 대표 이미지를 분석해서 인스타그램 릴스 영상 제작에 활용할 스타일 가이드를 JSON으로 작성해주세요.${capPart}

JSON만 응답:
${STYLE_SCHEMA}`, 700);
        }
      }

      if (raw === null) {
        // 이미지를 못 보는 키. 글로 된 정보만으로 추정한다.
        // 인스타는 캡션이 있어 유튜브(제목뿐)보다 훨씬 나은 추정이 된다.
        raw = await callAI(apiKey,
`아래 ${info.platform} 게시물 정보를 보고 어떤 스타일일지 추정해서
인스타그램 릴스 제작용 스타일 가이드를 JSON으로 작성해주세요.

제목: ${info.title}
계정: ${info.author}${info.caption ? `\n캡션:\n"""${info.caption.slice(0, 700)}"""` : ''}

JSON만 응답:
${STYLE_SCHEMA}`, 1500);
        info.styleGuessed = true; // 대표 이미지를 직접 못 봤다는 표시
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
  const { prompt, seed, character } = req.query;
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });
  const s = seed || Math.floor(Math.random() * 99999);

  // 캐릭터를 올린 경우에는 그 캐릭터가 장면마다 나와야 한다.
  // 예전엔 negative 에 person·face·human 이 박혀 있어서, 캐릭터를 아무리
  // 설명해도 모델이 지워 버렸다. 캐릭터가 있으면 그 억제를 풀고 앞세운다.
  const char = (character || '').trim();
  const full = char
    ? `${char}, ${prompt}, the character is clearly visible in the scene, vertical composition 9:16, ultra detailed, cinematic, high quality, instagram reel`
    : `${prompt}, vertical composition 9:16, ultra detailed, cinematic, high quality, instagram reel`;

  const negative = char
    ? 'text, watermark, logo, blurry, ugly, distorted, extra limbs, deformed'
    : 'text, watermark, logo, blurry, ugly, distorted, person, face, human';

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}` +
    `?width=576&height=1024&nologo=true&seed=${s}&model=flux&negative=${encodeURIComponent(negative)}`;
  await proxyPollinationsImage(res, url, '릴스 이미지');
});

module.exports = router;
