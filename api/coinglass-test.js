export default async function handler(req, res) {
  try {
    const apiKey = process.env.COINGLASS_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "COINGLASS_API_KEY not found"
      });
    }

    const response = await fetch(
      "https://open-api-v4.coinglass.com/api/futures/supported-coins",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "CG-API-KEY": apiKey
        }
      }
    );

    const data = await response.json();

    return res.status(response.status).json({
      ok: response.ok,
      status: response.status,
      data
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
}
