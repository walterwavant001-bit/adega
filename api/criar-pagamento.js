// Cria uma cobrança no Mercado Pago com o total conferido no catálogo.
// O Access Token NUNCA vai para o site: ele fica só no servidor, na variável MP_ACCESS_TOKEN.
const crypto = require("crypto");

const CATALOGO_URL =
  "https://raw.githubusercontent.com/walterwavant001-bit/adega/main/dados/catalogo.json";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });

  try {
    const pedido = req.body && req.body.itens;
    if (!Array.isArray(pedido) || pedido.length === 0) {
      return res.status(400).json({ erro: "Carrinho vazio." });
    }

    // 1) Lê o catálogo oficial (preços vêm daqui, nunca do navegador)
    const catResp = await fetch(CATALOGO_URL, { cache: "no-store" });
    if (!catResp.ok) return res.status(502).json({ erro: "Não consegui ler o catálogo." });
    const catalogo = (await catResp.json()).itens || [];
    const porOrdem = new Map(catalogo.map((i) => [String(i.ordem), i]));

    // 2) Confere cada item e soma em centavos (evita erro de arredondamento)
    const itens = [];
    let totalCentavos = 0;
    for (const linha of pedido) {
      const produto = porOrdem.get(String(linha.ordem));
      if (!produto) return res.status(400).json({ erro: "Produto não encontrado." });
      if (produto.preco === null || produto.preco === undefined) {
        return res.status(400).json({ erro: produto.nome + " está sem preço." });
      }
      if (produto.preco_status) {
        return res.status(400).json({ erro: produto.nome + " ainda não está liberado para venda." });
      }
      const qtd = Number(linha.quantidade);
      if (!Number.isInteger(qtd) || qtd < 1 || qtd > 99) {
        return res.status(400).json({ erro: "Quantidade inválida para " + produto.nome + "." });
      }
      const centavosUnit = Math.round(Number(produto.preco) * 100);
      itens.push({
        title: produto.nome,
        quantity: qtd,
        unit_price: (centavosUnit / 100).toFixed(2),
      });
      totalCentavos += centavosUnit * qtd;
    }

    // 3) Cria a cobrança no Mercado Pago (Checkout Pro, API de Orders)
    const corpo = {
      type: "online",
      processing_mode: "manual",
      total_amount: (totalCentavos / 100).toFixed(2),
      external_reference: "adega-" + Date.now(),
      items: itens,
    };
    const mp = await fetch("https://api.mercadopago.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.MP_ACCESS_TOKEN,
        "Content-Type": "application/json",
        "X-Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(corpo),
    });
    const dados = await mp.json();
    if (!mp.ok || !dados.checkout_url) {
      console.error("Mercado Pago recusou:", JSON.stringify(dados));
      return res.status(502).json({ erro: "O pagamento não pôde ser criado. Tente de novo." });
    }

    // 4) Devolve o link para o site abrir
    return res.status(200).json({ checkout_url: dados.checkout_url, id: dados.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro interno." });
  }
};
