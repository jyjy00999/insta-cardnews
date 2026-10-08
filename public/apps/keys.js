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
})(window);
