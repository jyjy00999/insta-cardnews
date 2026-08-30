// 아이콘 PNG 생성 스크립트 (node generate-icons.js 로 실행)
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function drawIcon(size) {
  const cv = createCanvas(size, size);
  const ctx = cv.getContext('2d');
  const r = size * 0.18;

  // 배경 (보라색 그라디언트)
  const grad = ctx.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#7C3AED');
  grad.addColorStop(1, '#4F46E5');
  ctx.fillStyle = grad;
  // 둥근 모서리
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.lineTo(size-r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size-r);
  ctx.quadraticCurveTo(size, size, size-r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size-r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // 카드 모양 (흰색)
  const pad = size * 0.18;
  const cw = size * 0.58, ch = size * 0.68;
  const cx = (size - cw) / 2, cy = (size - ch) / 2;
  const cr = size * 0.06;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(cx+cr, cy); ctx.lineTo(cx+cw-cr, cy);
  ctx.quadraticCurveTo(cx+cw, cy, cx+cw, cy+cr);
  ctx.lineTo(cx+cw, cy+ch-cr);
  ctx.quadraticCurveTo(cx+cw, cy+ch, cx+cw-cr, cy+ch);
  ctx.lineTo(cx+cr, cy+ch);
  ctx.quadraticCurveTo(cx, cy+ch, cx, cy+ch-cr);
  ctx.lineTo(cx, cy+cr);
  ctx.quadraticCurveTo(cx, cy, cx+cr, cy);
  ctx.closePath();
  ctx.fill();

  // 줄 (내용 표현)
  const lx = cx + size*0.1, lw = cw - size*0.2;
  const lh = size * 0.045, lg = size * 0.07;
  const colors = ['#7C3AED','#D94500','#6D28D9'];
  [0,1,2,3].forEach((i) => {
    ctx.fillStyle = i===0 ? '#7C3AED' : (i===1 ? '#D94500' : 'rgba(100,100,100,0.25)');
    const w = i===0 ? lw : (i===1 ? lw*0.7 : lw*(0.9-i*0.1));
    const y = cy + size*0.12 + i*(lh+lg);
    ctx.beginPath();
    ctx.roundRect(lx, y, w, lh, lh/2);
    ctx.fill();
  });

  // 별 이모지
  ctx.font = `${size*0.18}px serif`;
  ctx.textAlign = 'center';
  ctx.fillText('✨', size/2, cy+ch - size*0.08);

  return cv.toBuffer('image/png');
}

try {
  const buf192 = drawIcon(192);
  const buf512 = drawIcon(512);
  fs.writeFileSync(path.join(__dirname,'public','icon-192.png'), buf192);
  fs.writeFileSync(path.join(__dirname,'public','icon-512.png'), buf512);
  console.log('✅ 아이콘 생성 완료: icon-192.png, icon-512.png');
} catch(e) {
  console.log('canvas 모듈 없음, SVG 폴백 사용');
}
