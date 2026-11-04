// Cria a cobrança do cartão no Mercado Pago (Checkout Pro, API de Orders).
// Os preços são lidos do Firestore (coleção "itens", leitura pública), nunca do navegador.
// O Access Token fica só no servidor, na variável MP_ACCESS_TOKEN.
const crypto = require("crypto");

const PROJETO = "adega-do-wavant";
const ITENS_URL =
  "https://firestore.googleapis.com/v1/projects/" + PROJETO + "/databases/(default)/documents/itens";

// Taxa de entrega: deve bater com a tabela do site (TAXA)
const TAXA = { mesa: 1, domicilio: 7, rua: 5, caixa: 0 };

function valor(campo) {
  if (!campo) return undefined;
  if ("nullValue" in campo) return null;
  if ("stringValue" in campo) return campo.stringValue;
  if ("integerValue" in campo) return Number(campo.integerValue);
  if ("doubleValue" in campo) return campo.doubleValue;
  if ("booleanValue" in campo) return campo.booleanValue;
  return undefined;
}

async function lerItens() {
  const todos = new Map();
  let token = "";
  do {
    const url = ITENS_URL + "?pageSize=300" + (token ? "&pageToken=" + encodeURIComponent(token) : "");
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("Firestore respondeu " + r.status);
    const j = await r.json();
    (j.documents || []).forEach((d) => {
      const id = d.name.split("/").pop();
      const f = d.fields || {};
      todos.set(id, {
        id: id,
        nome: valor(f.nome) || id,
        preco: valor(f.preco),
        esgotado: valor(f.esgotado) === true,
        preco_status: valor(f.preco_status) || null,
      });
    });
    token = j.nextPageToken || "";
  } while (token);
  return todos;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });

  try {
    const pedido = req.body && req.body.itens;
    const entrega = req.body && req.body.entrega;
    const codigo = String((req.body && req.body.codigo) || Date.now()).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);

    if (!Array.isArray(pedido) || pedido.length === 0) {
      return res.status(400).json({ erro: "Carrinho vazio." });
    }
    if (!Object.prototype.hasOwnProperty.call(TAXA, entrega)) {
      return res.status(400).json({ erro: "Escolha como quer receber o pedido." });
    }

    const catalogo = await lerItens();
    const itens = [];
    let totalCentavos = 0;

    for (const linha of pedido) {
      const produto = catalogo.get(String(linha.id));
      if (!produto) return res.status(400).json({ erro: "Produto não encontrado." });
      if (produto.esgotado) return res.status(400).json({ erro: produto.nome + " está esgotado." });
      if (produto.preco === null || produto.preco === undefined) {
        return res.status(400).json({ erro: produto.nome + " está sem preço." });
      }
      if (produto.preco_status) {
        return res.status(400).json({ erro: produto.nome + " ainda não está liberado para venda." });
      }
      const qtd = Number(linha.qtd);
      if (!Number.isInteger(qtd) || qtd < 1 || qtd > 99) {
        return res.status(400).json({ erro: "Quantidade inválida para " + produto.nome + "." });
      }
      const centavosUnit = Math.round(Number(produto.preco) * 100);
      itens.push({ title: produto.nome, quantity: qtd, unit_price: (centavosUnit / 100).toFixed(2) });
      totalCentavos += centavosUnit * qtd;
    }

    const taxaCentavos = Math.round(TAXA[entrega] * 100);
    if (taxaCentavos > 0) {
      itens.push({ title: "Taxa de entrega", quantity: 1, unit_price: (taxaCentavos / 100).toFixed(2) });
      totalCentavos += taxaCentavos;
    }

    const corpo = {
      type: "online",
      processing_mode: "manual",
      total_amount: (totalCentavos / 100).toFixed(2),
      external_reference: "adega-" + codigo,
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
    return res.status(200).json({ checkout_url: dados.checkout_url, id: dados.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: "Erro interno." });
  }
};
