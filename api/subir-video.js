// Recebe um vídeo curto do dono e guarda no Vercel Blob.
// Só o dono (login Google com e-mail confirmado) envia. Limite: 4 MB por vídeo.
const { put } = require("@vercel/blob");

const API_KEY = "AIzaSyBVf9nCK92Qslqy-cgskTeqEUXRBeleKQs"; // chave pública do Firebase, não é segredo
const DONO_EMAIL = "walterwavant001@gmail.com";
const LIMITE = 4.4 * 1024 * 1024;
const TIPOS = { "video/mp4": true, "video/webm": true, "video/quicktime": true };

async function quemEnviou(token) {
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + API_KEY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: token }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const u = j.users && j.users[0];
  return u && u.email === DONO_EMAIL && u.emailVerified === true ? u : null;
}

function lerCorpo(req) {
  return new Promise((ok, falha) => {
    const partes = [];
    let total = 0;
    req.on("data", (pedaco) => {
      total += pedaco.length;
      if (total > LIMITE) {
        falha(new Error("grande"));
        req.destroy();
        return;
      }
      partes.push(pedaco);
    });
    req.on("end", () => ok(Buffer.concat(partes)));
    req.on("error", falha);
  });
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
  const cab = req.headers.authorization || "";
  const token = cab.startsWith("Bearer ") ? cab.slice(7) : "";
  if (!token) return res.status(401).json({ erro: "Entre como dono para enviar." });
  try {
    const dono = await quemEnviou(token);
    if (!dono) return res.status(403).json({ erro: "Só o dono pode enviar vídeos." });

    const tipo = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (!TIPOS[tipo]) return res.status(415).json({ erro: "Formato não aceito. Use MP4." });

    const nomeBruto = new URL(req.url, "https://site.local").searchParams.get("nome") || "video";
    const nome = nomeBruto.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "video";

    const corpo = await lerCorpo(req);
    const arquivo = await put("shorts/" + nome, corpo, {
      access: "public",
      contentType: tipo,
      addRandomSuffix: true,
    });
    return res.status(200).json({ url: arquivo.url, pathname: arquivo.pathname });
  } catch (e) {
    if (e && e.message === "grande") {
      return res.status(413).json({ erro: "Vídeo maior que 4 MB. Diminua o vídeo e tente de novo." });
    }
    console.error(e);
    return res.status(500).json({ erro: "Não consegui guardar o vídeo." });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;
