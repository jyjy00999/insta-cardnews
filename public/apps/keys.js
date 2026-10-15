/**
 * 세 앱(카드뉴스·릴스·파이프라인)이 함께 쓰는 API 키 보관소.
 *
 * 키를 여러 개 줄바꿈으로 넣어두면 서버가 위에서부터 쓰고,
 * 크레딧이 떨어지거나 한도에 걸리면 다음 키로 넘어간다.
 *
 * 세 앱은 같은 주소에서 iframe 으로 돌기 때문에 localStorage 를 공유한다.
 * 그래서 한 곳에서 저장하면 세 탭이 같은 키를 쓴다.
 */
(function (global) {
  'use strict';

  var STORAGE = 'studio_keys';
  // 합치기 전에 앱마다 따로 쓰던 자리. 처음 한 번만 끌어온다.
  var LEGACY = ['cn_apikey', 'reel_apikey', 'ig_apiKey'];

  var PROVIDERS = [
    { prefix: 'sk-ant-', id: 'anthropic', name: 'Claude',         paid: true,  color: '#D97757' },
    { prefix: 'AIza',    id: 'gemini',    name: 'Google Gemini',  paid: false, color: '#4285F4' },
    { prefix: 'gsk_',    id: 'groq',      name: 'Groq',           paid: false, color: '#16a34a' }
  ];

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /** 키 앞글자로 어느 서비스인지 가린다. 서버의 detectProvider 와 같은 규칙. */
  function detect(key) {
    if (!key) return { id: 'free', name: 'Pollinations', paid: false, color: '#64748b' };
    for (var i = 0; i < PROVIDERS.length; i++) {
      if (key.indexOf(PROVIDERS[i].prefix) === 0) return PROVIDERS[i];
    }
    return { id: 'unknown', name: '알 수 없는 형식', paid: false, color: '#dc2626' };
  }

  /** 입력란의 글을 키 목록으로 바꾼다. 공백·쉼표·줄바꿈 모두 구분자. */
  function parse(text) {
    var seen = {};
    return String(text || '').split(/[\s,]+/).map(function (s) {
      return s.trim();
    }).filter(function (k) {
      if (!k || seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /** 예전에 앱마다 따로 저장해 둔 키를 한곳으로 모은다. 한 번만 돈다. */
  function migrate() {
    if (read(STORAGE)) return;
    var found = [];
    for (var i = 0; i < LEGACY.length; i++) {
      var v = read(LEGACY[i]).trim();
      if (v && found.indexOf(v) < 0) found.push(v);
    }
    if (found.length) write(STORAGE, found.join('\n'));
  }

  var cached = null;

  var API = {
    /** 서버로 보낼 값. 줄바꿈으로 이어 붙인 키 목록. */
    get: function () {
      if (cached === null) { migrate(); cached = read(STORAGE); }
      return cached;
    },
    set: function (text) {
      cached = parse(text).join('\n');
      write(STORAGE, cached);
      return cached;
    },
    list: function () { return parse(API.get()); },
    count: function () { return API.list().length; },
    detect: detect,
    parse: parse,

    /**
     * 입력한 키들이 어떤 순서로 쓰일지 보여준다.
     * el 은 목록을 그릴 빈 요소.
     */
    renderList: function (el, text) {
      if (!el) return;
      var keys = parse(text);
      if (!keys.length) {
        el.innerHTML = '<div style="opacity:.65">키가 없으면 Pollinations(무료)로 동작합니다. ' +
                       '대본·스토리 생성은 키가 있어야 합니다.</div>';
        return;
      }
      var rows = keys.map(function (k, i) {
        var p = detect(k);
        var tail = k.length > 12 ? k.slice(0, 8) + '…' + k.slice(-4) : k;
        return '<div style="display:flex;align-items:center;gap:7px;padding:3px 0">' +
                 '<span style="opacity:.5;min-width:14px">' + (i + 1) + '</span>' +
                 '<span style="padding:1px 7px;border-radius:99px;font-weight:700;' +
                       'background:' + p.color + '22;color:' + p.color + '">' + p.name + '</span>' +
                 '<code style="opacity:.6;font-size:.92em">' + tail + '</code>' +
                 (p.paid ? '<span style="opacity:.55">유료</span>' : '') +
               '</div>';
      }).join('');
      el.innerHTML = rows +
        '<div style="margin-top:6px;opacity:.65">위에서부터 사용하고, 막히면 다음 키로 넘어갑니다. ' +
        '모두 안 되면 Pollinations(무료)를 씁니다.</div>';
    },

    /** 다른 탭에서 키를 바꾸면 이 앱에도 반영한다. */
    onChange: function (fn) {
      global.addEventListener('storage', function (e) {
        if (e.key === STORAGE) { cached = read(STORAGE); fn(cached); }
      });
    }
  };

  global.StudioKeys = API;

  /**
   * 이미지 받아오기 — 서버는 주소만 주고, 내려받기는 브라우저가 한다.
   *
   * 예전엔 서버가 Pollinations 에서 받아 다시 보내줬다. 같은 그림이 서버
   * 대역폭을 두 번 먹어서 무료 5GB 를 태우고 서비스가 멈췄다.
   * Pollinations 는 CORS 를 열어 두므로 브라우저가 바로 받으면 된다.
   *
   * @param apiPath  주소를 알려주는 서버 경로 (쿼리 포함)
   * @param opts.retries  무료 티어가 402 를 줄 때 다시 받을 횟수
   * @returns Blob
   */
  // Pollinations 가 출처를 가린다. 배포 주소(https)에서는 브라우저가 바로 받을 수
  // 있지만 localhost 에서는 403 이다. 한 번 막히면 그 뒤로는 바로 서버 중계로 간다.
  let directBlocked = false;

  global.fetchGeneratedImage = async function (apiPath, opts) {
    const { retries = 3, onRetry } = opts || {};
    const sep = apiPath.includes('?') ? '&' : '?';

    /** 서버가 대신 받아 준다. 대역폭을 쓰지만 확실하다. */
    async function viaProxy() {
      const pr = await fetch(apiPath + sep + 'proxy=1', { signal: AbortSignal.timeout(180000) });
      if (!pr.ok) {
        const msg = await pr.json().then(d => d.error).catch(() => null);
        throw new Error(msg || `이미지 생성 실패 (${pr.status})`);
      }
      const blob = await pr.blob();
      if (blob.size < 2000) throw new Error('빈 이미지');
      return blob;
    }

    if (directBlocked) return viaProxy();

    // 1) 주소만 받아 브라우저가 직접 내려받기 — 서버 대역폭을 안 쓴다
    const r = await fetch(apiPath);
    const info = await r.json().catch(() => ({}));
    if (!r.ok || !info.url) throw new Error(info.error || `이미지 주소 요청 실패 (${r.status})`);

    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // 매번 다른 seed 를 붙여야 Pollinations 가 실패한 결과를 캐시해 두고
        // 그대로 다시 주는 일이 없다.
        const u = attempt === 0 ? info.url : info.url.replace(/([?&]seed=)\d+/, `$1${Date.now() % 99999}`);
        const ir = await fetch(u, { signal: AbortSignal.timeout(120000) });
        if (ir.status === 403) { directBlocked = true; break; }   // 출처 차단 — 중계로
        if (!ir.ok) throw new Error(`HTTP ${ir.status}`);
        const blob = await ir.blob();
        if (blob.size < 2000) throw new Error('빈 이미지');
        return blob;
      } catch (e) {
        lastErr = e;
        // CORS 로 막히면 메시지 없이 TypeError 가 난다. 이것도 중계로 넘긴다.
        if (e && e.name === 'TypeError') { directBlocked = true; break; }
        if (attempt < retries - 1) {
          if (onRetry) onRetry(attempt + 1, e);
          // 무료 티어는 몰아치면 막는다. 쉬었다 다시 부르면 대개 풀린다.
          await new Promise(s => setTimeout(s, 4000 * (attempt + 1)));
        }
      }
    }

    // 2) 직접이 막혔으면 서버가 대신 받는다
    if (directBlocked) {
      console.info('[이미지] 직접 받기가 막혀 서버 중계로 전환합니다.');
      return viaProxy();
    }
    throw lastErr || new Error('이미지 생성 실패');
  };
})(window);
