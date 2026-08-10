const DASHBOARD_ORIGIN =
  "https://sergey-ai-dashboard.vercel.app";

const OPENAI_RESPONSES_URL =
  "https://api.openai.com/v1/responses";

const CHAT_MODEL =
  process.env.OPENAI_CHAT_MODEL ||
  "gpt-5.6-luna";

const MAX_QUESTION_LENGTH = 600;
const MAX_CONTEXT_LENGTH = 12000;
const RATE_LIMIT_REQUESTS = 12;
const RATE_LIMIT_WINDOW_SECONDS = 600;

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowedOrigin =
    origin === DASHBOARD_ORIGIN ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      origin || ""
    )
      ? origin
      : DASHBOARD_ORIGIN;

  res.setHeader(
    "Access-Control-Allow-Origin",
    allowedOrigin
  );
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

function isAllowedBrowserOrigin(req) {
  const origin = req.headers.origin;

  return origin === DASHBOARD_ORIGIN ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
      origin || ""
    );
}

function getClientIp(req) {
  const forwarded = String(
    req.headers["x-forwarded-for"] || ""
  )
    .split(",")[0]
    .trim();

  return forwarded ||
    req.socket?.remoteAddress ||
    "unknown";
}

async function runRedisCommand(command) {
  const redisUrl =
    process.env.UPSTASH_REDIS_REST_URL;
  const redisToken =
    process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return null;
  }

  const response = await fetch(redisUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${redisToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  if (!response.ok) {
    throw new Error(
      `Redis rate limit failed: ${response.status}`
    );
  }

  return response.json();
}

async function checkRateLimit(req) {
  const clientIp = getClientIp(req);
  const windowId = Math.floor(
    Date.now() /
      (RATE_LIMIT_WINDOW_SECONDS * 1000)
  );
  const key =
    `sergey-ai:chat-rate:${clientIp}:${windowId}`;

  try {
    const result = await runRedisCommand([
      "INCR",
      key
    ]);

    if (!result) {
      return { allowed: true };
    }

    const requestCount = Number(result.result) || 0;

    if (requestCount === 1) {
      await runRedisCommand([
        "EXPIRE",
        key,
        RATE_LIMIT_WINDOW_SECONDS
      ]);
    }

    return {
      allowed: requestCount <= RATE_LIMIT_REQUESTS,
      remaining: Math.max(
        0,
        RATE_LIMIT_REQUESTS - requestCount
      )
    };
  } catch (error) {
    console.error("Chat rate limit error:", error);
    return { allowed: true };
  }
}

function sanitizeContext(context) {
  if (!context || typeof context !== "object") {
    return {};
  }

  const serialized = JSON.stringify(context);

  if (serialized.length > MAX_CONTEXT_LENGTH) {
    throw new Error("Market context is too large");
  }

  return context;
}

function extractOutputText(responseData) {
  if (typeof responseData?.output_text === "string") {
    return responseData.output_text.trim();
  }

  const textParts = [];

  for (const item of responseData?.output || []) {
    if (item?.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (
        content?.type === "output_text" &&
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join("\n").trim();
}

export default async function handler(req, res) {
  setCorsHeaders(req, res);
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  if (!isAllowedBrowserOrigin(req)) {
    return res.status(403).json({
      ok: false,
      error: "Origin not allowed"
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      ok: false,
      error: "AI Chat is not configured"
    });
  }

  const question = String(
    req.body?.question || ""
  ).trim();

  if (!question) {
    return res.status(400).json({
      ok: false,
      error: "Question is required"
    });
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return res.status(400).json({
      ok: false,
      error: `Question must be ${MAX_QUESTION_LENGTH} characters or less`
    });
  }

  const rateLimit = await checkRateLimit(req);

  if (!rateLimit.allowed) {
    return res.status(429).json({
      ok: false,
      error: "Слишком много вопросов. Повторите через несколько минут."
    });
  }

  let marketContext;

  try {
    marketContext = sanitizeContext(
      req.body?.context
    );
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message
    });
  }

  try {
    const openAiResponse = await fetch(
      OPENAI_RESPONSES_URL,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          instructions: [
            "Ты AI-ассистент платформы Sergey AI Trader PRO.",
            "Отвечай на русском языке кратко и понятно.",
            "Ответ должен занимать не более 6 коротких абзацев и примерно 110 слов.",
            "Структура ответа: короткий вывод; максимум 3 главные причины; одна строка с Direction, Action, Confidence, Score и Readiness; одна строка с Entry Zone, Stop Loss, Take Profit и Risk/Reward, только если эти данные есть.",
            "Не повторяй одни и те же показатели и не перечисляй больше 3 причин.",
            "Предупреждение о риске сократи до одной короткой фразы.",
            "Используй только MARKET_CONTEXT из сообщения пользователя.",
            "Не придумывай цены, индикаторы, новости или причины, которых нет в контексте.",
            "Всегда различай рыночный анализ и финансовый совет.",
            "Не гарантируй прибыль и не обещай точность.",
            "Если спрашивают покупать или продавать, объясни текущий Direction, Action, Confidence, Score и Readiness, затем предложи проверить Entry Zone, Stop Loss, Take Profit и Risk/Reward.",
            "Если данных недостаточно, прямо скажи об этом."
          ].join(" "),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: [
                    `ВОПРОС: ${question}`,
                    "MARKET_CONTEXT:",
                    JSON.stringify(marketContext)
                  ].join("\n")
                }
              ]
            }
          ],
          max_output_tokens: 400,
          text: {
            verbosity: "low"
          }
        })
      }
    );

    const responseData = await openAiResponse.json();

    if (!openAiResponse.ok) {
      console.error(
        "OpenAI Responses API error:",
        openAiResponse.status,
        responseData?.error?.message ||
          responseData?.error ||
          "Unknown error"
      );

      return res.status(502).json({
        ok: false,
        error: "AI service is temporarily unavailable"
      });
    }

    const answer = extractOutputText(responseData);

    if (!answer) {
      return res.status(502).json({
        ok: false,
        error: "AI returned an empty response"
      });
    }

    return res.status(200).json({
      ok: true,
      answer,
      model: CHAT_MODEL,
      remaining: rateLimit.remaining
    });
  } catch (error) {
    console.error("AI Chat Error:", error);

    return res.status(500).json({
      ok: false,
      error: "AI Chat request failed"
    });
  }
}
