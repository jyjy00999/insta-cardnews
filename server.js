// 인스타 스튜디오 — 카드뉴스 · 릴스 메이커 · 파이프라인 세 앱을 한 서버에 올린다.
//
// 세 앱은 원래 각각 다른 포트(3003/3004/3458)에서 돌았고 /api/generate-image,
// /api/suggest-topics 처럼 같은 경로를 서로 다른 구현으로 쓰고 있었다.
// 그래서 앱마다 경로 앞에 이름을 붙여 분리한다.
//   /api/cardnews/*  /api/reels/*  /api/pipeline/*

const express = require('express');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/cardnews', require('./routes/cardnews'));
app.use('/api/reels',    require('./routes/reels'));
app.use('/api/pipeline', require('./routes/pipeline'));

// ── PWA 아이콘 (SVG 를 PNG 경로로 서빙) ────────────────────────
function makeIconSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#7C3AED"/>
      <stop offset="100%" stop-color="#4F46E5"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${size*0.18}" fill="url(#bg)"/>
  <rect x="${size*0.21}" y="${size*0.16}" width="${size*0.58}" height="${size*0.68}" rx="${size*0.06}" fill="rgba(255,255,255,0.95)"/>
  <rect x="${size*0.31}" y="${size*0.27}" width="${size*0.38}" height="${size*0.045}" rx="${size*0.022}" fill="#7C3AED"/>
  <rect x="${size*0.31}" y="${size*0.37}" width="${size*0.27}" height="${size*0.045}" rx="${size*0.022}" fill="#D94500"/>
  <rect x="${size*0.31}" y="${size*0.47}" width="${size*0.34}" height="${size*0.04}" rx="${size*0.02}" fill="rgba(120,120,120,0.3)"/>
  <rect x="${size*0.31}" y="${size*0.56}" width="${size*0.28}" height="${size*0.04}" rx="${size*0.02}" fill="rgba(120,120,120,0.2)"/>
  <text x="${size*0.5}" y="${size*0.8}" font-size="${size*0.18}" text-anchor="middle">✨</text>
</svg>`;
}
for (const size of [192, 512]) {
  app.get(`/icon-${size}.png`, (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(makeIconSvg(size));
  });
}

// ── 접속 주소 안내 ─────────────────────────────────────────────
// 세 앱의 프런트가 저마다 다른 이름으로 부르던 걸 하나로 합쳤다.
function networkInfo() {
  if (process.env.RENDER_EXTERNAL_URL) {
    const url = process.env.RENDER_EXTERNAL_URL;
    return { ip: 'cloud', port: 443, url, localUrl: url, tunnelUrl: null, tunnelReady: false };
  }
  const nets = os.networkInterfaces();
  let ip = 'localhost';
  outer: for (const name of Object.keys(nets))
    for (const net of nets[name])
      if (net.family === 'IPv4' && !net.internal) { ip = net.address; break outer; }
  const port = PORT;
  const url = `http://${ip}:${port}`;
  return { ip, port, url, localUrl: url, tunnelUrl: null, tunnelReady: false };
}
app.get('/api/local-ip',     (req, res) => res.json(networkInfo()));
app.get('/api/network-info', (req, res) => res.json(networkInfo()));

const PORT = process.env.PORT || 3003;
app.listen(PORT, '0.0.0.0', () => {
  const { url } = networkInfo();
  if (process.env.PORT) {
    console.log(`\n✨ 인스타 스튜디오 실행 중 (포트 ${PORT})`);
  } else {
    console.log(`\n✨ 인스타 스튜디오 실행 중`);
    console.log(`   PC:     http://localhost:${PORT}`);
    console.log(`   모바일: ${url}`);
    console.log(`   (카드뉴스 · 릴스 · 파이프라인 — 탭으로 전환)\n`);
  }
});
