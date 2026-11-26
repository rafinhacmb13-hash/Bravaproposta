

const EFFECTI_BASE = 'https://mdw.minha.effecti.com.br/api-integracao/v1';
const ALLOWED_PREFIXES = ['/aviso/'];
const UPSTREAM_TIMEOUT_MS = 15000;

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Proxy-Key, Authorization',
    'Access-Control-Expose-Headers': 'X-Effecti-Attempts, X-Effecti-Auth-Mode, X-Effecti-Reason',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBusinessRule403(status, bodyText) {
  if (status !== 403 || !bodyText) return false;
  const s = String(bodyText).toLowerCase();
  return /intervalo|entre as datas|permitido apenas|parametr|obrigat[oó]ri|data inicial|data final/.test(s);
}

function buildAuthVariants(rawToken) {
  const clean = String(rawToken || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!clean) return [];
  const hasBearer = /^Bearer\s+/i.test(clean);
  const withoutBearer = clean.replace(/^Bearer\s+/i, '').trim();
  const withBearer = `Bearer ${withoutBearer}`;
  return hasBearer
    ? [{ mode: 'as-is-bearer', value: clean }, { mode: 'raw-fallback', value: withoutBearer }]
    : [{ mode: 'as-is-raw', value: clean }, { mode: 'bearer-fallback', value: withBearer }];
}

async function fetchWithHeaders(targetUrl, method, authValue, bodyText) {
  const upstreamHeaders = new Headers();
  upstreamHeaders.set('Authorization', authValue);
  upstreamHeaders.set('Accept', 'application/json, text/plain, */*');
  upstreamHeaders.set('Accept-Language', 'pt-BR,pt;q=0.9,en;q=0.8');
  upstreamHeaders.set('Cache-Control', 'no-cache');
  upstreamHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  if (method !== 'GET' && method !== 'HEAD') {
    upstreamHeaders.set('Content-Type', 'application/json; charset=utf-8');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(targetUrl, {
      method,
      headers: upstreamHeaders,
      body: bodyText,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    const path = url.pathname || '/';

    if (path === '/' || path === '/health') {
      return new Response(JSON.stringify({
        ok: true,
        version: '2.2-resiliente',
        service: 'Effecti Proxy - Central de Licitacoes',
        target: EFFECTI_BASE,
        tokenConfigured: Boolean(env.EFFECTI_TOKEN && env.EFFECTI_TOKEN.trim()),
        pinProtected: Boolean(env.PROXY_PIN && env.PROXY_PIN.trim())
      }), {
        status: 200,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    if (env.PROXY_PIN && env.PROXY_PIN.trim()) {
      const sentPin = (request.headers.get('X-Proxy-Key') || '').trim();
      if (sentPin !== env.PROXY_PIN.trim()) {
        return new Response(JSON.stringify({ error: 'PIN de acesso inválido (X-Proxy-Key).' }), {
          status: 401,
          headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
        });
      }
    }

    const authVariants = buildAuthVariants(env.EFFECTI_TOKEN);
    if (!authVariants.length) {
      return new Response(JSON.stringify({
        error: 'Secret EFFECTI_TOKEN não configurada no Cloudflare Worker (Settings -> Variables and Secrets).'
      }), {
        status: 500,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const allowed = ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix));
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Rota não permitida pelo proxy: ' + path }), {
        status: 403,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    const targetUrl = `${EFFECTI_BASE}${path}${url.search || ''}`;

    try {
      const bodyText = (request.method === 'GET' || request.method === 'HEAD')
        ? undefined
        : await request.text();

      let lastRes = null;
      let lastBody = '';
      let usedMode = authVariants[0].mode;
      let attempts = 0;
      let reason = '';

      const plan = [
        { variant: authVariants[0], delay: 0 },
        { variant: authVariants[1] || authVariants[0], delay: 500 },
        { variant: authVariants[0], delay: 1100 }
      ];

      for (const step of plan) {
        if (step.delay > 0) await sleep(step.delay);
        attempts++;
        usedMode = step.variant.mode;
        const upstreamRes = await fetchWithHeaders(targetUrl, request.method, step.variant.value, bodyText);
        const resBody = await upstreamRes.text();
        lastRes = upstreamRes;
        lastBody = resBody;

        if (upstreamRes.ok || upstreamRes.status === 400 || upstreamRes.status === 404) {
          break;
        }
        if (isBusinessRule403(upstreamRes.status, resBody)) {
          reason = 'business-rule';
          break;
        }
        if (![401, 403, 429, 500, 502, 503, 504].includes(upstreamRes.status)) {
          break;
        }
      }

      const outHeaders = {
        ...headers,
        'Content-Type': (lastRes && lastRes.headers.get('Content-Type')) || 'application/json; charset=utf-8',
        'X-Effecti-Attempts': String(attempts),
        'X-Effecti-Auth-Mode': usedMode
      };
      if (reason) outHeaders['X-Effecti-Reason'] = reason;

      return new Response(lastBody, {
        status: lastRes ? lastRes.status : 502,
        headers: outHeaders
      });
    } catch (err) {
      const isTimeout = err && err.name === 'AbortError';
      return new Response(JSON.stringify({
        error: isTimeout
          ? 'Tempo limite excedido ao aguardar resposta da API Effecti.'
          : 'Falha ao conectar na Effecti: ' + String(err)
      }), {
        status: isTimeout ? 504 : 502,
        headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }
      });
    }
  }
};